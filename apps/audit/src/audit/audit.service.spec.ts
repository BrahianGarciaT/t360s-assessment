import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { AuditService } from './audit.service';
import { AuditLog } from './schemas/audit-log.schema';
import { CreateAuditLogDto } from './dto/create-audit-log.dto';

describe('AuditService', () => {
  let service: AuditService;
  let saveMock: jest.Mock;
  let findOneMock: jest.Mock;
  let findMock: jest.Mock;
  let modelConstructorMock: jest.Mock;

  const baseDto: CreateAuditLogDto = {
    eventId: 'event-1',
    orderId: 'order-1',
    eventType: 'order.status_changed',
    fromStatus: null,
    toStatus: 'PENDING',
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    metadata: {},
  };

  beforeEach(async () => {
    saveMock = jest.fn();
    findOneMock = jest.fn();
    findMock = jest.fn();

    // El modelo de Mongoose se usa tanto como constructor (`new this.auditLogModel(dto)`)
    // como espacio de nombres estático (`.findOne`, `.find`) — se simulan (mock) ambas formas.
    modelConstructorMock = jest.fn().mockImplementation((dto) => ({
      ...dto,
      save: saveMock,
    })) as unknown as jest.Mock;
    (modelConstructorMock as any).findOne = findOneMock;
    (modelConstructorMock as any).find = findMock;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        {
          provide: getModelToken(AuditLog.name),
          useValue: modelConstructorMock,
        },
      ],
    }).compile();

    service = module.get<AuditService>(AuditService);
  });

  describe('createLog', () => {
    it('creates exactly one document on first delivery', async () => {
      saveMock.mockResolvedValue({ ...baseDto, _id: 'mongo-id-1' });

      const result = await service.createLog(baseDto);

      expect(modelConstructorMock).toHaveBeenCalledWith(baseDto);
      expect(saveMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ...baseDto, _id: 'mongo-id-1' });
    });

    it('is a no-op (not an error) when eventId already exists (duplicate key E11000)', async () => {
      const duplicateKeyError = Object.assign(new Error('duplicate key'), {
        code: 11000,
      });
      saveMock.mockRejectedValue(duplicateKeyError);
      const existingDoc = { ...baseDto, _id: 'mongo-id-existing' };
      findOneMock.mockResolvedValue(existingDoc);

      const result = await service.createLog(baseDto);

      expect(findOneMock).toHaveBeenCalledWith({ eventId: baseDto.eventId });
      expect(result).toEqual(existingDoc);
    });

    it('rethrows non-duplicate-key errors', async () => {
      const otherError = new Error('connection lost');
      saveMock.mockRejectedValue(otherError);

      await expect(service.createLog(baseDto)).rejects.toThrow(
        'connection lost',
      );
    });

    it('rethrows the original duplicate-key error if the existing doc cannot be found (race condition)', async () => {
      const duplicateKeyError = Object.assign(new Error('duplicate key'), {
        code: 11000,
      });
      saveMock.mockRejectedValue(duplicateKeyError);
      findOneMock.mockResolvedValue(null);

      await expect(service.createLog(baseDto)).rejects.toThrow('duplicate key');
    });
  });

  describe('createInventoryLog', () => {
    const inventoryEvent = {
      eventId: 'inv-event-1',
      orderId: 'order-1',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      details: { items: [{ productId: 'p1', quantity: 2 }] },
    };

    it('persists a new log with the given eventType', async () => {
      saveMock.mockResolvedValue({ ...inventoryEvent, _id: 'mongo-id-2' });

      await service.createInventoryLog('inventory.reserved', inventoryEvent);

      expect(modelConstructorMock).toHaveBeenCalledWith({
        eventId: inventoryEvent.eventId,
        orderId: inventoryEvent.orderId,
        eventType: 'inventory.reserved',
        timestamp: inventoryEvent.timestamp,
        details: inventoryEvent.details,
      });
      expect(saveMock).toHaveBeenCalledTimes(1);
    });

    it('is a no-op (not an error) when eventId already exists (duplicate key E11000)', async () => {
      const duplicateKeyError = Object.assign(new Error('duplicate key'), {
        code: 11000,
      });
      saveMock.mockRejectedValue(duplicateKeyError);

      await expect(
        service.createInventoryLog('inventory.reserved', inventoryEvent),
      ).resolves.toBeUndefined();
    });

    it('rethrows non-duplicate-key errors', async () => {
      const otherError = new Error('connection lost');
      saveMock.mockRejectedValue(otherError);

      await expect(
        service.createInventoryLog('inventory.reserved', inventoryEvent),
      ).rejects.toThrow('connection lost');
    });
  });

  describe('findByOrderId', () => {
    it('delegates to the model, sorted by timestamp ascending', async () => {
      const sortMock = jest.fn().mockReturnThis();
      const execMock = jest.fn().mockResolvedValue([baseDto]);
      findMock.mockReturnValue({ sort: sortMock, exec: execMock });

      const result = await service.findByOrderId('order-1');

      expect(findMock).toHaveBeenCalledWith({ orderId: 'order-1' });
      expect(sortMock).toHaveBeenCalledWith({ timestamp: 1 });
      expect(result).toEqual([baseDto]);
    });
  });
});
