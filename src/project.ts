/**
 * Auto-detect the current project identifier.
 *
 * Resolution order:
 *   1. CLAUDE_PROJECT_DIR env (set by Claude Code for spawned subprocesses;
 *      points at the actual project root regardless of MCP server spawn cwd)
 *   2. process.cwd()
 *
 * From the resolved directory: try `git remote get-url origin` first
 * (e.g., "user/repo"), then fall back to the directory basename.
 *
 * Cached per-directory. Re-keying by directory means the same long-lived
 * MCP server instance correctly tags memories when reused across projects.
 */

import { execSync } from 'child_process';
import { realpathSync } from 'fs';

const cache = new Map<string, string>();

export function detectProjectId(): string {
  // Remote HTTP mode has no local git context
  if (process.env.COGMEMAI_TRANSPORT === 'http') {
    return 'remote';
  }

  const baseDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const cached = cache.get(baseDir);
  if (cached !== undefined) {
    return cached;
  }

  let projectId: string;
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: baseDir,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    projectId = remote
      .replace(/\.git$/, '')
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/^git@[^:]+:/, '');
  } catch {
    // No git remote — use directory name, normalized to filesystem-canonical case
    // (on Windows, process.cwd() case tracks shell input; realpathSync.native gives
    // the real folder casing, which must match what the Stop hook produces so saves
    // tag the same project_id).
    let resolved = baseDir;
    try {
      // @ts-ignore — .native present on Windows
      resolved = (realpathSync as any).native ? (realpathSync as any).native(resolved) : realpathSync(resolved);
    } catch {
      // keep baseDir on failure
    }
    const parts = resolved.split(/[\\/]/);
    projectId = parts[parts.length - 1] || 'unknown';
  }

  cache.set(baseDir, projectId);
  return projectId;
}
