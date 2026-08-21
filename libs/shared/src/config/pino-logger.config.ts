import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import { CORRELATION_ID_HEADER } from '../constants/correlation-id';

/**
 * Shared pino-http config for both services: honors an inbound correlation
 * id (or mints one), echoes it on the response, and surfaces it as a
 * top-level `correlationId` field on every HTTP access log line.
 */
export function createPinoLoggerOptions(serviceName: string): Params {
  return {
    pinoHttp: {
      name: serviceName,
      genReqId: (req, res) => {
        const header = req.headers[CORRELATION_ID_HEADER];
        const correlationId =
          (Array.isArray(header) ? header[0] : header) ?? randomUUID();
        res.setHeader(CORRELATION_ID_HEADER, correlationId);
        return correlationId;
      },
      customProps: (req) => ({ correlationId: req.id }),
    },
  };
}
