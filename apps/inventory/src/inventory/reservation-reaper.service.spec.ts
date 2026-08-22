import { ReservationReaperService } from './reservation-reaper.service';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { Reservation, ReservationStatus } from './entities/reservation.entity';

describe('ReservationReaperService', () => {
  let service: ReservationReaperService;
  let repository: jest.Mocked<Pick<InventoryRepository, 'claimExpired'>>;
  let inventoryService: jest.Mocked<Pick<InventoryService, 'release'>>;
  let logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };

  const buildReservation = (
    overrides: Partial<Reservation> = {},
  ): Reservation =>
    ({
      orderId: 'order-1',
      items: [{ productId: 'p1', quantity: 2 }],
      status: ReservationStatus.HELD,
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      releasedReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as Reservation;

  beforeEach(() => {
    repository = {
      claimExpired: jest.fn(),
    };
    inventoryService = {
      release: jest.fn(),
    };
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    service = new ReservationReaperService(
      repository as unknown as InventoryRepository,
      inventoryService as unknown as InventoryService,
      logger as never,
    );
  });

  it('releases every HELD reservation past expiresAt returned by claimExpired, tagged as expired', async () => {
    const due = [
      buildReservation({ orderId: 'order-1' }),
      buildReservation({ orderId: 'order-2' }),
    ];
    repository.claimExpired.mockResolvedValue(due);
    inventoryService.release.mockResolvedValue({
      ok: true,
      orderId: 'order-1',
    });

    await service.reap();

    expect(repository.claimExpired).toHaveBeenCalledWith(100);
    expect(inventoryService.release).toHaveBeenCalledTimes(2);
    // El reaper es un disparador interno de @Cron, no un evento reentregado
    // del outbox, así que sintetiza su propio eventId (`internal:reaper:{orderId}`)
    // para cumplir el contrato de deduplicación por eventId de release().
    // Ahora pasa por InventoryService.release() (no por
    // InventoryRepository.finalize() directo) para que el release por TTL
    // quede auditado hacia audit igual que cualquier otro release.
    expect(inventoryService.release).toHaveBeenNthCalledWith(
      1,
      'order-1',
      'internal:reaper:order-1',
      'expired',
    );
    expect(inventoryService.release).toHaveBeenNthCalledWith(
      2,
      'order-2',
      'internal:reaper:order-2',
      'expired',
    );
  });

  it('does nothing (no release calls) when claimExpired finds no due reservations (triangulation)', async () => {
    repository.claimExpired.mockResolvedValue([]);

    await service.reap();

    expect(inventoryService.release).not.toHaveBeenCalled();
  });

  it('does not abort the batch when release throws for one expired reservation (isolates per-item failures)', async () => {
    const due = [
      buildReservation({ orderId: 'order-1' }),
      buildReservation({ orderId: 'order-2' }),
    ];
    repository.claimExpired.mockResolvedValue(due);
    inventoryService.release
      .mockRejectedValueOnce(new Error('constraint violation'))
      .mockResolvedValueOnce({ ok: true, orderId: 'order-2' });

    await expect(service.reap()).resolves.not.toThrow();

    expect(inventoryService.release).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1' }),
      expect.any(String),
    );
  });
});
