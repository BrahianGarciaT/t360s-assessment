import { DataSource, EntityManager } from 'typeorm';
import {
  InventoryRepository,
  ReservationRejectedError,
} from './inventory.repository';
import { Reservation, ReservationStatus } from './entities/reservation.entity';
import { StockItem } from './entities/stock-item.entity';

describe('InventoryRepository', () => {
  let repository: InventoryRepository;
  let dataSource: { transaction: jest.Mock };
  let manager: {
    query: jest.Mock;
    getRepository: jest.Mock;
  };
  let reservationManagerRepo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let stockManagerRepo: { findOne: jest.Mock };
  let baseRepository: { find: jest.Mock };
  let stockItemRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

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

  beforeEach(() => {
    reservationManagerRepo = {
      create: jest.fn((v) => v),
      save: jest.fn(),
      findOne: jest.fn(),
    };
    stockManagerRepo = { findOne: jest.fn() };
    manager = {
      query: jest.fn(),
      getRepository: jest.fn((entity) =>
        entity === StockItem ? stockManagerRepo : reservationManagerRepo,
      ),
    };
    dataSource = {
      transaction: jest.fn(
        async (cb: (manager: EntityManager) => Promise<unknown>) =>
          cb(manager as unknown as EntityManager),
      ),
    };
    baseRepository = { find: jest.fn() };
    stockItemRepository = {
      findOne: jest.fn(),
      create: jest.fn((v) => v),
      save: jest.fn(),
    };

    repository = new InventoryRepository(
      baseRepository as never,
      stockItemRepository as never,
      dataSource as unknown as DataSource,
    );
  });

  describe('reserve', () => {
    it('sums duplicate productIds and applies conditional UPDATEs sorted by productId ASC', async () => {
      // two lines for the SAME productId, plus a second product that sorts first
      manager.query.mockResolvedValue([{ productId: 'irrelevant' }]);
      reservationManagerRepo.save.mockImplementation((v) => v);

      const result = await repository.reserve(
        {
          orderId: 'order-1',
          items: [
            { productId: 'zebra', quantity: 3 },
            { productId: 'apple', quantity: 1 },
            { productId: 'zebra', quantity: 2 },
          ],
        },
        15,
      );

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      // 'apple' sorts before 'zebra'; 'zebra' quantities (3+2) summed to 5
      expect(manager.query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('UPDATE stock_items'),
        [1, 'apple'],
      );
      expect(manager.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('UPDATE stock_items'),
        [5, 'zebra'],
      );
      expect(reservationManagerRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: 'order-1',
          items: [
            { productId: 'apple', quantity: 1 },
            { productId: 'zebra', quantity: 5 },
          ],
          status: ReservationStatus.HELD,
        }),
      );
      expect(result).toEqual(expect.objectContaining({ orderId: 'order-1' }));
    });

    it('rejects with INSUFFICIENT_STOCK and rolls back when the conditional UPDATE affects zero rows', async () => {
      manager.query.mockResolvedValueOnce([]); // affected === 0 -> shortfall path
      stockManagerRepo.findOne.mockResolvedValue({
        productId: 'p1',
        quantity: 5,
        reserved: 5,
      });

      await expect(
        repository.reserve(
          { orderId: 'order-1', items: [{ productId: 'p1', quantity: 3 }] },
          15,
        ),
      ).rejects.toThrow(ReservationRejectedError);

      expect(reservationManagerRepo.save).not.toHaveBeenCalled();
    });

    it('rolls back the WHOLE transaction (no reservation saved) when only one item among several lacks stock', async () => {
      // first item (sorted first) succeeds, second item fails -> whole tx must reject
      manager.query
        .mockResolvedValueOnce([{ productId: 'apple' }]) // apple succeeds
        .mockResolvedValueOnce([]); // zebra fails
      stockManagerRepo.findOne.mockResolvedValue({
        productId: 'zebra',
        quantity: 2,
        reserved: 2,
      });

      await expect(
        repository.reserve(
          {
            orderId: 'order-1',
            items: [
              { productId: 'zebra', quantity: 4 },
              { productId: 'apple', quantity: 1 },
            ],
          },
          15,
        ),
      ).rejects.toThrow(ReservationRejectedError);

      // proves the failure propagated out of the transaction callback so
      // dataSource.transaction() rolls back the apple UPDATE too
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(reservationManagerRepo.save).not.toHaveBeenCalled();
    });

    it('rejects with UNKNOWN_PRODUCT when no stock_items row exists for the productId', async () => {
      manager.query.mockResolvedValueOnce([]);
      stockManagerRepo.findOne.mockResolvedValue(null);

      let caught: unknown;
      try {
        await repository.reserve(
          { orderId: 'order-1', items: [{ productId: 'ghost', quantity: 1 }] },
          15,
        );
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(ReservationRejectedError);
      const error = caught as ReservationRejectedError;
      expect(error.reason).toBe('UNKNOWN_PRODUCT');
      expect(error.shortfalls).toEqual([
        { productId: 'ghost', requested: 1, available: 0 },
      ]);
    });
  });

  describe('finalize', () => {
    it('commits a held reservation: decrements quantity and reserved for every item', async () => {
      const reservation = buildReservation();
      reservationManagerRepo.findOne.mockResolvedValue(reservation);
      reservationManagerRepo.save.mockImplementation((v) => v);

      const result = await repository.finalize('order-1', 'commit');

      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('quantity = quantity -'),
        [2, 'p1'],
      );
      expect(reservationManagerRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ReservationStatus.COMMITTED }),
      );
      expect(result).toEqual(
        expect.objectContaining({ status: ReservationStatus.COMMITTED }),
      );
    });

    it('is idempotent: returns the reservation as-is without re-applying stock changes when already terminal', async () => {
      const reservation = buildReservation({
        status: ReservationStatus.COMMITTED,
      });
      reservationManagerRepo.findOne.mockResolvedValue(reservation);

      const result = await repository.finalize('order-1', 'commit');

      expect(manager.query).not.toHaveBeenCalled();
      expect(reservationManagerRepo.save).not.toHaveBeenCalled();
      expect(result).toBe(reservation);
    });

    it('returns null when no reservation exists for the orderId (unknown reservation)', async () => {
      reservationManagerRepo.findOne.mockResolvedValue(null);

      const result = await repository.finalize('missing-order', 'release');

      expect(result).toBeNull();
    });
  });

  describe('claimExpired', () => {
    it('finds only HELD reservations past expiresAt, oldest first, up to batchSize', async () => {
      const due = [buildReservation()];
      baseRepository.find.mockResolvedValue(due);

      const result = await repository.claimExpired(50);

      expect(baseRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: ReservationStatus.HELD }),
          order: { expiresAt: 'ASC' },
          take: 50,
        }),
      );
      const whereArg = baseRepository.find.mock.calls[0][0].where;
      expect(whereArg.expiresAt.type).toBe('lessThan');
      expect(whereArg.expiresAt.value).toBeInstanceOf(Date);
      expect(result).toBe(due);
    });
  });

  describe('upsertStock', () => {
    it('creates a new stock_items row with reserved:0 when the productId does not exist', async () => {
      stockItemRepository.findOne.mockResolvedValue(null);
      stockItemRepository.save.mockImplementation((v) => v);

      const result = await repository.upsertStock('p1', 10);

      expect(stockItemRepository.create).toHaveBeenCalledWith({
        productId: 'p1',
        quantity: 10,
        reserved: 0,
      });
      expect(result).toEqual({ productId: 'p1', quantity: 10, reserved: 0 });
    });

    it('overwrites quantity in place (idempotent upsert) when the productId already exists (triangulation)', async () => {
      const existing = { productId: 'p1', quantity: 5, reserved: 2 };
      stockItemRepository.findOne.mockResolvedValue(existing);
      stockItemRepository.save.mockImplementation((v) => v);

      const result = await repository.upsertStock('p1', 20);

      expect(stockItemRepository.create).not.toHaveBeenCalled();
      expect(stockItemRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ productId: 'p1', quantity: 20, reserved: 2 }),
      );
      expect(result).toEqual(
        expect.objectContaining({ productId: 'p1', quantity: 20 }),
      );
    });
  });

  describe('getStock', () => {
    it('returns the stock_items row for a known productId', async () => {
      const stock = { productId: 'p1', quantity: 10, reserved: 2 };
      stockItemRepository.findOne.mockResolvedValue(stock);

      const result = await repository.getStock('p1');

      expect(stockItemRepository.findOne).toHaveBeenCalledWith({
        where: { productId: 'p1' },
      });
      expect(result).toBe(stock);
    });

    it('returns null for an unknown productId (triangulation)', async () => {
      stockItemRepository.findOne.mockResolvedValue(null);

      const result = await repository.getStock('ghost');

      expect(result).toBeNull();
    });
  });
});
