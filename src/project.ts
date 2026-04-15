/**
 * Auto-detect the current project identifier.
 *
 * Tries `git remote get-url origin` first (e.g., "user/repo").
 * Falls back to the current working directory basename.
 */

import { execSync } from 'child_process';
import { realpathSync } from 'fs';

let cachedProjectId: string | null = null;

export function detectProjectId(): string {
  if (cachedProjectId !== null) {
    return cachedProjectId;
  }

  // Remote HTTP mode has no local git context
  if (process.env.COGMEMAI_TRANSPORT === 'http') {
    cachedProjectId = 'remote';
    return cachedProjectId;
  }

  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Normalize: remove .git suffix, extract org/repo
    cachedProjectId = remote
      .replace(/\.git$/, '')
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/^git@[^:]+:/, '');
  } catch {
    // No git remote — use directory name, normalized to filesystem-canonical case
    // (on Windows, process.cwd() case tracks shell input; realpathSync.native gives
    // the real folder casing, which must match what the Stop hook produces so saves
    // tag the same project_id).
    let resolved = process.cwd();
    try {
      // @ts-ignore — .native present on Windows
      resolved = (realpathSync as any).native ? (realpathSync as any).native(resolved) : realpathSync(resolved);
    } catch {
      // keep process.cwd() on failure
    }
    const parts = resolved.split(/[\\/]/);
    cachedProjectId = parts[parts.length - 1] || 'unknown';
  }

  return cachedProjectId;
}
