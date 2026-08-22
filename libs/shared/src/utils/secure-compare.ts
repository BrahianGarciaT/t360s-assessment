import { createHash, timingSafeEqual } from 'crypto';

/**
 * Compara dos strings en tiempo constante sin filtrar su longitud relativa.
 * `timingSafeEqual` por sí solo lanza una excepción si los buffers tienen
 * longitudes distintas, lo que obliga a un chequeo previo de `length` que
 * termina filtrando esa longitud por temporización — hashear ambos valores
 * primero produce siempre buffers de igual tamaño (32 bytes), eliminando
 * ese atajo por completo.
 */
export function secureCompare(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
