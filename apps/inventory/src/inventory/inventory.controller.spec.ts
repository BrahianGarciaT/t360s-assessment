import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getLoggerToken } from 'nestjs-pino';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

describe('InventoryController', () => {
  let controller: InventoryController;
  let inventoryService: jest.Mocked<Pick<InventoryService, 'commit' | 'release'>>;

  beforeEach(async () => {
    inventoryService = {
      commit: jest.fn(),
      release: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InventoryController],
      providers: [
        { provide: InventoryService, useValue: inventoryService },
        {
          provide: getLoggerToken(InventoryController.name),
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-api-key') },
        },
      ],
    }).compile();

    controller = module.get<InventoryController>(InventoryController);
  });

  describe('handleCommit', () => {
    it('forwards event.metadata to inventoryService.commit (regression: metadata was being discarded)', async () => {
      inventoryService.commit.mockResolvedValue({
        ok: true,
        orderId: 'order-1',
      });

      await controller.handleCommit({
        eventId: 'event-1',
        orderId: 'order-1',
        metadata: { correlationId: 'corr-123' },
        apiKey: 'test-api-key',
      } as any);

      expect(inventoryService.commit).toHaveBeenCalledWith(
        'order-1',
        'event-1',
        { correlationId: 'corr-123' },
      );
    });
  });

  describe('handleRelease', () => {
    it('forwards event.metadata to inventoryService.release (regression: metadata was being discarded)', async () => {
      inventoryService.release.mockResolvedValue({
        ok: true,
        orderId: 'order-1',
      });

      await controller.handleRelease({
        eventId: 'event-2',
        orderId: 'order-1',
        reason: 'cancelled',
        metadata: { correlationId: 'corr-456' },
        apiKey: 'test-api-key',
      } as any);

      expect(inventoryService.release).toHaveBeenCalledWith(
        'order-1',
        'event-2',
        'cancelled',
        { correlationId: 'corr-456' },
      );
    });

    it('defaults reason to cancelled and still forwards metadata when reason is absent', async () => {
      inventoryService.release.mockResolvedValue({
        ok: true,
        orderId: 'order-1',
      });

      await controller.handleRelease({
        eventId: 'event-3',
        orderId: 'order-1',
        metadata: { correlationId: 'corr-789' },
        apiKey: 'test-api-key',
      } as any);

      expect(inventoryService.release).toHaveBeenCalledWith(
        'order-1',
        'event-3',
        'cancelled',
        { correlationId: 'corr-789' },
      );
    });
  });
});
