import { ValidationPipe, ArgumentMetadata } from '@nestjs/common';
import { InventoryAuditEvent } from './inventory-audit-event.interface';

/**
 * NestJS's ValidationPipe.toValidate() skips validation/transform entirely when
 * ArgumentMetadata.type === 'custom' unless `validateCustomDecorators: true` is set
 * (see node_modules/@nestjs/common/pipes/validation.pipe.js). Every @Payload() argument
 * in @nestjs/microservices always arrives with type: 'custom' (RpcParamtype.PAYLOAD maps
 * to the 'custom' token in @nestjs/core/pipes/params-token-factory.js). None of this repo's
 * 3 main.ts files set validateCustomDecorators, so the global
 * ValidationPipe({ whitelist: true, transform: true }) never validates or whitelist-strips
 * TCP payloads — this suite documents that real behavior instead of the field-stripping
 * behavior a naive reading of the whitelist option would suggest.
 */
describe('InventoryAuditEvent vs. global ValidationPipe({ whitelist: true, transform: true }) on a TCP payload', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const tcpPayloadMetadata: ArgumentMetadata = { type: 'custom', metatype: InventoryAuditEvent };

  const basePayload = {
    eventId: 'evt-1',
    orderId: '11111111-1111-1111-1111-111111111111',
    timestamp: new Date().toISOString(),
    apiKey: 'test-key',
  };

  it('passes metadata.correlationId through untouched (type: custom bypasses the pipe entirely)', async () => {
    const payload = { ...basePayload, metadata: { correlationId: 'corr-123' } };

    const result = await pipe.transform(payload, tcpPayloadMetadata);

    expect(result).toBe(payload);
    expect(result.metadata).toEqual({ correlationId: 'corr-123' });
  });

  it('does NOT strip fields undeclared on the DTO — whitelist has no effect on @Payload() args', async () => {
    const payload = {
      ...basePayload,
      metadata: { correlationId: 'corr-123' },
      extraneous: 'not-stripped-because-type-is-custom',
    };

    const result = await pipe.transform(payload, tcpPayloadMetadata);

    expect(result.extraneous).toBe('not-stripped-because-type-is-custom');
  });

  it('does not reject the payload when metadata is absent (no validation runs on this path at all)', async () => {
    await expect(pipe.transform({ ...basePayload }, tcpPayloadMetadata)).resolves.toBeDefined();
  });
});
