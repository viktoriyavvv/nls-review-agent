import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export interface Lock {
  path: string;
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  /** Locks older than this are treated as stale and overwritten with a warning. */
  staleMs?: number;
  /** Human label used in error/warn messages. */
  label?: string;
}

export class LockHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockHeldError';
  }
}

/**
 * File-based lock. Creates the lock file atomically (O_CREAT | O_EXCL). If the
 * file already exists and is younger than `staleMs`, throws LockHeldError. If it
 * is older, it is considered stale and overwritten with a warning.
 */
export async function acquireLock(lockPath: string, options: AcquireLockOptions = {}): Promise<Lock> {
  const staleMs = options.staleMs ?? TWO_HOURS_MS;
  const label = options.label ?? lockPath;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const payload = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    label,
  });

  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(payload, 'utf8');
    await handle.close();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'EEXIST') throw e;

    const stat = await fs.stat(lockPath).catch(() => null);
    const ageMs = stat ? Date.now() - stat.mtimeMs : Number.POSITIVE_INFINITY;

    if (ageMs > staleMs) {
      logger.warn(
        `Stale lock detected for ${label} (age ${Math.round(ageMs / 1000)}s > ${Math.round(
          staleMs / 1000,
        )}s). Overwriting.`,
      );
      await fs.writeFile(lockPath, payload, 'utf8');
    } else {
      throw new LockHeldError(
        `Lock held: ${label} (age ${Math.round(
          ageMs / 1000,
        )}s). Another process may be running. If you are sure it is stale, delete: ${lockPath}`,
      );
    }
  }

  return {
    path: lockPath,
    async release(): Promise<void> {
      await fs.rm(lockPath, { force: true });
    },
  };
}

/** Acquire a lock, run fn, always release. */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: AcquireLockOptions = {},
): Promise<T> {
  const lock = await acquireLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
