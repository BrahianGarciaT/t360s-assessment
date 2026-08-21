import { ReservationReaperService } from './reservation-reaper.service';
import { InventoryRepository } from './inventory.repository';
import { Reservation, ReservationStatus } from './entities/reservation.entity';

describe('ReservationReaperService', () => {
  let service: ReservationReaperService;
  let repository: jest.Mocked<
    Pick<InventoryRepository, 'claimExpired' | 'finalize'>
  >;
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
      finalize: jest.fn(),
    };
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    service = new ReservationReaperService(
      repository as unknown as InventoryRepository,
      logger as never,
    );
  });

  it('releases every HELD reservation past expiresAt returned by claimExpired, tagged as expired', async () => {
    const due = [
      buildReservation({ orderId: 'order-1' }),
      buildReservation({ orderId: 'order-2' }),
    ];
    repository.claimExpired.mockResolvedValue(due);
    repository.finalize.mockResolvedValue(
      buildReservation({ status: ReservationStatus.RELEASED }),
    );

    await service.reap();

    expect(repository.claimExpired).toHaveBeenCalledWith(100);
    expect(repository.finalize).toHaveBeenCalledTimes(2);
    expect(repository.finalize).toHaveBeenNthCalledWith(
      1,
      'order-1',
      'release',
      'expired',
    );
    expect(repository.finalize).toHaveBeenNthCalledWith(
      2,
      'order-2',
      'release',
      'expired',
    );
  });

  it('does nothing (no finalize calls) when claimExpired finds no due reservations (triangulation)', async () => {
    repository.claimExpired.mockResolvedValue([]);

    await service.reap();

    expect(repository.finalize).not.toHaveBeenCalled();
  });
});
