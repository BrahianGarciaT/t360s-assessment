import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Raíz del repositorio, resuelta a partir de la ubicación de este mismo archivo —
 * independiente de cualquier cwd desde el que se invoque Jest. `docker compose` debe
 * correr desde aquí para que tome el `docker-compose.yml` y `.env` de la raíz.
 */
export const repoRoot = path.resolve(__dirname, '..', '..', '..');

/**
 * Sondea si hay una CLI utilizable de Docker Compose v2 (`docker compose`, sin guion —
 * no está garantizado que `docker-compose` exista, ver `.github/workflows/ci.yml`).
 * Nunca lanza excepciones: los llamadores usan esto para hacer `describe.skip` de la suite en lugar de
 * fallar cuando Docker no está disponible en el entorno de ejecución.
 */
export function isDockerComposeAvailable(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detiene un único servicio de Compose sin tocar los demás.
 * Argv siempre es un array estático (el nombre del servicio es uno de un conjunto
 * literal fijo pasado por los call sites de esta suite) — nunca interpolado por shell.
 */
export function stopService(service: string): void {
  execFileSync('docker', ['compose', 'stop', service], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
}

/** Reinicia un servicio de Compose previamente detenido. */
export function startService(service: string): void {
  execFileSync('docker', ['compose', 'start', service], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
}
