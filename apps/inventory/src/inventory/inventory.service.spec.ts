import { Test, TestingModule } from '@nestjs/testing';
import { getLoggerToken } from 'nestjs-pino';
import { InventoryService } from './inventory.service';
import {
  InventoryRepository,
  ReservationRejectedError,
} from './inventory.repository';
import { Reservation, ReservationStatus } from './entities/reservation.entity';

describe('InventoryService', () => {
  let service: InventoryService;
  let repository: jest.Mocked<
    Pick<InventoryRepository, 'reserve' | 'finalize' | 'findByOrderId'>
  >;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: InventoryRepository, useValue: repository },
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
      });

      expect(result).toEqual({
        ok: true,
        orderId: 'order-1',
        expiresAt: reservation.expiresAt.toISOString(),
      });
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
      });

      expect(repository.findByOrderId).toHaveBeenCalledWith('order-1');
      expect(result).toEqual({
        ok: true,
        orderId: 'order-1',
        expiresAt: existing.expiresAt.toISOString(),
      });
    });

    it('rethrows the original duplicate-key error if the existing reservation cannot be found (race condition)', async () => {
      const duplicateKeyError = Object.assign(new Error('duplicate key'), {
        code: '23505',
      });
      repository.reserve.mockRejectedValue(duplicateKeyError);
      repository.findByOrderId.mockResolvedValue(null);

      await expect(
        service.reserve({ orderId: 'order-1', items: [] }),
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
      });

      expect(result).toEqual({
        ok: false,
        reason: 'INSUFFICIENT_STOCK',
        shortfalls: [{ productId: 'p1', requested: 5, available: 2 }],
      });
    });
  });

  describe('commit', () => {
    it('acks ok:true after finalizing a held reservation', async () => {
      repository.finalize.mockResolvedValue(
        buildReservation({ status: ReservationStatus.COMMITTED }),
      );

      const result = await service.commit('order-1');

      expect(repository.finalize).toHaveBeenCalledWith('order-1', 'commit');
      expect(result).toEqual({ ok: true, orderId: 'order-1' });
    });

    it('is a no-op ack when the reservation is already in a terminal state (idempotent redelivery)', async () => {
      repository.finalize.mockResolvedValue(
        buildReservation({ status: ReservationStatus.COMMITTED }),
      );

      const result = await service.commit('order-1');

      expect(result).toEqual({ ok: true, orderId: 'order-1' });
    });

    it('is a no-op ack when no reservation exists for the orderId (unknown reservation)', async () => {
      repository.finalize.mockResolvedValue(null);

      const result = await service.commit('order-1');

      expect(result).toEqual({ ok: true, orderId: 'order-1' });
    });
  });

  describe('release', () => {
    it('acks ok:true after releasing a held reservation with the given reason', async () => {
      repository.finalize.mockResolvedValue(
        buildReservation({ status: ReservationStatus.RELEASED }),
      );

      const result = await service.release('order-1', 'cancelled');

      expect(repository.finalize).toHaveBeenCalledWith(
        'order-1',
        'release',
        'cancelled',
      );
      expect(result).toEqual({ ok: true, orderId: 'order-1' });
    });

    it('is a no-op ack when the reservation is already released (idempotent redelivery)', async () => {
      repository.finalize.mockResolvedValue(
        buildReservation({ status: ReservationStatus.RELEASED }),
      );

      const result = await service.release('order-1', 'expired');

      expect(result).toEqual({ ok: true, orderId: 'order-1' });
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
