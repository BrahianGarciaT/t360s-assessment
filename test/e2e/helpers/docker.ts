import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Repository root, resolved from this file's own location — independent of
 * whatever cwd Jest happens to be invoked from. `docker compose` must run
 * from here so it picks up the root `docker-compose.yml` and `.env`.
 */
export const repoRoot = path.resolve(__dirname, '..', '..', '..');

/**
 * Probes for a usable Docker Compose v2 CLI (`docker compose`, no hyphen —
 * `docker-compose` is not guaranteed to exist, see `.github/workflows/ci.yml`).
 * Never throws: callers use this to `describe.skip` the suite instead of
 * failing when Docker isn't available in the execution environment.
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
 * Stops a single Compose service without touching the others.
 * Argv is always a static array (service name is one of a fixed literal
 * set passed by call sites in this suite) — never shell-interpolated.
 */
export function stopService(service: string): void {
  execFileSync('docker', ['compose', 'stop', service], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
}

/** Restarts a previously-stopped Compose service. */
export function startService(service: string): void {
  execFileSync('docker', ['compose', 'start', service], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
}
