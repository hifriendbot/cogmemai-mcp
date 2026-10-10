/**
 * v3.32.2: a short local record of the memories this machine just saved or
 * updated. The end-of-turn review reads it so that it does not present, as
 * something "remembered", a note that was written minutes earlier in the same
 * stretch of work. Ids and timestamps only, never content. Best effort: every
 * failure is swallowed, because losing this record only means one extra line
 * on screen.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { FLAG_DIR } from './config.js';

export const RECENT_WRITES_FILE = join(FLAG_DIR, 'recent-writes.json');
/** A memory written more recently than this counts as just written. */
export const RECENT_WRITE_SECONDS = 12 * 3600;
const KEEP_SECONDS = 24 * 3600;
const MAX_ENTRIES = 500;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function toId(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function readLog(path: string): Record<string, number> {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, number>;
  } catch { /* missing or corrupt: start empty */ }
  return {};
}

/** Record that this machine just saved or updated a memory. */
export function recordWrite(id: unknown, path: string = RECENT_WRITES_FILE, now: number = nowSeconds()): void {
  const memoryId = toId(id);
  if (memoryId === null) return;
  try {
    const log = readLog(path);
    log[String(memoryId)] = now;
    const kept = Object.entries(log)
      .filter(([, ts]) => typeof ts === 'number' && now - ts < KEEP_SECONDS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ENTRIES);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(Object.fromEntries(kept)));
  } catch { /* non-critical */ }
}

/** Ids of memories written on this machine within the last `maxAgeSeconds`. */
export function recentWriteIds(maxAgeSeconds: number = RECENT_WRITE_SECONDS, path: string = RECENT_WRITES_FILE, now: number = nowSeconds()): Set<number> {
  const ids = new Set<number>();
  for (const [key, ts] of Object.entries(readLog(path))) {
    const id = toId(key);
    if (id !== null && typeof ts === 'number' && now - ts < maxAgeSeconds) ids.add(id);
  }
  return ids;
}
