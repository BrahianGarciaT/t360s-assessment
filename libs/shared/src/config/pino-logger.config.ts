import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import { CORRELATION_ID_HEADER } from '../constants/correlation-id';

/**
 * Configuración compartida de pino-http para ambos servicios: respeta un
 * correlation id entrante (o genera uno nuevo), lo repite en la respuesta y
 * lo expone como campo `correlationId` de nivel superior en cada línea de
 * log de acceso HTTP.
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
