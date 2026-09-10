/**
 * CogmemAi Guard: hooks, rule cache and CLI.
 *
 * Everything with side effects lives here; the decision engine in guard.ts
 * stays pure so it can be tested without a filesystem.
 *
 *   hook pretooluse    PreToolUse on Bash. Reads the proposed command, judges
 *                      it against the static rules plus the cached remembered
 *                      rules for this project, logs the verdict, denies when
 *                      it must. No network: the cache is refreshed at session
 *                      start and by `guard sync`.
 *   hook guard-review  Stop. Reviews what changed in the working tree this
 *                      turn (secrets, version drift, deletions, duplicate
 *                      definitions) and asks CogmemAi for remembered landmines
 *                      near the touched files. Advisory only.
 *   guard sync         Refresh the remembered-rule cache for this project.
 *   guard status       Show what is cached and what the log says.
 *   guard test <cmd>   Judge a command without running it.
 *   guard log [n]      Show the last n verdicts.
 *   guard install      Add the guard hooks to ~/.claude/settings.json.
 *   guard check <cmd>  Judge a command for the shell adapter: exit 0 allow,
 *                      exit 2 deny with the reason on stderr.
 *   guard shell-install / shell-remove
 *                      The shell adapter. Every agent eventually runs
 *                      `bash -c "<command>"`, and non-interactive bash
 *                      sources the file named in BASH_ENV first, with the
 *                      whole command in BASH_EXECUTION_STRING. A sourced
 *                      script hands that string to `guard check` and exits
 *                      before anything runs when it is denied. One engine,
 *                      one rule cache, one log, for every tool that opens
 *                      a shell: Cursor, Codex, Gemini CLI, plain scripts.
 */

import { execSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { API_BASE, FLAG_DIR, HOOK_FETCH_TIMEOUT_MS, VERSION } from './config.js';
import { compileMemoryRules, decide, redact, type MemoryRule, type Verdict } from './guard.js';
import { reviewWorkingTree } from './guard-review.js';

export const GUARD_LOG_PATH = process.env.COGMEMAI_GUARD_LOG || join(FLAG_DIR, 'guard-verdicts.jsonl');
const GUARD_LOG_MAX_BYTES = 2 * 1024 * 1024;

// ── Small local helpers (hooks run outside the MCP server process) ──

function readStdinJson(): Record<string, any> {
  try {
    const raw = readFileSync(0, 'utf-8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function resolveKey(): string {
  if (process.env.COGMEMAI_API_KEY) return process.env.COGMEMAI_API_KEY;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf-8'));
    return cfg?.mcpServers?.cogmemai?.env?.COGMEMAI_API_KEY || '';
  } catch {
    return '';
  }
}

/** Same derivation the other hooks use: git remote path, else the directory name. */
export function projectIdFor(cwd: string): string {
  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: cwd || undefined,
    }).trim();
    return remote.replace(/\.git$/, '').replace(/^https?:\/\/[^/]+\//, '').replace(/^git@[^:]+:/, '');
  } catch {
    let resolved = cwd || process.cwd();
    try {
      resolved = (realpathSync as any).native ? (realpathSync as any).native(resolved) : realpathSync(resolved);
    } catch {
      /* keep original */
    }
    const parts = resolved.split(/[\\/]/);
    return parts[parts.length - 1] || 'unknown';
  }
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function cachePath(scope: 'global' | string): string {
  return join(FLAG_DIR, `guard-rules-${scope === 'global' ? 'global' : safeName(scope)}.json`);
}

function logError(where: string, err: unknown): void {
  try {
    mkdirSync(FLAG_DIR, { recursive: true });
    appendFileSync(join(FLAG_DIR, 'errors.log'), `[${new Date().toISOString()}] ${where}: ${err instanceof Error ? err.message : String(err)}\n`);
  } catch {
    /* never throw from logging */
  }
}

// ── Rule cache ────────────────────────────────────────────────

interface RuleCache {
  synced_at: string;
  scope: string;
  version: string;
  rules: MemoryRule[];
}

function readCache(path: string): MemoryRule[] {
  try {
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, 'utf-8')) as RuleCache;
    return Array.isArray(data.rules) ? data.rules : [];
  } catch {
    return [];
  }
}

/** Remembered rules that apply in `cwd`: global ones plus this project's. */
export function loadRules(cwd: string): { rules: MemoryRule[]; projectId: string } {
  const projectId = projectIdFor(cwd);
  const seen = new Set<string>();
  const rules: MemoryRule[] = [];
  for (const r of [...readCache(cachePath('global')), ...readCache(cachePath(projectId))]) {
    const key = `${r.source}:${r.pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(r);
  }
  return { rules, projectId };
}

async function fetchRules(apiKey: string, params: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const qs = new URLSearchParams({ memory_type: 'rule', limit: '100', ...params }).toString();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HOOK_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/cogmemai/memories?${qs}`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': `cogmemai-mcp/${VERSION}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from /cogmemai/memories`);
    const data = (await res.json()) as { memories?: Array<Record<string, unknown>> };
    return Array.isArray(data.memories) ? data.memories : [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Refresh the cached rules for a project. Two files: the global rules, which
 * apply everywhere, and this project's own. Best effort; on any failure the
 * previous cache stays in place and the static rules keep working.
 */
export async function syncGuardRules(apiKey: string, projectId: string): Promise<{ global: number; project: number } | null> {
  try {
    mkdirSync(FLAG_DIR, { recursive: true });
    const globalMems = await fetchRules(apiKey, { scope: 'global' });
    const projectMems = (await fetchRules(apiKey, { project_id: projectId })).filter(
      (m) => m.scope !== 'global'
    );
    const write = (scope: string, mems: Array<Record<string, unknown>>): number => {
      const rules = compileMemoryRules(mems);
      const cache: RuleCache = { synced_at: new Date().toISOString(), scope, version: VERSION, rules };
      writeFileSync(cachePath(scope), JSON.stringify(cache, null, 2));
      return rules.length;
    };
    return { global: write('global', globalMems), project: write(projectId, projectMems) };
  } catch (err) {
    logError('guard-sync', err);
    return null;
  }
}

// ── Verdict log ───────────────────────────────────────────────

function logVerdict(input: Record<string, any>, command: string, verdict: Verdict | null, ruleCount: number): void {
  try {
    mkdirSync(FLAG_DIR, { recursive: true });
    try {
      if (statSync(GUARD_LOG_PATH).size > GUARD_LOG_MAX_BYTES) {
        const lines = readFileSync(GUARD_LOG_PATH, 'utf-8').split('\n');
        writeFileSync(GUARD_LOG_PATH, lines.slice(Math.floor(lines.length / 2)).join('\n'));
      }
    } catch {
      /* no log yet */
    }
    const entry = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      decision: verdict ? verdict.decision : 'allow',
      rule: verdict ? verdict.rule : null,
      command: redact(command).slice(0, 400),
      session: String(input.session_id || '').slice(0, 12),
      cwd: String(input.cwd || ''),
      remembered_rules: ruleCount,
    };
    appendFileSync(GUARD_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch {
    /* logging must never affect the verdict */
  }
}

// ── PreToolUse hook ───────────────────────────────────────────

export async function runHookPreToolUse(): Promise<void> {
  try {
    const input = readStdinJson();
    if (input.tool_name && input.tool_name !== 'Bash') return;
    const command: string = input?.tool_input?.command || '';
    if (!command) return;

    const { rules } = loadRules(String(input.cwd || process.cwd()));
    const verdict = decide(command, rules);
    logVerdict(input, command, verdict, rules.length);
    if (!verdict) return;

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: verdict.decision,
          permissionDecisionReason: 'CogmemAi Guard. ' + verdict.reason,
        },
      })
    );
  } catch (err) {
    logError('guard-pretooluse', err);
    // Fail open: no output means the command runs.
  }
}

// ── Stop hook: end-of-turn review ─────────────────────────────

export async function runHookGuardReview(): Promise<void> {
  try {
    const input = readStdinJson();
    if (input.stop_hook_active) return;
    const cwd = String(input.cwd || process.cwd());
    const notes = await reviewWorkingTree(cwd, {
      apiKey: resolveKey(),
      apiBase: API_BASE,
      timeoutMs: HOOK_FETCH_TIMEOUT_MS,
      userAgent: `cogmemai-mcp/${VERSION}`,
    });
    if (notes.length === 0) return; // a clean turn earns silence
    const body =
      'CogmemAi Guard reviewed this turn:\n' +
      notes.slice(0, 5).map((n) => `  - ${n}`).join('\n') +
      '\n  (Advisory only. Nothing was changed or blocked.)';
    console.log(JSON.stringify({ systemMessage: body, suppressOutput: true }));
  } catch (err) {
    logError('guard-review', err);
  }
}

// ── Settings wiring ───────────────────────────────────────────

/** Add the two guard hooks to ~/.claude/settings.json if they are not there. Idempotent. */
export function installGuardHooks(): { success: boolean; added: string[]; error?: string } {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    let settings: Record<string, any> = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      /* start fresh */
    }
    settings.hooks = settings.hooks || {};
    const has = (arr: any[], cmd: string): boolean =>
      Array.isArray(arr) &&
      arr.some((e: any) => Array.isArray(e.hooks) && e.hooks.some((h: any) => typeof h.command === 'string' && h.command.includes(cmd)));
    const added: string[] = [];

    settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
    if (!has(settings.hooks.PreToolUse, 'cogmemai-mcp hook pretooluse')) {
      settings.hooks.PreToolUse.push({
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'cogmemai-mcp hook pretooluse', timeout: 5 }],
      });
      added.push('PreToolUse');
    }
    settings.hooks.Stop = settings.hooks.Stop || [];
    if (!has(settings.hooks.Stop, 'cogmemai-mcp hook guard-review')) {
      settings.hooks.Stop.push({
        hooks: [{ type: 'command', command: 'cogmemai-mcp hook guard-review', timeout: 15 }],
      });
      added.push('Stop');
    }
    if (added.length) {
      mkdirSync(join(homedir(), '.claude'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
    return { success: true, added };
  } catch (err: any) {
    return { success: false, added: [], error: err?.message || String(err) };
  }
}

// ── Shell adapter ─────────────────────────────────────────────

export const GUARD_SH_PATH = join(FLAG_DIR, 'guard.sh');
const SHELL_MARKER = '# cogmemai-guard';

/**
 * The sourced script. Kept POSIX-plain except where it tests for bash or
 * zsh specifically, because it runs before anything else in every shell.
 * COGMEMAI_GUARD_OFF=1 disables it for one process, and is set on the check
 * itself so the guard can never recurse into its own shell.
 */
export const GUARD_SH = `${SHELL_MARKER} shell adapter (managed by \`cogmemai-mcp guard shell-install\`)
# Judges the command string of a non-interactive shell before it runs.
# Exit 0 = allow, exit 2 = denied by CogmemAi Guard (reason on stderr).
if [ -z "$COGMEMAI_GUARD_OFF" ] && command -v cogmemai-mcp >/dev/null 2>&1; then
  __cogmemai_guard_string=""
  if [ -n "$BASH_VERSION" ] && [ -n "$BASH_EXECUTION_STRING" ]; then
    __cogmemai_guard_string="$BASH_EXECUTION_STRING"
  elif [ -n "$ZSH_VERSION" ] && [ -n "$ZSH_EXECUTION_STRING" ]; then
    __cogmemai_guard_string="$ZSH_EXECUTION_STRING"
  fi
  if [ -n "$__cogmemai_guard_string" ]; then
    if ! COGMEMAI_GUARD_OFF=1 cogmemai-mcp guard check "$__cogmemai_guard_string"; then
      exit 2
    fi
  fi
  unset __cogmemai_guard_string
fi
`;

function rcFiles(): string[] {
  const h = homedir();
  return [join(h, '.bashrc'), join(h, '.bash_profile'), join(h, '.profile'), join(h, '.zshenv')];
}

/** Lines the installer appends. BASH_ENV is exported so shells started from these shells inherit it. */
function rcSnippet(): string {
  const p = GUARD_SH_PATH.replace(/\\/g, '/');
  return `\n${SHELL_MARKER}\nexport BASH_ENV="${p}"\n[ -f "${p}" ] && . "${p}"\n${SHELL_MARKER} end\n`;
}

function stripSnippet(text: string): string {
  return text.replace(new RegExp(`\\n?${SHELL_MARKER}\\n[\\s\\S]*?${SHELL_MARKER} end\\n?`, 'g'), '\n').replace(/\n{3,}$/, '\n\n');
}

export function installShellAdapter(): { written: string[]; envSet: boolean; note: string } {
  mkdirSync(FLAG_DIR, { recursive: true });
  writeFileSync(GUARD_SH_PATH, GUARD_SH);
  const written: string[] = [];
  for (const rc of rcFiles()) {
    let text = '';
    try {
      text = readFileSync(rc, 'utf-8');
    } catch {
      /* create it */
    }
    if (text.includes(SHELL_MARKER)) continue;
    writeFileSync(rc, text + rcSnippet());
    written.push(rc);
  }
  // Processes launched from a desktop session, not from a shell, only see
  // BASH_ENV if it is set at the user level. On Windows that is one setx;
  // elsewhere it is the user's login environment, which the rc files cover
  // for anything started from a terminal.
  let envSet = false;
  let note = '';
  if (process.platform === 'win32') {
    try {
      execSync(`setx BASH_ENV "${GUARD_SH_PATH}"`, { stdio: 'pipe', timeout: 10000 });
      envSet = true;
      note = 'BASH_ENV set for your Windows user; new processes pick it up, already-open apps need a restart.';
    } catch {
      note = `Could not set BASH_ENV for the user. Set it yourself: BASH_ENV=${GUARD_SH_PATH}`;
    }
  } else if (process.platform === 'darwin') {
    try {
      execSync(`launchctl setenv BASH_ENV "${GUARD_SH_PATH}"`, { stdio: 'pipe', timeout: 10000 });
      envSet = true;
      note = 'BASH_ENV set for GUI-launched apps via launchctl; terminals get it from the rc files.';
    } catch {
      note = 'Terminals get BASH_ENV from the rc files. For GUI-launched editors run: launchctl setenv BASH_ENV ' + GUARD_SH_PATH;
    }
  } else {
    note = 'Terminals get BASH_ENV from the rc files. For editors launched from a desktop session, add BASH_ENV to ~/.pam_environment or your session environment.';
  }
  return { written, envSet, note };
}

export function removeShellAdapter(): string[] {
  const touched: string[] = [];
  for (const rc of rcFiles()) {
    try {
      const text = readFileSync(rc, 'utf-8');
      if (!text.includes(SHELL_MARKER)) continue;
      writeFileSync(rc, stripSnippet(text));
      touched.push(rc);
    } catch {
      /* no such file */
    }
  }
  try {
    if (existsSync(GUARD_SH_PATH)) {
      writeFileSync(GUARD_SH_PATH, `${SHELL_MARKER} removed; safe to delete\n`);
    }
  } catch {
    /* ignore */
  }
  if (process.platform === 'win32') {
    try {
      execSync('reg delete HKCU\\Environment /v BASH_ENV /f', { stdio: 'pipe', timeout: 10000 });
    } catch {
      /* was not set */
    }
  } else if (process.platform === 'darwin') {
    try {
      execSync('launchctl unsetenv BASH_ENV', { stdio: 'pipe', timeout: 10000 });
    } catch {
      /* ignore */
    }
  }
  return touched;
}

// ── CLI ───────────────────────────────────────────────────────

export async function runGuardCli(args: string[]): Promise<void> {
  const sub = (args[0] || 'status').toLowerCase();
  const cwd = process.cwd();

  if (sub === 'check') {
    // Shell adapter entry point. Silent and exit 0 on allow; reason on
    // stderr and exit 2 on deny. Any internal failure allows (fail open).
    const command = args.slice(1).join(' ');
    if (!command) return;
    try {
      const { rules } = loadRules(cwd);
      const v = decide(command, rules);
      logVerdict({ session_id: 'shell', cwd }, command, v, rules.length);
      if (v) {
        console.error('CogmemAi Guard. ' + v.reason);
        process.exit(2);
      }
    } catch (err) {
      logError('guard-check', err);
    }
    return;
  }

  if (sub === 'shell-install') {
    const r = installShellAdapter();
    console.log(`Shell adapter written to ${GUARD_SH_PATH}`);
    console.log(r.written.length ? `Sourced from: ${r.written.join(', ')}` : 'rc files already had it.');
    console.log(r.note);
    console.log('Try it: bash -c "cogmemai-mcp guard test \'crontab -l | crontab -\'"  then  bash -c "crontab -l | crontab -"');
    return;
  }

  if (sub === 'shell-remove') {
    const touched = removeShellAdapter();
    console.log(touched.length ? `Removed from: ${touched.join(', ')}` : 'Shell adapter was not installed in any rc file.');
    console.log('BASH_ENV cleared for new processes. Open shells keep it until restarted.');
    return;
  }

  if (sub === 'sync') {
    const key = resolveKey();
    if (!key) {
      console.error('No CogmemAi API key found. Run `npx cogmemai-mcp setup` first.');
      process.exit(1);
    }
    const projectId = projectIdFor(cwd);
    const r = await syncGuardRules(key, projectId);
    if (!r) {
      console.error('Sync failed. See ~/.cogmemai/errors.log');
      process.exit(1);
    }
    console.log(`Guard rules synced for ${projectId}: ${r.global} global, ${r.project} project.`);
    return;
  }

  if (sub === 'test') {
    const command = args.slice(1).join(' ');
    if (!command) {
      console.error('Usage: cogmemai-mcp guard test "<command>"');
      process.exit(1);
    }
    const { rules } = loadRules(cwd);
    const v = decide(command, rules);
    if (!v) {
      console.log('allow (silent)');
      return;
    }
    console.log(`${v.decision} [${v.rule}]\n${v.reason}`);
    return;
  }

  if (sub === 'log') {
    const n = Math.max(1, parseInt(args[1] || '20', 10) || 20);
    try {
      const lines = readFileSync(GUARD_LOG_PATH, 'utf-8').trim().split('\n').slice(-n);
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          console.log(`${e.ts}  ${String(e.decision).padEnd(5)}  ${(e.rule || '').padEnd(22)}  ${e.command}`);
        } catch {
          /* skip bad line */
        }
      }
    } catch {
      console.log('No verdicts logged yet.');
    }
    return;
  }

  if (sub === 'install') {
    const r = installGuardHooks();
    if (!r.success) {
      console.error(`Could not update ~/.claude/settings.json: ${r.error}`);
      process.exit(1);
    }
    console.log(r.added.length ? `Guard hooks added: ${r.added.join(', ')}. Open /hooks or restart Claude Code.` : 'Guard hooks already installed.');
    return;
  }

  // status
  const { rules, projectId } = loadRules(cwd);
  const explicit = rules.filter((r) => r.source === 'explicit').length;
  console.log(`CogmemAi Guard ${VERSION}`);
  console.log(`  project:          ${projectId}`);
  console.log(`  remembered rules: ${rules.length} (${explicit} explicit GUARD: lines, ${rules.length - explicit} derived from NEVER sentences)`);
  for (const r of rules.slice(0, 12)) {
    console.log(`    - [${r.source}] ${r.subject || r.id}: /${r.pattern}/`);
  }
  let total = 0;
  const byRule: Record<string, number> = {};
  try {
    for (const l of readFileSync(GUARD_LOG_PATH, 'utf-8').split('\n')) {
      if (!l.trim()) continue;
      total++;
      const e = JSON.parse(l);
      if (e.decision !== 'allow') byRule[e.rule] = (byRule[e.rule] || 0) + 1;
    }
  } catch {
    /* no log */
  }
  const denies = Object.values(byRule).reduce((a, b) => a + b, 0);
  console.log(`  verdicts logged:  ${total} (${denies} denied)`);
  for (const [rule, n] of Object.entries(byRule)) console.log(`    - ${rule}: ${n}`);
  console.log(`  log:              ${GUARD_LOG_PATH}`);
}
