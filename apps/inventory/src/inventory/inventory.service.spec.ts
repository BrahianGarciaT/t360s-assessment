import { Test, TestingModule } from '@nestjs/testing';
import { getLoggerToken } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { INVENTORY_AUDIT_EVENTS } from '@app/shared';
import { InventoryService } from './inventory.service';
import {
  InventoryRepository,
  ReservationRejectedError,
} from './inventory.repository';
import { Reservation, ReservationStatus } from './entities/reservation.entity';
import { AUDIT_TCP_CLIENT } from './inventory.constants';

describe('InventoryService', () => {
  let service: InventoryService;
  let repository: jest.Mocked<
    Pick<InventoryRepository, 'reserve' | 'finalize' | 'findByOrderId'>
  >;
  let auditClient: { emit: jest.Mock };

  const buildReservation = (
    overrides: Partial<Reservation> = {},
  ): Reservation =>
    ({
      orderId: 'order-1',
      items: [{ productId: 'p1', quantity: 2 }],
      status: ReservationStatus.HELD,
      expiresAt: new Date('2026-01-01T00:15:00.000Z'),
      releasedReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as Reservation;

  beforeEach(async () => {
    repository = {
      reserve: jest.fn(),
      finalize: jest.fn(),
      findByOrderId: jest.fn(),
    };
    auditClient = {
      emit: jest.fn().mockReturnValue({ subscribe: jest.fn() }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: InventoryRepository, useValue: repository },
        { provide: AUDIT_TCP_CLIENT, useValue: auditClient },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-api-key') },
        },
        {
          provide: getLoggerToken(InventoryService.name),
          useValue: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
  });

  describe('reserve', () => {
    it('returns ok:true with the reservation orderId/expiresAt on first delivery', async () => {
      const reservation = buildReservation();
      repository.reserve.mockResolvedValue(reservation);

      const result = await service.reserve({
        orderId: 'order-1',
        items: [{ productId: 'p1', quantity: 2 }],
        apiKey: 'test-api-key',
      });

      expect(result).toEqual({
        ok: true,
        orderId: 'order-1',
        expiresAt: reservation.expiresAt.toISOString(),
      });
    });

    it('emits an inventory.reserved audit event on first delivery (triangulation)', async () => {
      const reservation = buildReservation();
      repository.reserve.mockResolvedValue(reservation);

      await service.reserve({
        orderId: 'order-1',
        items: [{ productId: 'p1', quantity: 2 }],
        apiKey: 'test-api-key',
      });

      expect(auditClient.emit).toHaveBeenCalledWith(
        INVENTORY_AUDIT_EVENTS.RESERVED,
        expect.objectContaining({ orderId: 'order-1' }),
      );
    });

    it('is a no-op dedup (not an error) when orderId already exists (23505 unique violation)', async () => {
      const duplicateKeyError = Object.assign(new Error('duplicate key'), {
        code: '23505',
      });
      repository.reserve.mockRejectedValue(duplicateKeyError);
      const existing = buildReservation();
      repository.findByOrderId.mockResolvedValue(existing);

      const result = await service.reserve({
        orderId: 'order-1',
        items: [{ productId: 'p1', quantity: 2 }],
        apiKey: 'test-api-key',
      });

      expect(repository.findByOrderId).toHaveBeenCalledWith('order-1');
      expect(result).toEqual({
        ok: true,
        orderId: 'order-1',
        expiresAt: existing.expiresAt.toISOString(),
      });
    });

    it('does not emit an audit event on the duplicate (23505) path — avoids double-auditing a retried reservation', async () => {
      const duplicateKeyError = Object.assign(new Error('duplicate key'), {
        code: '23505',
      });
      repository.reserve.mockRejectedValue(duplicateKeyError);
      repository.findByOrderId.mockResolvedValue(buildReservation());

      await service.reserve({
        orderId: 'order-1',
        items: [{ productId: 'p1', quantity: 2 }],
        apiKey: 'test-api-key',
      });

      expect(auditClient.emit).not.toHaveBeenCalled();
    });

    it('rethrows the original duplicate-key error if the existing reservation cannot be found (race condition)', async () => {
      const duplicateKeyError = Object.assign(new Error('duplicate key'), {
        code: '23505',
      });
      repository.reserve.mockRejectedValue(duplicateKeyError);
      repository.findByOrderId.mockResolvedValue(null);

      await expect(
        service.reserve({
          orderId: 'order-1',
          items: [],
          apiKey: 'test-api-key',
        }),
      ).rejects.toThrow('duplicate key');
    });

    it('returns ok:false with reason UNKNOWN_PRODUCT when the productId does not exist', async () => {
      repository.reserve.mockRejectedValue(
        new ReservationRejectedError('UNKNOWN_PRODUCT', [
          { productId: 'ghost', requested: 1, available: 0 },
        ]),
      );

      const result = await service.reserve({
        orderId: 'order-1',
        items: [{ productId: 'ghost', quantity: 1 }],
        apiKey: 'test-api-key',
      });

      expect(result).toEqual({
        ok: false,
        reason: 'UNKNOWN_PRODUCT',
        shortfalls: [{ productId: 'ghost', requested: 1, available: 0 }],
      });
    });

    it('returns ok:false with reason INSUFFICIENT_STOCK when stock falls short (triangulation)', async () => {
      repository.reserve.mockRejectedValue(
        new ReservationRejectedError('INSUFFICIENT_STOCK', [
          { productId: 'p1', requested: 5, available: 2 },
        ]),
      );

      const result = await service.reserve({
        orderId: 'order-1',
        items: [{ productId: 'p1', quantity: 5 }],
        apiKey: 'test-api-key',
      });

      expect(result).toEqual({
        ok: false,
        reason: 'INSUFFICIENT_STOCK',
        shortfalls: [{ productId: 'p1', requested: 5, available: 2 }],
      });
    });
  });

  describe('commit', () => {
    it('acks ok:true after finalizing a held reservation, forwarding the eventId for dedup', async () => {
      repository.finalize.mockResolvedValue(
        buildReservation({
          status: ReservationStatus.COMMITTED,
          processedEventId: 'event-abc',
        }),
      );

      const result = await service.commit('order-1', 'event-abc');

      expect(repository.finalize).toHaveBeenCalledWith(
        'order-1',
        'commit',
        'event-abc',
      );
      expect(result).toEqual({ ok: true, orderId: 'order-1' });
    });

    it('emits an inventory.committed audit event when a reservation was found (triangulation)', async () => {
      repository.finalize.mockResolvedValue(
        buildReservation({
          status: ReservationStatus.COMMITTED,
          processedEventId: 'event-abc',
        }),
      );

      await service.commit('order-1', 'event-abc');

      expect(auditClient.emit).toHaveBeenCalledWith(
        INVENTORY_AUDIT_EVENTS.COMMITTED,
        expect.objectContaining({ orderId: 'order-1' }),
      );
    });

    it('is a no-op ack when the redelivered eventId was already processed (idempotent redelivery, triangulation)', async () => {
      repository.finalize.mockResolvedValue(
        buildReservation({
          status: ReservationStatus.COMMITTED,
          processedEventId: 'event-abc',
        }),
      );

      const result = await service.commit('order-1', 'event-abc');

      expect(repository.finalize).toHaveBeenCalledWith(
        'order-1',
        'commit',
        'event-abc',
      );
      expect(result).toEqual({ ok: true, orderId: 'order-1' });
    });

    it('is a no-op ack when no reservation exists for the orderId (unknown reservation)', async () => {
      repository.finalize.mockResolvedValue(null);

      const result = await service.commit('order-1', 'event-abc');

      expect(result).toEqual({ ok: true, orderId: 'order-1' });
    });

    it('does not emit an audit event when no reservation was found (no-op)', async () => {
      repository.finalize.mockResolvedValue(null);

      await service.commit('order-1', 'event-abc');

      expect(auditClient.emit).not.toHaveBeenCalled();
    });
  });

  describe('release', () => {
    it('acks ok:true after releasing a held reservation with the given reason and eventId', async () => {
      repository.finalize.mockResolvedValue(
        buildReservation({
          status: ReservationStatus.RELEASED,
          processedEventId: 'event-xyz',
        }),
      );

      const result = await service.release('order-1', 'event-xyz', 'cancelled');

      expect(repository.finalize).toHaveBeenCalledWith(
        'order-1',
        'release',
        'event-xyz',
        'cancelled',
      );
      expect(result).toEqual({ ok: true, orderId: 'order-1' });
    });

    it('emits an inventory.released audit event when a reservation was found (triangulation)', async () => {
      repository.finalize.mockResolvedValue(
        buildReservation({
          status: ReservationStatus.RELEASED,
          processedEventId: 'event-xyz',
        }),
      );

      await service.release('order-1', 'event-xyz', 'cancelled');

      expect(auditClient.emit).toHaveBeenCalledWith(
        INVENTORY_AUDIT_EVENTS.RELEASED,
        expect.objectContaining({ orderId: 'order-1' }),
      );
    });

    it('is a no-op ack when the reservation is already released under this eventId (idempotent redelivery)', async () => {
      repository.finalize.mockResolvedValue(
        buildReservation({
          status: ReservationStatus.RELEASED,
          processedEventId: 'event-expired-1',
        }),
      );

      const result = await service.release(
        'order-1',
        'event-expired-1',
        'expired',
      );

      expect(result).toEqual({ ok: true, orderId: 'order-1' });
    });

    it('does not emit an audit event when no reservation was found (no-op)', async () => {
      repository.finalize.mockResolvedValue(null);

      await service.release('order-1', 'event-xyz', 'cancelled');

      expect(auditClient.emit).not.toHaveBeenCalled();
    });
  });

  describe('setStock / getStockLevel', () => {
    it('delegates the seed upsert to the repository and returns its result', async () => {
      const stock = { productId: 'p1', quantity: 10, reserved: 0 };
      (repository as unknown as { upsertStock: jest.Mock }).upsertStock = jest
        .fn()
        .mockResolvedValue(stock);

      const result = await service.setStock('p1', 10);

      expect(
        (repository as unknown as { upsertStock: jest.Mock }).upsertStock,
      ).toHaveBeenCalledWith('p1', 10);
      expect(result).toBe(stock);
    });

    it('delegates the read to the repository and returns null for an unknown productId (triangulation)', async () => {
      (repository as unknown as { getStock: jest.Mock }).getStock = jest
        .fn()
        .mockResolvedValue(null);

      const result = await service.getStockLevel('ghost');

      expect(result).toBeNull();
    });
  });
});
