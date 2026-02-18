/**
 * Auto-detect the current project identifier.
 *
 * Tries `git remote get-url origin` first (e.g., "user/repo").
 * Falls back to the current working directory basename.
 */

import { execSync } from 'child_process';

let cachedProjectId: string | null = null;

export function detectProjectId(): string {
  if (cachedProjectId !== null) {
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
    // No git remote — use directory name
    const parts = process.cwd().split(/[\\/]/);
    cachedProjectId = parts[parts.length - 1] || 'unknown';
  }

  return cachedProjectId;
}
