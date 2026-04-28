/**
 * CogmemAi CLI — Setup wizard, verification, and hook commands.
 *
 * Usage:
 *   npx cogmemai-mcp setup          Interactive setup for Claude Code
 *   npx cogmemai-mcp setup <key>    Setup with API key provided
 *   npx cogmemai-mcp verify         Verify API key and connection
 *   cogmemai-mcp hook precompact    PreCompact hook (saves context before compaction)
 *   cogmemai-mcp hook context-reload  Post-compaction context reload
 */

import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync, appendFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { API_BASE, VERSION, FLAG_DIR, SESSION_EXPIRY_SECONDS, COMPACTION_FLAG_MAX_AGE, SUMMARY_CONFIG, HOOK_FETCH_TIMEOUT_MS, STALE_FLAG_MAX_AGE, SMART_RECALL_COOLDOWN, SMART_RECALL_MAX_CHARS, SMART_RECALL_MIN_MSG_LENGTH, SMART_RECALL_MIN_MATCH_SCORE, AUTO_EXTRACT_COOLDOWN, AUTO_EXTRACT_MIN_USER_MESSAGES, AUTO_EXTRACT_MIN_MSG_LENGTH, POST_TOOL_USE_MAX_FIELD_CHARS, POST_TOOL_USE_MAX_EVENTS, POST_TOOL_USE_SKIP_TOOLS } from './config.js';

// Helper: read session_id from stdin hook input.
// `prompt` is populated for UserPromptSubmit hooks (Claude Code passes the
// raw user prompt text alongside the standard fields). Other hook types
// leave it empty.
function readHookInput(): { session_id: string; transcript_path: string; cwd: string; prompt: string } {
  let stdinData = '';
  try {
    stdinData = readFileSync(0, 'utf-8');
  } catch {
    return { session_id: '', transcript_path: '', cwd: '', prompt: '' };
  }
  try {
    const input = JSON.parse(stdinData);
    return {
      session_id: input.session_id || '',
      transcript_path: input.transcript_path || '',
      cwd: input.cwd || '',
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
    };
  } catch {
    return { session_id: '', transcript_path: '', cwd: '', prompt: '' };
  }
}

// Flag file is per-session to avoid cross-terminal consumption
function flagPath(sessionId: string): string {
  // Sanitize session_id for filename safety
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return join(FLAG_DIR, `compacted-${safe || 'unknown'}`);
}

// Session marker — tracks whether context was already injected for this session
function sessionMarkerPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return join(FLAG_DIR, `session-${safe || 'unknown'}`);
}

// Topic index cache path for smart recall
function topicCachePath(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return join(FLAG_DIR, `topics-${safe}.json`);
}

// Detect project ID from git remote (for hook context)
function detectProjectIdForHook(cwd: string): string {
  try {
    const remote = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: cwd || undefined,
    }).trim();
    return remote
      .replace(/\.git$/, '')
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/^git@[^:]+:/, '');
  } catch {
    // Normalize to filesystem-canonical case on Windows so this matches what
    // the MCP tool-call path (detectProjectId) produces. Without realpathSync.native
    // the basename case tracks however the path was typed at the shell, which
    // diverges from the long-running MCP server's cached project_id.
    let resolved = cwd || process.cwd();
    try {
      // @ts-ignore — .native is present on Windows; regular realpathSync preserves input case
      resolved = (realpathSync as any).native ? (realpathSync as any).native(resolved) : realpathSync(resolved);
    } catch {
      // keep original if realpath fails
    }
    const parts = resolved.split(/[\\/]/);
    return parts[parts.length - 1] || 'unknown';
  }
}

// ── Resolve API Key ──────────────────────────────────────────
// Hooks run as shell commands outside the MCP server process,
// so COGMEMAI_API_KEY env var may not be set. Fall back to
// reading it from ~/.claude.json MCP server config.

function resolveApiKey(): string {
  const envKey = process.env.COGMEMAI_API_KEY || '';
  if (envKey) return envKey;

  try {
    const configPath = join(homedir(), '.claude.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const cogmemaiEnv = config?.mcpServers?.cogmemai?.env;
    if (cogmemaiEnv?.COGMEMAI_API_KEY) {
      return cogmemaiEnv.COGMEMAI_API_KEY;
    }
  } catch {
    // Can't read config — give up
  }

  return '';
}

/**
 * Fetch with timeout for hooks — never block Claude for more than HOOK_FETCH_TIMEOUT_MS.
 */
async function hookFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HOOK_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * POST JSON to a cogmemai hook endpoint. Returns true iff the server
 * responded 2xx. Non-2xx responses and thrown errors are logged to
 * errors.log with status + response body. Callers use the boolean return
 * to decide whether to fall back, retry, or skip flag writes.
 *
 * Replaces the old pattern of bare try/catch around hookFetch, which
 * silently discarded 4xx/5xx responses (fetch only throws on network
 * failure or timeout, not HTTP error status).
 */
async function hookPostJson(
  url: string,
  apiKey: string,
  body: unknown,
  hookName: string
): Promise<boolean> {
  try {
    const res = await hookFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let errBody = '';
      try { errBody = (await res.text()).slice(0, 500); } catch { /* body unreadable */ }
      logHookError(hookName, new Error(`HTTP ${res.status} from ${url} — ${errBody}`));
      return false;
    }
    return true;
  } catch (err) {
    logHookError(hookName, err);
    return false;
  }
}

/**
 * Clean up stale flag files in ~/.cogmemai/ older than STALE_FLAG_MAX_AGE.
 * Runs opportunistically during hooks — never fails loudly.
 */
function cleanStaleFlagFiles(): void {
  try {
    const files = readdirSync(FLAG_DIR);
    const now = Date.now();
    for (const file of files) {
      if (file === 'errors.log') continue; // Don't clean the error log
      const filePath = join(FLAG_DIR, file);
      try {
        const stat = statSync(filePath);
        if ((now - stat.mtimeMs) / 1000 > STALE_FLAG_MAX_AGE) {
          unlinkSync(filePath);
        }
      } catch { /* skip files we can't stat */ }
    }
  } catch { /* non-critical */ }
}

/**
 * Log hook errors to ~/.cogmemai/errors.log for debugging.
 * Keeps last ~100KB to prevent unbounded growth.
 */
function logHookError(hookName: string, error: unknown): void {
  try {
    mkdirSync(FLAG_DIR, { recursive: true });
    const logPath = join(FLAG_DIR, 'errors.log');
    const timestamp = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const entry = `[${timestamp}] ${hookName}: ${message}\n`;

    appendFileSync(logPath, entry);

    // Trim if > 100KB
    try {
      const stat = statSync(logPath);
      if (stat.size > 100 * 1024) {
        const content = readFileSync(logPath, 'utf-8');
        const lines = content.split('\n');
        const trimmed = lines.slice(Math.floor(lines.length / 2)).join('\n');
        writeFileSync(logPath, trimmed);
      }
    } catch { /* trim failure is non-critical */ }
  } catch { /* logging failure is non-critical */ }
}

// ── Colors (ANSI) ─────────────────────────────────────────────

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function log(msg: string) {
  console.log(msg);
}

function success(msg: string) {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}

function warn(msg: string) {
  console.log(`${YELLOW}⚠${RESET} ${msg}`);
}

function fail(msg: string) {
  console.log(`${RED}✗${RESET} ${msg}`);
}

// ── Helpers ───────────────────────────────────────────────────

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function verifyApiKey(apiKey: string): Promise<{ valid: boolean; data?: any; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/cogmemai/usage`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json();
    if (!res.ok) {
      return { valid: false, error: (data as any)?.error || `HTTP ${res.status}` };
    }
    return { valid: true, data };
  } catch (err: any) {
    return { valid: false, error: err.message || 'Connection failed' };
  }
}

async function saveVersionMemory(apiKey: string): Promise<void> {
  await hookPostJson(
    `${API_BASE}/cogmemai/store`,
    apiKey,
    {
      content: `CogmemAi MCP server v${VERSION} is installed with fetch timeouts, hook error logging, stale flag cleanup, and auto-session summaries.`,
      memory_type: 'dependency',
      category: 'tooling',
      subject: 'cogmemai_version',
      importance: 6,
      scope: 'global',
    },
    'setup-save-version'
  );
}

function isClaudeInstalled(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function configureClaudeCode(apiKey: string, mode?: string): { success: boolean; error?: string } {
  const envParts = [];
  if (apiKey) envParts.push(`-e COGMEMAI_API_KEY=${apiKey}`);
  if (mode && mode !== 'cloud') envParts.push(`-e COGMEMAI_MODE=${mode}`);
  const envStr = envParts.join(' ');

  try {
    execSync(
      `claude mcp add cogmemai cogmemai-mcp ${envStr} --scope user`,
      { stdio: 'pipe', timeout: 10000 }
    );
    return { success: true };
  } catch (err: any) {
    // If cogmemai already exists, remove and re-add
    try {
      execSync(`claude mcp remove cogmemai --scope user`, { stdio: 'pipe', timeout: 5000 });
      execSync(
        `claude mcp add cogmemai cogmemai-mcp ${envStr} --scope user`,
        { stdio: 'pipe', timeout: 10000 }
      );
      return { success: true };
    } catch (retryErr: any) {
      return { success: false, error: retryErr.message || 'Failed to configure' };
    }
  }
}

// ── Setup Command ─────────────────────────────────────────────

export async function runSetup(providedKey?: string): Promise<void> {
  log('');
  log(`${BOLD}${CYAN}  CogmemAi Setup${RESET}`);
  log(`${DIM}  Persistent memory for Ai coding assistants${RESET}`);
  log('');

  // Step 1: Choose storage mode
  log(`  ${BOLD}Step 1:${RESET} How would you like to use CogmemAi?`);
  log('');
  log(`  ${CYAN}1${RESET}  ${BOLD}Cloud${RESET} ${GREEN}(recommended)${RESET}`);
  log(`     Full Ai Intelligence Engine — semantic search, auto-linking,`);
  log(`     contradiction detection, auto-skills, team collaboration.`);
  log(`     Requires a free API key.`);
  log('');
  log(`  ${CYAN}2${RESET}  ${BOLD}Local only${RESET}`);
  log(`     Memory on your machine with full-text search.`);
  log(`     Requires a free account. Works offline after setup.`);
  log('');
  log(`  ${CYAN}3${RESET}  ${BOLD}Hybrid${RESET} ${DIM}(best of both)${RESET}`);
  log(`     Local speed + cloud intelligence. Saves everywhere,`);
  log(`     searches smart, falls back offline. Requires a free API key.`);
  log('');
  const modeChoice = await prompt(`  Choose (1/2/3): `);
  const modeMap: Record<string, string> = { '1': 'cloud', '2': 'local', '3': 'hybrid' };
  const selectedMode = modeMap[modeChoice.trim()] || 'cloud';

  log('');

  // Local mode: require free account, then configure locally
  if (selectedMode === 'local') {
    log(`  ${BOLD}Selected:${RESET} Local mode (SQLite on your machine)`);
    log('');
    log(`  ${DIM}A free account is required for all modes. Your data stays on your machine`);
    log(`  in local mode - the account just lets us know you're a real user.${RESET}`);
    log('');

    // Require API key for local mode
    log(`  ${BOLD}Step 2:${RESET} Enter your API key`);
    log(`  ${DIM}Get a free key at: https://hifriendbot.com/developer/${RESET}`);
    log('');
    let localApiKey = providedKey || '';
    if (!localApiKey) {
      localApiKey = await prompt(`  API Key (cm_...): `);
      localApiKey = localApiKey.trim();
    }

    if (!localApiKey || !localApiKey.startsWith('cm_')) {
      warn('Invalid API key. Get a free key at: https://hifriendbot.com/developer/');
      return;
    }

    // Validate the key against the server
    log(`  ${DIM}Validating...${RESET}`);
    try {
      const res = await fetch(`${API_BASE}/cogmemai/usage`, {
        headers: { 'Authorization': `Bearer ${localApiKey}` },
      });
      if (!res.ok) {
        warn('Invalid or inactive API key. Get a free key at: https://hifriendbot.com/developer/');
        return;
      }
      success('Account verified');
    } catch {
      warn('Could not reach server to validate key. Proceeding with local setup.');
      log(`  ${DIM}Your key will be validated on next online connection.${RESET}`);
    }
    log('');

    // Configure Claude Code for local mode (with API key stored for future cloud upgrade)
    log(`  ${BOLD}Step 3:${RESET} Configuring Claude Code (local mode)...`);

    if (!isClaudeInstalled()) {
      warn('Claude Code CLI not found in PATH.');
      log('');
      log(`  ${BOLD}Manual setup:${RESET}`);
      log(`  ${CYAN}claude mcp add cogmemai cogmemai-mcp -e COGMEMAI_MODE=local -e COGMEMAI_API_KEY=${localApiKey} --scope user${RESET}`);
      log('');
      log(`  Or add to your ${BOLD}.mcp.json${RESET}:`);
      log('');
      log(`  ${DIM}{`);
      log(`    "mcpServers": {`);
      log(`      "cogmemai": {`);
      log(`        "command": "npx",`);
      log(`        "args": ["-y", "cogmemai-mcp"],`);
      log(`        "env": { "COGMEMAI_MODE": "local", "COGMEMAI_API_KEY": "${localApiKey}" }`);
      log(`      }`);
      log(`    }`);
      log(`  }${RESET}`);
      log('');
      return;
    }

    const config = configureClaudeCode(localApiKey, 'local');
    if (!config.success) {
      warn(`Auto-configuration failed: ${config.error}`);
      log(`  ${BOLD}Run manually:${RESET}`);
      log(`  ${CYAN}claude mcp add cogmemai cogmemai-mcp -e COGMEMAI_MODE=local -e COGMEMAI_API_KEY=${localApiKey} --scope user${RESET}`);
      log('');
      return;
    }
    success('Claude Code configured for local mode');

    // Skip hooks and doc ingest for local mode, just configure CLAUDE.md
    log('');
    log(`  ${BOLD}Step 4:${RESET} Configuring auto-memory loading...`);
    const claudeMdResult = generateClaudeMd();
    if (claudeMdResult.success) {
      success('CLAUDE.md configured');
    }

    log('');
    log(`  ${GREEN}${BOLD}Setup complete!${RESET} Local mode is ready.`);
    log('');
    log(`  ${BOLD}Upgrade anytime:${RESET} Run ${CYAN}npx cogmemai-mcp setup${RESET} and choose Cloud or Hybrid.`);
    log(`  ${DIM}Free cloud tier: https://hifriendbot.com/developer/${RESET}`);
    log('');
    return;
  }

  // Cloud / Hybrid: need API key
  log(`  ${BOLD}Selected:${RESET} ${selectedMode === 'hybrid' ? 'Hybrid' : 'Cloud'} mode`);
  log('');

  // Step 2: Get API key
  let apiKey = providedKey || process.env.COGMEMAI_API_KEY || '';

  if (apiKey && apiKey.startsWith('cm_')) {
    log(`  Using API key: ${DIM}${apiKey.slice(0, 6)}...${apiKey.slice(-4)}${RESET}`);
  } else {
    log(`  ${BOLD}Step 2:${RESET} Enter your CogmemAi API key`);
    log(`  ${DIM}Get one free at https://hifriendbot.com/developer/${RESET}`);
    log('');
    apiKey = await prompt(`  API key (cm_...): `);
  }

  if (!apiKey || !apiKey.startsWith('cm_')) {
    log('');
    fail('Invalid API key. Keys start with "cm_".');
    log(`  Get your free key at: ${CYAN}https://hifriendbot.com/developer/${RESET}`);
    log('');
    process.exitCode = 1;
    return;
  }

  // Step 3: Verify the key
  log('');
  log(`  ${BOLD}Step 3:${RESET} Verifying API key...`);

  const result = await verifyApiKey(apiKey);

  if (!result.valid) {
    fail(`API key verification failed: ${result.error}`);
    log(`  Check your key at: ${CYAN}https://hifriendbot.com/developer/${RESET}`);
    log('');
    process.exitCode = 1;
    return;
  }

  success(`API key verified — ${BOLD}${result.data.tier_name}${RESET} tier`);
  log(`  ${DIM}Memories: ${result.data.memory_count}/${result.data.memory_limit} | Projects: ${result.data.project_count}/${result.data.project_limit}${RESET}`);

  // Step 4: Configure Claude Code
  log('');
  log(`  ${BOLD}Step 4:${RESET} Configuring Claude Code...`);

  if (!isClaudeInstalled()) {
    warn('Claude Code CLI not found in PATH.');
    log('');
    log(`  ${BOLD}Manual setup:${RESET}`);
    log(`  Run this command after installing Claude Code:`);
    log('');
    const envFlags = selectedMode === 'hybrid'
      ? `-e COGMEMAI_API_KEY=${apiKey} -e COGMEMAI_MODE=hybrid`
      : `-e COGMEMAI_API_KEY=${apiKey}`;
    log(`  ${CYAN}claude mcp add cogmemai cogmemai-mcp ${envFlags} --scope user${RESET}`);
    log('');
    const envJson = selectedMode === 'hybrid'
      ? `"COGMEMAI_API_KEY": "${apiKey}", "COGMEMAI_MODE": "hybrid"`
      : `"COGMEMAI_API_KEY": "${apiKey}"`;
    log(`  Or add to your ${BOLD}.mcp.json${RESET}:`);
    log('');
    log(`  ${DIM}{`);
    log(`    "mcpServers": {`);
    log(`      "cogmemai": {`);
    log(`        "command": "npx",`);
    log(`        "args": ["-y", "cogmemai-mcp"],`);
    log(`        "env": { ${envJson} }`);
    log(`      }`);
    log(`    }`);
    log(`  }${RESET}`);
    log('');
    return;
  }

  const config = configureClaudeCode(apiKey, selectedMode);

  if (!config.success) {
    warn(`Auto-configuration failed: ${config.error}`);
    log('');
    log(`  ${BOLD}Run manually:${RESET}`);
    log(`  ${CYAN}claude mcp add cogmemai cogmemai-mcp -e COGMEMAI_API_KEY=${apiKey} --scope user${RESET}`);
    log('');
    return;
  }

  success('Claude Code configured successfully');

  // Step 5: Configure compaction recovery hooks
  log('');
  log(`  ${BOLD}Step 5:${RESET} Enabling compaction recovery...`);

  const hookResult = configureHooks();
  if (hookResult.success) {
    success('Hooks installed (compaction recovery + auto-session-summary + autonomous event capture)');
    log(`  ${DIM}Context auto-saves before compaction, reloads after, and sessions save automatically${RESET}`);
  } else {
    warn(`Could not install hooks: ${hookResult.error}`);
    log(`  ${DIM}CogmemAi will still work, but auto-recovery and auto-summary won't be active${RESET}`);
  }

  // Sync the global binary so hooks (which invoke the bare `cogmemai-mcp`
  // command) run the same version as this setup script. Without this, users
  // who originally installed with `npm install -g` can end up with a stale
  // global binary that doesn't recognize hook subcommands added in later
  // versions (e.g. v3.15.0 added `posttooluse` — old globals fail silently).
  // Best-effort: if the install fails (permissions/network/missing npm), we
  // warn and tell the user the exact command to run. Never block setup.
  try {
    execSync('npm install -g cogmemai-mcp@latest', {
      stdio: 'pipe',
      timeout: 60000,
    });
    success(`Global binary synced to v${VERSION}`);
  } catch (err: any) {
    warn('Could not auto-sync global binary — hooks may run a stale version');
    log(`  ${DIM}Fix manually: ${CYAN}npm install -g cogmemai-mcp@latest${RESET}`);
  }

  // Step 6: Configure auto-memory loading via CLAUDE.md
  log('');
  log(`  ${BOLD}Step 6:${RESET} Configuring auto-memory loading...`);

  const claudeMdResult = generateClaudeMd();
  if (claudeMdResult.success) {
    success('CLAUDE.md configured — memories load automatically every session');
  } else {
    warn(`Could not configure CLAUDE.md: ${claudeMdResult.error}`);
    log(`  ${DIM}You can manually add memory instructions to ~/.claude/CLAUDE.md${RESET}`);
  }

  // Step 7: Offer document ingestion to seed project memory
  await offerDocumentIngest(apiKey);

  // Save version to memory
  await saveVersionMemory(apiKey);

  // Done!
  log('');
  log(`  ${GREEN}${BOLD}Setup complete!${RESET}`);
  log('');
  log(`  ${BOLD}Next:${RESET} Start Claude Code by typing ${CYAN}claude${RESET} and your memories are ready.`);
  log('');
  log(`  ${DIM}Dashboard: https://hifriendbot.com/developer/${RESET}`);
  log(`  ${DIM}Docs: https://hifriendbot.com/developer/#docs${RESET}`);
  log('');
}

// ── Verify Command ────────────────────────────────────────────

export async function runVerify(): Promise<void> {
  log('');
  log(`${BOLD}${CYAN}  CogmemAi Verify${RESET}`);
  log('');

  const apiKey = process.env.COGMEMAI_API_KEY || '';

  if (!apiKey) {
    fail('COGMEMAI_API_KEY environment variable not set.');
    log(`  Run ${CYAN}npx cogmemai-mcp setup${RESET} to configure.`);
    log('');
    process.exitCode = 1;
    return;
  }

  log(`  API key: ${DIM}${apiKey.slice(0, 6)}...${apiKey.slice(-4)}${RESET}`);
  log(`  Checking connection...`);
  log('');

  const result = await verifyApiKey(apiKey);

  if (!result.valid) {
    fail(`Connection failed: ${result.error}`);
    log('');
    process.exitCode = 1;
    return;
  }

  success('Connection OK');
  log('');
  log(`  ${BOLD}Tier:${RESET}         ${result.data.tier_name}`);
  log(`  ${BOLD}Memories:${RESET}     ${result.data.memory_count} / ${result.data.memory_limit}`);
  log(`  ${BOLD}Extractions:${RESET}  ${result.data.extractions_used} / ${result.data.extractions_limit} this month`);
  log(`  ${BOLD}Projects:${RESET}     ${result.data.project_count} / ${result.data.project_limit}`);
  log('');
}

// ── Hook: PreCompact ─────────────────────────────────────────

// Extract text from a message content field (string or content blocks array)
function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text || '')
      .join(' ');
  }
  return '';
}

// Extract file paths from tool_use blocks in a message
function extractFilePaths(content: any): string[] {
  if (!Array.isArray(content)) return [];
  const files: string[] = [];
  for (const block of content) {
    if (block.type === 'tool_use' && block.input) {
      if (block.input.file_path) files.push(block.input.file_path);
      else if (block.input.path) files.push(block.input.path);
    }
  }
  return files;
}

// Build a structured pre-compaction summary from the transcript
// Claude Code transcript JSONL format: each line has { type, message: { role, content } }
// type is "user"|"assistant"|"system"|"progress" etc.
// message.content is a string (user) or array of content blocks (assistant)
function buildCompactionSummary(transcriptPath: string, cwd: string): string {
  const raw = readFileSync(transcriptPath, 'utf-8');
  const lines = raw.trim().split('\n');

  // Helper: get role and content from a transcript entry
  const getMsg = (entry: any): { role: string; content: any } | null => {
    if (entry.message?.role && entry.message?.content !== undefined) {
      return { role: entry.message.role, content: entry.message.content };
    }
    // Fallback: direct role/content (e.g. other transcript formats)
    if (entry.role && entry.content !== undefined) {
      return { role: entry.role, content: entry.content };
    }
    return null;
  };

  // 1. Find the original task — first substantial user message
  let mainTask = '';
  for (let i = 0; i < Math.min(lines.length, 100); i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const msg = getMsg(entry);
      if (msg && msg.role === 'user') {
        const text = extractText(msg.content).trim();
        if (text.length > 30) {
          mainTask = text.length > 400 ? text.slice(0, 400) + '...' : text;
          break;
        }
      }
    } catch { /* skip */ }
  }

  // 2. Find the most recent substantial user request
  let lastRequest = '';
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 60); i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const msg = getMsg(entry);
      if (msg && msg.role === 'user') {
        const text = extractText(msg.content).trim();
        // Skip trivial replies like "yes", "ok", "do it", etc.
        if (text.length > 20) {
          lastRequest = text.length > 400 ? text.slice(0, 400) + '...' : text;
          break;
        }
      }
    } catch { /* skip */ }
  }

  // 3. Collect files worked on from tool_use blocks (last 150 lines)
  const filesInvolved = new Set<string>();
  for (let i = Math.max(0, lines.length - 150); i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const msg = getMsg(entry);
      if (msg) {
        for (const f of extractFilePaths(msg.content)) {
          filesInvolved.add(f);
        }
      }
    } catch { /* skip */ }
  }

  // 4. Get recent meaningful exchanges (last 40 lines, skip noise)
  const recentExchanges: string[] = [];
  for (let i = Math.max(0, lines.length - 40); i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const msg = getMsg(entry);
      if (msg && (msg.role === 'user' || msg.role === 'assistant')) {
        const text = extractText(msg.content).trim();
        if (text.length > 15) {
          const truncated = text.length > 200 ? text.slice(0, 200) + '...' : text;
          recentExchanges.push(`${msg.role}: ${truncated}`);
        }
      }
    } catch { /* skip */ }
  }

  // 5. Assemble structured summary
  const parts: string[] = [];
  parts.push(`Pre-compaction summary saved at ${new Date().toISOString()}`);
  parts.push(`Working directory: ${cwd || 'unknown'}`);

  if (mainTask) {
    parts.push(`\nOriginal task: ${mainTask}`);
  }

  if (lastRequest && lastRequest !== mainTask) {
    parts.push(`\nMost recent request: ${lastRequest}`);
  }

  if (filesInvolved.size > 0) {
    const fileList = Array.from(filesInvolved).slice(0, 15).join(', ');
    parts.push(`\nFiles worked on: ${fileList}`);
  }

  if (recentExchanges.length > 0) {
    parts.push(`\nRecent conversation:\n${recentExchanges.slice(-8).join('\n')}`);
  }

  return parts.join('\n');
}

export async function runHookPrecompact(): Promise<void> {
  try {
    const apiKey = resolveApiKey();
    if (!apiKey) return;

    const hookInput = readHookInput();
    const { transcript_path, cwd, session_id } = hookInput;

    // Build structured summary from the transcript
    let summary = '';
    if (transcript_path) {
      try {
        summary = buildCompactionSummary(transcript_path, cwd);
      } catch {
        // Can't read transcript — fall through to minimal summary
      }
    }

    if (!summary) {
      summary = `Context compacted at ${new Date().toISOString()}. Working directory: ${cwd || 'unknown'}.`;
    }

    // Truncate summary to 2000 chars max
    if (summary.length > 2000) {
      summary = summary.slice(0, 1997) + '...';
    }

    // Save session summary via API — check response.ok and fall back to
    // /cogmemai/store if the summary endpoint errors. See Stop hook for
    // the same pattern and rationale.
    let saved = await hookPostJson(
      `${API_BASE}/cogmemai/session-summary`,
      apiKey,
      { summary, project_id: detectProjectIdForHook(cwd) },
      'precompact-session-summary'
    );
    if (!saved) {
      saved = await hookPostJson(
        `${API_BASE}/cogmemai/store`,
        apiKey,
        {
          content: summary,
          memory_type: 'session_summary',
          category: 'general',
          subject: `Pre-Compact Summary ${new Date().toISOString().slice(0, 16)}`,
          importance: 7,
          scope: 'project',
          project_id: detectProjectIdForHook(cwd),
        },
        'precompact-session-summary-fallback'
      );
    }

    // Write session-specific flag file for context-reload hook
    mkdirSync(FLAG_DIR, { recursive: true });

    // Opportunistically clean up stale flag files
    cleanStaleFlagFiles();
    const flag = flagPath(session_id);
    writeFileSync(
      flag,
      JSON.stringify({
        timestamp: Math.floor(Date.now() / 1000),
        key_prefix: apiKey.slice(0, 8),
        session_id,
      })
    );

    // Reset session marker so context-reload reinjects after compaction
    const marker = sessionMarkerPath(session_id);
    try { unlinkSync(marker); } catch {}
  } catch (err) {
    logHookError('precompact', err);
    // Never fail — don't block compaction
  }
}

// ── Smart Recall Helpers ──────────────────────────────────────

// Stop words that don't indicate topic intent
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'it', 'in', 'on', 'to', 'for', 'and', 'or', 'but',
  'with', 'that', 'this', 'from', 'at', 'by', 'do', 'does', 'did', 'can',
  'could', 'would', 'should', 'will', 'have', 'has', 'had', 'been', 'being',
  'be', 'am', 'are', 'was', 'were', 'let', 'me', 'my', 'you', 'your', 'we',
  'our', 'they', 'their', 'he', 'she', 'his', 'her', 'its', 'what', 'which',
  'who', 'how', 'when', 'where', 'why', 'if', 'then', 'else', 'not', 'no',
  'yes', 'ok', 'okay', 'just', 'also', 'now', 'so', 'very', 'too', 'here',
  'there', 'all', 'any', 'some', 'every', 'each', 'these', 'those', 'of',
  'about', 'want', 'need', 'like', 'make', 'get', 'go', 'know', 'think',
  'see', 'look', 'use', 'try', 'tell', 'give', 'take', 'come', 'put', 'say',
  'thing', 'way', 'sure', 'right', 'well', 'really', 'going', 'still',
]);

// Extract keywords from user message for topic matching
function extractKeywords(message: string): string[] {
  const words = message.toLowerCase().split(/[\s.,;:!?()\[\]{}'"/\\@#$%^&*+=<>~`]+/);
  const keywords: string[] = [];
  for (const word of words) {
    const w = word.trim();
    if (w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)) {
      keywords.push(w);
    }
  }
  return [...new Set(keywords)];
}

// Match user keywords against cached topic index
// Returns matched topics sorted by relevance (match count * avg_importance)
function matchTopics(
  keywords: string[],
  topicIndex: Array<{ subject: string; keywords: string[]; count: number; avg_importance: number }>
): Array<{ subject: string; score: number }> {
  const matches: Array<{ subject: string; score: number }> = [];

  for (const topic of topicIndex) {
    let matchCount = 0;

    // Check if any keyword matches the subject name or prefix
    const subjectLower = topic.subject.toLowerCase();
    for (const kw of keywords) {
      if (subjectLower === kw || subjectLower.startsWith(kw + '_') || subjectLower.startsWith(kw + '-')) {
        matchCount += 2; // Strong signal: keyword matches subject directly
        break;
      }
    }

    for (const kw of keywords) {
      for (const topicKw of topic.keywords) {
        // Exact match or substring (e.g., "stripe" matches "stripe")
        if (kw === topicKw || topicKw.includes(kw) || kw.includes(topicKw)) {
          matchCount++;
          break; // Don't double-count same keyword
        }
      }
    }
    if (matchCount >= 1) {
      matches.push({
        subject: topic.subject,
        score: matchCount * topic.avg_importance,
      });
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score);
  return matches;
}

// Read the last user message from the transcript
function getLastUserMessage(transcriptPath: string): string {
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split('\n');

    // Search backwards for the most recent user message
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const role = entry.message?.role || entry.role;
        if (role === 'user') {
          const text = extractText(entry.message?.content || entry.content).trim();
          if (text.length > 10) {
            return text.length > 500 ? text.slice(0, 500) : text;
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* can't read transcript */ }
  return '';
}

// ── Hook: Context Reload ─────────────────────────────────────

export async function runHookContextReload(): Promise<void> {
  try {
    const hookInput = readHookInput();
    const sessionId = hookInput.session_id;

    // v3.17.0 — capture the user prompt FIRST, before any early-return paths.
    // The autonomous extractor at Stop time sees this alongside tool events,
    // closing the gap where preference-selection moments expressed in prose
    // (option picks, corrections, approvals) were invisible to the pipeline.
    captureUserMessageEvent(sessionId, hookInput.prompt);

    const compactionFlag = flagPath(sessionId);
    const marker = sessionMarkerPath(sessionId);

    // Priority 1: Post-compaction reload (compaction flag exists)
    const isPostCompaction = existsSync(compactionFlag);

    // Priority 2: New session detection (no session marker, or marker expired)
    let isNewSession = false;
    if (!isPostCompaction) {
      if (!existsSync(marker)) {
        isNewSession = true;
      } else {
        // Check marker freshness — if > 4 hours, treat as new session
        try {
          const markerData = JSON.parse(readFileSync(marker, 'utf-8'));
          const age = Math.floor(Date.now() / 1000) - markerData.timestamp;
          if (age > SESSION_EXPIRY_SECONDS) isNewSession = true;
        } catch {
          isNewSession = true;
        }
      }
    }

    // Fast exit: not post-compaction AND not new session → try smart recall
    if (!isPostCompaction && !isNewSession) {
      try {
        await trySmartRecall(hookInput, marker);
      } catch (err) {
        logHookError('smart-recall', err);
      }
      return;
    }

    const apiKey = resolveApiKey();
    if (!apiKey) {
      if (isPostCompaction) try { unlinkSync(compactionFlag); } catch {}
      return;
    }

    // Validate compaction flag freshness (< 1 hour)
    if (isPostCompaction) {
      try {
        const flagData = JSON.parse(readFileSync(compactionFlag, 'utf-8'));
        const age = Math.floor(Date.now() / 1000) - flagData.timestamp;
        if (age > COMPACTION_FLAG_MAX_AGE) {
          try { unlinkSync(compactionFlag); } catch {}
          if (!isNewSession) return;
        }
      } catch {
        try { unlinkSync(compactionFlag); } catch {}
        if (!isNewSession) return;
      }
    }

    // Fetch project context from API (limit to 20 memories for hook injection)
    const contextLimit = isPostCompaction ? 15 : 20;
    let res: Response;
    try {
      res = await hookFetch(`${API_BASE}/cogmemai/context?limit=${contextLimit}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      logHookError('context-reload', err);
      return;
    }

    // Clean up compaction flag
    if (isPostCompaction) {
      try { unlinkSync(compactionFlag); } catch {}
    }

    // Detect project ID for session tracking + smart recall
    const projectId = detectProjectIdForHook(hookInput.cwd);

    // Write/update session marker so subsequent messages skip injection
    mkdirSync(FLAG_DIR, { recursive: true });
    writeFileSync(marker, JSON.stringify({
      timestamp: Math.floor(Date.now() / 1000),
      session_id: sessionId,
      project_id: projectId,
      last_smart_recall: 0,
      last_smart_topics: [],
    }));

    if (!res.ok) {
      let errBody = '';
      try { errBody = (await res.text()).slice(0, 500); } catch { /* body unreadable */ }
      logHookError('context-reload', new Error(`HTTP ${res.status} from /cogmemai/context — ${errBody}`));
      return;
    }

    const data = await res.json() as {
      formatted_context?: string;
      total_count?: number;
      project_memories?: Array<{ content: string; subject: string; importance: number }>;
      global_memories?: Array<{ content: string; subject: string; importance: number }>;
      recalls_total?: number;
      last_session?: string | null;
      health_score?: { score: number; factors: string[] };
    };

    // Build context string
    let context = '';
    if (data.formatted_context) {
      context = data.formatted_context;
    } else {
      const parts: string[] = [];
      if (data.project_memories) {
        for (const m of data.project_memories) {
          parts.push(`- [${m.subject}] ${m.content}`);
        }
      }
      if (data.global_memories) {
        for (const m of data.global_memories) {
          parts.push(`- [${m.subject}] ${m.content}`);
        }
      }
      context = parts.join('\n');
    }

    // New project with no memories — suggest README ingestion
    if (!context || (data.total_count !== undefined && data.total_count === 0)) {
      // Check if README exists in cwd
      const readmeCandidates = ['README.md', 'readme.md', 'README.rst', 'README.txt'];
      let readmeFound = '';
      for (const name of readmeCandidates) {
        const readmePath = join(hookInput.cwd, name);
        if (existsSync(readmePath)) {
          readmeFound = name;
          break;
        }
      }

      if (readmeFound) {
        const output = JSON.stringify({
          result: 'success',
          additionalContext: `CogmemAi — New project detected with no memories yet. Found ${readmeFound} in the project root. Consider running ingest_document to quickly build project context from it. You can also save_memory to start building your knowledge base.`,
        });
        process.stdout.write(output);
      }
      return;
    }

    // Cap context size to prevent bloating the conversation after compaction
    const maxChars = isPostCompaction ? 4000 : 6000;
    if (context.length > maxChars) {
      context = context.slice(0, maxChars - 80) + '\n\n[Condensed — use recall_memories to search for specific past context]';
    }

    // Different label depending on trigger
    const label = isPostCompaction
      ? 'CogmemAi — Context recovered after compaction.'
      : 'CogmemAi — Project context loaded from previous sessions.';

    // Build session replay + stats footer
    const extras: string[] = [];

    if (data.last_session && !isPostCompaction) {
      extras.push(`\n**Last session:** ${data.last_session}`);
    }

    if (data.recalls_total && data.recalls_total > 0) {
      extras.push(`CogmemAi has surfaced memories ${data.recalls_total} times for you.`);
    }

    if (data.health_score) {
      const h = data.health_score;
      extras.push(`Memory health: ${h.score}/100${h.factors.length > 0 ? ' — ' + h.factors[0] : ''}`);
    }

    const statsLine = extras.length > 0 ? '\n\n' + extras.join(' | ') : '';
    const instruction = '\n\nIMPORTANT: Your memories are loaded above. Use recall_memories to search for specific past context. Save new learnings with save_memory.';

    const output = JSON.stringify({
      result: 'success',
      additionalContext: `${label} Your memories have been reloaded:\n\n${context}${statsLine}${instruction}`,
    });

    // Use console.log for reliable stdout flushing (adds newline, auto-flushes)
    console.log(output);
  } catch (err) {
    logHookError('context-reload', err);
    console.error(`CogmemAi hook error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
}

// ── SessionStart hook: one-shot context injection at session open ─────
//
// Fires exactly once when Claude Code starts/resumes/clears a session.
// Unlike UserPromptSubmit (which fires per-message and gates on a session
// marker), this event is unambiguous: it IS the session start. Injects
// top memories into Claude's initial context so they're present before
// Claude responds to the first user message — no tool call required.
//
// Leaves a session marker so the subsequent UserPromptSubmit hook sees
// a fresh marker and skips duplicate injection (falls into smart-recall
// branch for mid-session topic-aware recall). Post-compaction context
// recovery is still owned by UserPromptSubmit + the compaction flag —
// SessionStart does NOT fire after compaction.

export async function runHookSessionStart(): Promise<void> {
  try {
    const hookInput = readHookInput();
    const sessionId = hookInput.session_id;

    const apiKey = resolveApiKey();
    if (!apiKey) return;

    // Fetch project context (same limit as new-session branch of context-reload)
    const contextLimit = 20;
    let res: Response;
    try {
      res = await hookFetch(`${API_BASE}/cogmemai/context?limit=${contextLimit}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      logHookError('sessionstart', err);
      return;
    }

    // Write session marker so UserPromptSubmit skips re-injection on the
    // first user message (avoids double-loading the same context).
    const projectId = detectProjectIdForHook(hookInput.cwd);
    const marker = sessionMarkerPath(sessionId);
    try {
      mkdirSync(FLAG_DIR, { recursive: true });
      writeFileSync(marker, JSON.stringify({
        timestamp: Math.floor(Date.now() / 1000),
        session_id: sessionId,
        project_id: projectId,
        last_smart_recall: 0,
        last_smart_topics: [],
      }));
    } catch (err) {
      logHookError('sessionstart', err);
    }

    if (!res.ok) {
      let errBody = '';
      try { errBody = (await res.text()).slice(0, 500); } catch { /* body unreadable */ }
      logHookError('sessionstart', new Error(`HTTP ${res.status} from /cogmemai/context — ${errBody}`));
      return;
    }

    const data = await res.json() as {
      formatted_context?: string;
      total_count?: number;
      project_memories?: Array<{ content: string; subject: string; importance: number }>;
      global_memories?: Array<{ content: string; subject: string; importance: number }>;
      recalls_total?: number;
      last_session?: string | null;
      health_score?: { score: number; factors: string[] };
    };

    // Build context string — same format as context-reload's new-session branch
    let context = '';
    if (data.formatted_context) {
      context = data.formatted_context;
    } else {
      const parts: string[] = [];
      if (data.project_memories) {
        for (const m of data.project_memories) {
          parts.push(`- [${m.subject}] ${m.content}`);
        }
      }
      if (data.global_memories) {
        for (const m of data.global_memories) {
          parts.push(`- [${m.subject}] ${m.content}`);
        }
      }
      context = parts.join('\n');
    }

    // New project with no memories — suggest README ingestion
    if (!context || (data.total_count !== undefined && data.total_count === 0)) {
      const readmeCandidates = ['README.md', 'readme.md', 'README.rst', 'README.txt'];
      let readmeFound = '';
      for (const name of readmeCandidates) {
        const readmePath = join(hookInput.cwd, name);
        if (existsSync(readmePath)) {
          readmeFound = name;
          break;
        }
      }
      if (readmeFound) {
        const output = JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: `CogmemAi — New project detected with no memories yet. Found ${readmeFound} in the project root. Consider running ingest_document to quickly build project context from it. You can also save_memory to start building your knowledge base.`,
          },
        });
        console.log(output);
      }
      return;
    }

    // Cap context to prevent bloating the session's initial context
    const maxChars = 6000;
    if (context.length > maxChars) {
      context = context.slice(0, maxChars - 80) + '\n\n[Condensed — use recall_memories to search for specific past context]';
    }

    const extras: string[] = [];
    if (data.last_session) {
      extras.push(`\n**Last session:** ${data.last_session}`);
    }
    if (data.recalls_total && data.recalls_total > 0) {
      extras.push(`CogmemAi has surfaced memories ${data.recalls_total} times for you.`);
    }
    if (data.health_score) {
      const h = data.health_score;
      extras.push(`Memory health: ${h.score}/100${h.factors.length > 0 ? ' — ' + h.factors[0] : ''}`);
    }
    const statsLine = extras.length > 0 ? '\n\n' + extras.join(' | ') : '';
    const instruction = '\n\nIMPORTANT: Your memories are loaded above. Use recall_memories to search for specific past context. Save new learnings with save_memory.';

    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `CogmemAi — Project context loaded from previous sessions. Your memories have been reloaded:\n\n${context}${statsLine}${instruction}`,
      },
    });
    console.log(output);
  } catch (err) {
    logHookError('sessionstart', err);
    console.error(`CogmemAi hook error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Smart Recall: Proactive mid-session memory injection ─────

/**
 * Attempt smart recall — detect topic from user's message and inject
 * relevant memories if a topic shift is detected.
 *
 * This runs on the fast-exit path (existing session, no compaction).
 * It reads the user's latest message, matches against the cached topic
 * index, and if a new topic is detected, calls the lightweight
 * smart-recall endpoint for fast memory retrieval.
 */
async function trySmartRecall(
  hookInput: { session_id: string; transcript_path: string; cwd: string },
  markerPath: string
): Promise<void> {
  // Read marker data (has project_id, last_smart_recall, last_smart_topics)
  let markerData: {
    timestamp: number;
    session_id: string;
    project_id?: string;
    last_smart_recall?: number;
    last_smart_topics?: string[];
  };
  try {
    markerData = JSON.parse(readFileSync(markerPath, 'utf-8'));
  } catch {
    return; // Can't read marker — skip
  }

  // Check cooldown
  const now = Math.floor(Date.now() / 1000);
  const lastRecall = markerData.last_smart_recall || 0;
  if (now - lastRecall < SMART_RECALL_COOLDOWN) {
    return; // Too soon since last smart recall
  }

  // Get the user's latest message from transcript
  if (!hookInput.transcript_path) return;
  const userMessage = getLastUserMessage(hookInput.transcript_path);
  if (userMessage.length < SMART_RECALL_MIN_MSG_LENGTH) {
    return; // Message too short/trivial
  }

  // Extract keywords from user message
  const keywords = extractKeywords(userMessage);
  if (keywords.length < 2) {
    return; // Not enough meaningful keywords
  }

  // Get project ID (from marker or detect)
  const projectId = markerData.project_id || detectProjectIdForHook(hookInput.cwd);

  // Read topic index from cache
  const cachePath = topicCachePath(projectId);
  if (!existsSync(cachePath)) {
    return; // No topic index cached yet — skip until get_project_context is called
  }

  let topicCache: { timestamp: number; topics: Array<{ subject: string; keywords: string[]; count: number; avg_importance: number }> };
  try {
    topicCache = JSON.parse(readFileSync(cachePath, 'utf-8'));
  } catch {
    return; // Corrupt cache
  }

  // Check cache freshness (max 24 hours)
  if (now - topicCache.timestamp > 86400) {
    return; // Stale cache
  }

  // Match keywords against topic index
  const matches = matchTopics(keywords, topicCache.topics);
  if (matches.length === 0 || matches[0].score < SMART_RECALL_MIN_MATCH_SCORE) {
    return; // No meaningful topic match
  }

  // Check if these are new topics (not recently injected)
  const lastTopics = new Set(markerData.last_smart_topics || []);
  const newTopics = matches.filter(m => !lastTopics.has(m.subject));
  if (newTopics.length === 0) {
    return; // Same topics as last injection — skip
  }

  // We have a topic match! Call the smart-recall API
  const apiKey = resolveApiKey();
  if (!apiKey) return;

  let res: Response;
  try {
    res = await hookFetch(`${API_BASE}/cogmemai/smart-recall`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: userMessage.slice(0, 500),
        project_id: projectId,
        limit: 3,
      }),
    });
  } catch (err) {
    logHookError('smart-recall', err);
    return;
  }

  if (!res.ok) {
    let errBody = '';
    try { errBody = (await res.text()).slice(0, 500); } catch { /* body unreadable */ }
    logHookError('smart-recall', new Error(`HTTP ${res.status} from /cogmemai/smart-recall — ${errBody}`));
    return;
  }

  const data = await res.json() as {
    memories?: Array<{ id?: number; content: string; subject: string; importance: number; memory_type: string }>;
    matched_topics?: string[];
  };

  if (!data.memories || data.memories.length === 0) return;

  // Build injection text (with memory IDs for easy reference)
  const lines: string[] = [];
  for (const m of data.memories) {
    const label = m.memory_type || 'context';
    const idTag = m.id ? `[#${m.id}] ` : '';
    lines.push(`- ${idTag}[${label}] ${m.subject}: ${m.content}`);
  }

  let injection = lines.join('\n');
  if (injection.length > SMART_RECALL_MAX_CHARS) {
    injection = injection.slice(0, SMART_RECALL_MAX_CHARS - 40) + '\n[...use recall_memories for more]';
  }

  // Update session marker with smart recall tracking
  const injectedTopics = matches.slice(0, 5).map(m => m.subject);
  try {
    writeFileSync(markerPath, JSON.stringify({
      ...markerData,
      timestamp: markerData.timestamp, // Keep original timestamp (for session expiry)
      last_smart_recall: now,
      last_smart_topics: injectedTopics,
      project_id: projectId,
    }));
  } catch { /* non-critical */ }

  // Output the injection
  const topicNames = injectedTopics.slice(0, 3).join(', ');
  console.log(JSON.stringify({
    result: 'success',
    additionalContext: `CogmemAi — Relevant memories detected for: ${topicNames}\n\n${injection}\n\nThese memories were automatically surfaced based on the current topic. Use recall_memories for deeper searches.`,
  }));
}

// ── Auto-Extract: Learn from every session ───────────────────

// Global cooldown file (not per-session — protects extraction quota)
function extractCooldownPath(): string {
  return join(FLAG_DIR, 'last-extract');
}

/**
 * Build an extraction payload from the transcript's key exchanges.
 * Collects the most substantive user-assistant pairs and combines them.
 */
function buildExtractionPayload(transcriptPath: string): { userMessages: string; assistantResponses: string } | null {
  const raw = readFileSync(transcriptPath, 'utf-8');
  const lines = raw.trim().split('\n');

  const getMsg = (entry: any): { role: string; content: any } | null => {
    if (entry.message?.role && entry.message?.content !== undefined) {
      return { role: entry.message.role, content: entry.message.content };
    }
    if (entry.role && entry.content !== undefined) {
      return { role: entry.role, content: entry.content };
    }
    return null;
  };

  // Collect all meaningful messages
  const userTexts: string[] = [];
  const assistantTexts: string[] = [];
  let substantialUserCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const msg = getMsg(entry);
      if (!msg) continue;

      const text = extractText(msg.content).trim();
      if (text.length < 15) continue;

      if (msg.role === 'user') {
        if (text.length >= AUTO_EXTRACT_MIN_MSG_LENGTH) substantialUserCount++;
        userTexts.push(text.length > 600 ? text.slice(0, 600) + '...' : text);
      } else if (msg.role === 'assistant') {
        assistantTexts.push(text.length > 600 ? text.slice(0, 600) + '...' : text);
      }
    } catch { /* skip malformed */ }
  }

  // Need enough substance to be worth extracting
  if (substantialUserCount < AUTO_EXTRACT_MIN_USER_MESSAGES) {
    return null;
  }

  // Combine into payloads (keep within extract endpoint limits)
  let userCombined = userTexts.join('\n---\n');
  let assistantCombined = assistantTexts.join('\n---\n');

  if (userCombined.length > 3500) userCombined = userCombined.slice(0, 3497) + '...';
  if (assistantCombined.length > 3500) assistantCombined = assistantCombined.slice(0, 3497) + '...';

  return { userMessages: userCombined, assistantResponses: assistantCombined };
}

/**
 * Auto-extract learnings from the session transcript.
 * Called at session end (Stop hook) to capture facts worth remembering.
 */
async function autoExtractFromSession(
  transcriptPath: string,
  cwd: string,
  apiKey: string
): Promise<void> {
  // Check global cooldown (protect extraction quota)
  const cooldownFile = extractCooldownPath();
  const now = Math.floor(Date.now() / 1000);

  if (existsSync(cooldownFile)) {
    try {
      const data = JSON.parse(readFileSync(cooldownFile, 'utf-8'));
      if (now - data.timestamp < AUTO_EXTRACT_COOLDOWN) {
        return; // Too soon since last extraction
      }
    } catch { /* corrupt file — continue */ }
  }

  // Build extraction payload from transcript
  const payload = buildExtractionPayload(transcriptPath);
  if (!payload) return; // Not enough substance

  // Detect project ID for scoping
  const projectId = detectProjectIdForHook(cwd);

  // Call extract endpoint. Failures are logged (previously swallowed
  // silently, which hid extraction-endpoint outages for days).
  const ok = await hookPostJson(
    `${API_BASE}/cogmemai/extract`,
    apiKey,
    {
      user_message: payload.userMessages,
      assistant_response: payload.assistantResponses,
      project_id: projectId,
    },
    'auto-extract'
  );
  if (!ok) return;

  // Update cooldown (even if extract returned errors — avoid hammering)
  mkdirSync(FLAG_DIR, { recursive: true });
  writeFileSync(cooldownFile, JSON.stringify({ timestamp: now }));
}

// ── Hook: Stop (Auto Session Summary) ───────────────────────

function readStopHookInput(): {
  session_id: string;
  transcript_path: string;
  cwd: string;
  stop_hook_active: boolean;
  last_assistant_message: string;
} {
  let stdinData = '';
  try {
    stdinData = readFileSync(0, 'utf-8');
  } catch {
    return { session_id: '', transcript_path: '', cwd: '', stop_hook_active: false, last_assistant_message: '' };
  }
  try {
    const input = JSON.parse(stdinData);
    return {
      session_id: input.session_id || '',
      transcript_path: input.transcript_path || '',
      cwd: input.cwd || '',
      stop_hook_active: input.stop_hook_active === true,
      last_assistant_message: input.last_assistant_message || '',
    };
  } catch {
    return { session_id: '', transcript_path: '', cwd: '', stop_hook_active: false, last_assistant_message: '' };
  }
}

function summaryFlagPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return join(FLAG_DIR, `summary-${safe || 'unknown'}`);
}

function checkSessionSubstantial(transcriptPath: string): boolean {
  try {
    const raw = readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split('\n');

    if (lines.length < SUMMARY_CONFIG.minTranscriptLines) return false;

    let userMessageCount = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const role = entry.message?.role || entry.role;
        if (role === 'user') {
          const text = extractText(entry.message?.content || entry.content);
          if (text.trim().length > 10) userMessageCount++;
        }
      } catch { /* skip malformed lines */ }
    }

    return userMessageCount >= SUMMARY_CONFIG.minUserMessages;
  } catch {
    return false;
  }
}

function buildStopSummary(transcriptPath: string, cwd: string, lastMessage: string): string {
  const raw = readFileSync(transcriptPath, 'utf-8');
  const lines = raw.trim().split('\n');

  const getMsg = (entry: any): { role: string; content: any } | null => {
    if (entry.message?.role && entry.message?.content !== undefined) {
      return { role: entry.message.role, content: entry.message.content };
    }
    if (entry.role && entry.content !== undefined) {
      return { role: entry.role, content: entry.content };
    }
    return null;
  };

  // Find the original task
  let mainTask = '';
  for (let i = 0; i < Math.min(lines.length, 100); i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const msg = getMsg(entry);
      if (msg && msg.role === 'user') {
        const text = extractText(msg.content).trim();
        if (text.length > 30) {
          mainTask = text.length > 400 ? text.slice(0, 400) + '...' : text;
          break;
        }
      }
    } catch { /* skip */ }
  }

  // Collect files worked on
  const filesInvolved = new Set<string>();
  for (let i = Math.max(0, lines.length - 150); i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const msg = getMsg(entry);
      if (msg) {
        for (const f of extractFilePaths(msg.content)) {
          filesInvolved.add(f);
        }
      }
    } catch { /* skip */ }
  }

  // Build summary
  const parts: string[] = [];
  parts.push(`Session ended at ${new Date().toISOString()}`);
  parts.push(`Working directory: ${cwd || 'unknown'}`);

  if (mainTask) {
    parts.push(`\nTask: ${mainTask}`);
  }

  if (filesInvolved.size > 0) {
    const fileList = Array.from(filesInvolved).slice(0, 15).join(', ');
    parts.push(`\nFiles worked on: ${fileList}`);
  }

  if (lastMessage && lastMessage.length > 20) {
    const truncated = lastMessage.length > 500 ? lastMessage.slice(0, 500) + '...' : lastMessage;
    parts.push(`\nFinal response: ${truncated}`);
  }

  return parts.join('\n');
}

// ── PostToolUse hook: autonomous event capture (v3.15.0) ─────────
// Writes one JSONL line per tool call into a per-session events log.
// Events are flushed to /cogmemai/extract-events at session end by
// runHookStop, where server-side Haiku extracts structured memories
// without needing Claude to call save_memory. This is the mechanism
// that makes CogmemAi autonomous — saves happen even when Claude skips.

function eventsLogPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown';
  return join(FLAG_DIR, `events-${safe}.jsonl`);
}

// v3.17.0 — UserPromptSubmit autonomous capture.
// PostToolUse only sees tool calls, so preference-selection moments expressed
// in prose ("2", "no don't", "perfect, keep doing that") are invisible to the
// Stop-time extractor. This helper appends user-prompt text to the SAME events
// log, letting Haiku see the full conversation.
function captureUserMessageEvent(sessionId: string, prompt: string): void {
  try {
    if (!sessionId || !prompt) return;
    const text = prompt.trim();
    if (!text) return;

    mkdirSync(FLAG_DIR, { recursive: true });
    const path = eventsLogPath(sessionId);

    // Honor the same disk-cap as PostToolUse so a runaway session can't fill
    // the disk. Drop the message rather than rotate — older signal is more
    // valuable than newer signal in a runaway loop.
    try {
      if (existsSync(path)) {
        const stat = statSync(path);
        if (stat.size > POST_TOOL_USE_MAX_EVENTS * 1024) return;
      }
    } catch { /* best-effort */ }

    const record = {
      ts: new Date().toISOString(),
      type: 'user_message',
      text: truncateField(text),
    };
    appendFileSync(path, JSON.stringify(record) + '\n');
  } catch {
    // Never block Claude's prompt loop on hook failure
  }
}

function truncateField(val: unknown): string {
  try {
    const s = typeof val === 'string' ? val : JSON.stringify(val);
    if (!s) return '';
    return s.length > POST_TOOL_USE_MAX_FIELD_CHARS
      ? s.slice(0, POST_TOOL_USE_MAX_FIELD_CHARS) + '...[truncated]'
      : s;
  } catch {
    return '';
  }
}

// Redact tool inputs so the event log never stores large file contents.
// We keep structural info (paths, commands, patterns) but drop bodies.
function redactToolInput(toolName: string, input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  const out: Record<string, unknown> = {};
  // Whitelist of fields that carry signal without dumping bulk content:
  const safeFields = [
    'file_path', 'path', 'command', 'description', 'pattern', 'query',
    'url', 'subject', 'memory_type', 'category', 'importance',
    'glob', 'type', 'notebook_path', 'cell_id', 'cell_type',
    'old_string', 'new_string', // include edits so extraction sees the change
    'content',                   // Write — intentionally truncated below
  ];
  for (const k of safeFields) {
    if (k in input) out[k] = truncateField((input as Record<string, unknown>)[k]);
  }
  return out;
}

export async function runHookPostToolUse(): Promise<void> {
  try {
    let stdinData = '';
    try { stdinData = readFileSync(0, 'utf-8'); } catch { return; }
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(stdinData); } catch { return; }

    const toolName = String(parsed.tool_name || '');
    if (!toolName) return;
    if (POST_TOOL_USE_SKIP_TOOLS.has(toolName)) return;

    const sessionId = String(parsed.session_id || '');
    if (!sessionId) return;

    const record = {
      ts: new Date().toISOString(),
      tool: toolName,
      input: redactToolInput(toolName, parsed.tool_input as Record<string, unknown>),
    };

    mkdirSync(FLAG_DIR, { recursive: true });
    const path = eventsLogPath(sessionId);

    // Hard-cap the file so a runaway session can't fill the disk.
    try {
      if (existsSync(path)) {
        const stat = statSync(path);
        // ~500 bytes per event avg, cap ≈ 500 * 1024 bytes
        if (stat.size > POST_TOOL_USE_MAX_EVENTS * 1024) return;
      }
    } catch { /* best-effort */ }

    appendFileSync(path, JSON.stringify(record) + '\n');
  } catch {
    // Never block Claude's tool-use loop on hook failure
  }
}

/**
 * Flush a session's events log to /cogmemai/extract-events and delete the file.
 * Called by runHookStop before it saves the session summary. Fire-and-forget
 * for failures — logged to errors.log for debugging but never blocks.
 */
async function flushEventsLog(sessionId: string, projectId: string, apiKey: string): Promise<void> {
  const path = eventsLogPath(sessionId);
  if (!existsSync(path)) return;

  let events: unknown[] = [];
  try {
    const raw = readFileSync(path, 'utf-8');
    events = raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean) as unknown[];
  } catch {
    return;
  }

  if (events.length === 0) {
    try { unlinkSync(path); } catch { /* ignore */ }
    return;
  }

  const ok = await hookPostJson(
    `${API_BASE}/cogmemai/extract-events`,
    apiKey,
    { events, project_id: projectId, session_id: sessionId },
    'stop-extract-events'
  );

  // Always delete the log after flushing — we'd rather lose one batch than
  // re-send and create duplicate memories. Server dedups via content similarity
  // but avoiding the round trip saves cost.
  if (ok) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

// ── PostToolUse:Edit smart-nag hook (v3.19.0) ─────────────
// Replaces the static `echo` hook that nags on every Write|Edit. Applies
// heuristics so the agent only gets the "consider saving a memory" prompt
// when the edit looks substantive — not on version bumps, lockfile churn,
// build outputs, or hidden state .json files.
//
// Output: JSON nag on stdout when substantive, silent otherwise.

const SMART_NAG_OUTPUT = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext:
      'File was written/edited. If this change embodies a durable user preference, architecture decision, gotcha, bugfix, or cross-session pattern, call mcp__cogmemai__save_memory NOW (before ending the turn). Ephemeral task-progress edits do not need saving — but durable learnings MUST be saved proactively, not deferred.',
  },
});

function isVersionOnlyEdit(toolInput: Record<string, unknown> | undefined): boolean {
  if (!toolInput) return false;
  const oldStr = typeof toolInput.old_string === 'string' ? toolInput.old_string : '';
  const newStr = typeof toolInput.new_string === 'string' ? toolInput.new_string : '';
  if (!oldStr || !newStr) return false;
  // SemVer-only replace_all (e.g. bumping every "3.17.0" → "3.18.0")
  if (toolInput.replace_all && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(oldStr.trim()) && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newStr.trim())) {
    return true;
  }
  // Single "version": "..." line replace
  const versionLine = /^\s*"version"\s*:\s*"\d+\.\d+\.\d+(-[\w.]+)?"\s*,?\s*$/;
  if (versionLine.test(oldStr.trim()) && versionLine.test(newStr.trim()) && oldStr.length < 80 && newStr.length < 80) {
    return true;
  }
  return false;
}

function isTrivialEdit(filePath: string, toolInput: Record<string, unknown> | undefined): boolean {
  if (!filePath) return true;
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  const basename = norm.split('/').pop() || '';

  // Lockfiles — dependency churn, never a durable learning.
  if (/^(package-lock\.json|yarn\.lock|bun\.lockb?|pnpm-lock\.yaml|composer\.lock|cargo\.lock|gemfile\.lock|poetry\.lock|uv\.lock)$/i.test(basename)) {
    return true;
  }

  // Generated / build / vendor directories.
  if (/(^|\/)(node_modules|build|dist|\.next|\.nuxt|coverage|target|out|\.cache|\.turbo|\.parcel-cache|__pycache__|\.pytest_cache|venv|\.venv)\//.test(norm)) {
    return true;
  }

  // Logs, source maps, minified bundles.
  if (/\.(log|map|min\.js|min\.css|tsbuildinfo)$/i.test(basename)) {
    return true;
  }

  // Hidden state .json files at workspace root (e.g. .dev-page.json, .wp-resp.json).
  if (/^\.[^/]+\.(json|jsonl|yaml|yml)$/i.test(basename)) {
    return true;
  }

  // Version bumps in package.json / server.json / Cargo.toml.
  if (/^(package\.json|server\.json|cargo\.toml|pyproject\.toml)$/i.test(basename)) {
    if (isVersionOnlyEdit(toolInput)) return true;
  }

  return false;
}

export async function runHookPostToolUseEdit(): Promise<void> {
  let stdinData = '';
  try { stdinData = readFileSync(0, 'utf-8'); } catch { return; }
  if (!stdinData) return;

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(stdinData); } catch { return; }

  // Defensive: only nag for actual write tools, even though the matcher
  // should already constrain this to Write|Edit.
  const toolName = String(parsed.tool_name || '');
  if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(toolName)) return;

  const toolInput = (parsed.tool_input || {}) as Record<string, unknown>;
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';

  if (isTrivialEdit(filePath, toolInput)) return; // silent — no nag

  process.stdout.write(SMART_NAG_OUTPUT);
}

export async function runHookStop(): Promise<void> {
  const debugLog = (reason: string, extra: Record<string, unknown> = {}) => {
    try {
      mkdirSync(FLAG_DIR, { recursive: true });
      const entry = JSON.stringify({ ts: new Date().toISOString(), event: 'stop', reason, ...extra }) + '\n';
      appendFileSync(join(FLAG_DIR, 'hook-debug.log'), entry);
    } catch { /* never throw from debug */ }
  };

  try {
    const hookInput = readStopHookInput();
    debugLog('entered', {
      has_session_id: !!hookInput.session_id,
      has_transcript: !!hookInput.transcript_path,
      has_cwd: !!hookInput.cwd,
      cwd: hookInput.cwd || null,
      stop_hook_active: !!hookInput.stop_hook_active,
    });

    if (hookInput.stop_hook_active) { debugLog('early_return_stop_hook_active'); return; }

    const sessionId = hookInput.session_id;
    if (!sessionId) { debugLog('early_return_no_session_id'); return; }

    const flag = summaryFlagPath(sessionId);
    if (existsSync(flag)) {
      try {
        const flagData = JSON.parse(readFileSync(flag, 'utf-8'));
        const age = Math.floor(Date.now() / 1000) - flagData.timestamp;
        if (age < SUMMARY_CONFIG.cooldownSeconds) { debugLog('early_return_cooldown', { age }); return; }
      } catch { /* Corrupt flag — continue and save */ }
    }

    const { transcript_path } = hookInput;
    if (!transcript_path) { debugLog('early_return_no_transcript_path'); return; }

    const isSubstantial = checkSessionSubstantial(transcript_path);
    if (!isSubstantial) { debugLog('early_return_not_substantial', { transcript_path }); return; }

    const apiKey = resolveApiKey();
    if (!apiKey) { debugLog('early_return_no_api_key'); return; }

    let summary = '';
    try {
      summary = buildStopSummary(transcript_path, hookInput.cwd, hookInput.last_assistant_message);
    } catch (err) {
      debugLog('early_return_buildStopSummary_threw', { err: String(err) });
      return;
    }

    if (!summary || summary.length < 20) { debugLog('early_return_summary_too_short', { len: summary.length }); return; }

    const projectId = detectProjectIdForHook(hookInput.cwd);
    debugLog('will_post', { project_id: projectId, summary_len: summary.length });

    // Truncate
    if (summary.length > SUMMARY_CONFIG.maxSummaryChars) {
      summary = summary.slice(0, SUMMARY_CONFIG.maxSummaryChars - 3) + '...';
    }

    // v3.15.0 — Flush PostToolUse events for server-side extraction.
    // Runs before the session-summary save so any extracted memories
    // land first; failure here doesn't block the summary.
    try {
      await flushEventsLog(sessionId, projectId, apiKey);
    } catch (err) {
      debugLog('flush_events_threw', { err: String(err) });
    }

    // Save via session-summary API; if that fails, fall back to the proven
    // /cogmemai/store endpoint so the session still lands as a memory.
    // Previously this was fire-and-forget with silent failure — we then
    // wrote a success flag even when no memory was saved, producing the
    // "Stop hook fired but nothing saved" failure mode.
    let saved = await hookPostJson(
      `${API_BASE}/cogmemai/session-summary`,
      apiKey,
      { summary, project_id: projectId },
      'stop-session-summary'
    );

    if (!saved) {
      // Fallback: save as a regular memory via /cogmemai/store (proven-working endpoint).
      saved = await hookPostJson(
        `${API_BASE}/cogmemai/store`,
        apiKey,
        {
          content: summary,
          memory_type: 'session_summary',
          category: 'general',
          subject: `Session Summary ${new Date().toISOString().slice(0, 16)}`,
          importance: 7,
          scope: 'project',
          project_id: projectId,
        },
        'stop-session-summary-fallback'
      );
    }

    // Write flag only if we actually saved. Previously the flag was written
    // unconditionally, which meant a failed save would never retry — and
    // there was no way to tell a successful session from a silent failure.
    if (saved) {
      mkdirSync(FLAG_DIR, { recursive: true });
      writeFileSync(flag, JSON.stringify({
        timestamp: Math.floor(Date.now() / 1000),
        session_id: sessionId,
        saved: true,
      }));
    } else {
      logHookError('stop', new Error(`Both session-summary and fallback store failed for session ${sessionId}`));
    }

    // Auto-extract learnings from the session (separate from summary)
    try {
      await autoExtractFromSession(transcript_path, hookInput.cwd, apiKey);
    } catch (err) {
      logHookError('auto-extract', err);
    }

    // Save git snapshot for file-change tracking across sessions
    try {
      saveGitSnapshotForHook(hookInput.cwd);
    } catch (err) {
      logHookError('git-snapshot', err);
    }
  } catch (err) {
    logHookError('stop', err);
    // Never fail — don't interfere with Claude stopping
  }

  // Output empty JSON to allow Claude to stop
  console.log(JSON.stringify({}));
}

/**
 * Save git snapshot at session end for file-change tracking.
 */
function saveGitSnapshotForHook(cwd: string): void {
  const projectId = detectProjectIdForHook(cwd);
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const snapshotPath = join(FLAG_DIR, `git-snapshot-${safe}.json`);

  let branch = '';
  let commit = '';
  const execOpts = { encoding: 'utf-8' as const, timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], cwd: cwd || undefined };

  try {
    branch = execSync('git branch --show-current', execOpts).trim();
  } catch { /* not a git repo */ }

  try {
    commit = execSync('git rev-parse HEAD', execOpts).trim();
  } catch { /* no commits */ }

  if (branch || commit) {
    mkdirSync(FLAG_DIR, { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify({
      branch,
      commit,
      timestamp: Math.floor(Date.now() / 1000),
    }));
  }
}

// ── Auto-Ingest Documents ────────────────────────────────────

async function offerDocumentIngest(apiKey: string): Promise<void> {
  const cwd = process.cwd();
  const candidates: Array<{ path: string; name: string; type: string }> = [];

  const claudeMd = join(cwd, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    candidates.push({ path: claudeMd, name: 'CLAUDE.md', type: 'architecture' });
  }

  const readmeMd = join(cwd, 'README.md');
  const readmeLower = join(cwd, 'readme.md');
  if (existsSync(readmeMd)) {
    candidates.push({ path: readmeMd, name: 'README.md', type: 'readme' });
  } else if (existsSync(readmeLower)) {
    candidates.push({ path: readmeLower, name: 'readme.md', type: 'readme' });
  }

  if (candidates.length === 0) return;

  log('');
  log(`  ${BOLD}Step 7:${RESET} Seed project memory`);
  log(`  ${DIM}Found ${candidates.map(c => c.name).join(' and ')} in current directory${RESET}`);

  const answer = await prompt(`  Ingest to seed memory? (Y/n): `);
  if (answer.toLowerCase() === 'n') {
    log(`  ${DIM}Skipped. You can ingest later with the ingest_document tool.${RESET}`);
    return;
  }

  for (const candidate of candidates) {
    try {
      let text = readFileSync(candidate.path, 'utf-8');
      if (text.length > 50000) text = text.slice(0, 50000);
      if (text.length < 20) {
        log(`  ${DIM}${candidate.name} too short, skipping${RESET}`);
        continue;
      }

      log(`  Ingesting ${candidate.name}...`);

      const res = await fetch(`${API_BASE}/cogmemai/ingest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text, document_type: candidate.type }),
      });

      if (res.ok) {
        const data = await res.json() as { extracted?: number };
        success(`${candidate.name}: ${data.extracted || 0} memories extracted`);
      } else {
        warn(`${candidate.name}: ingestion failed (HTTP ${res.status})`);
      }
    } catch (err: any) {
      warn(`${candidate.name}: ${err.message || 'read error'}`);
    }
  }
}

// ── Generate CLAUDE.md ───────────────────────────────────

function generateClaudeMd(): { success: boolean; error?: string } {
  try {
    const claudeDir = join(homedir(), '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const claudeMdPath = join(claudeDir, 'CLAUDE.md');

    const cogmemaiSection = `# CogmemAi Memory

You have persistent memory powered by CogmemAi. At the start of EVERY conversation, you MUST call the \`get_project_context\` MCP tool before responding to any message — even simple greetings. This loads your memories from previous sessions and is critical for continuity. Never skip this step.
`;

    // Check if file exists and already has CogmemAi section
    if (existsSync(claudeMdPath)) {
      const existing = readFileSync(claudeMdPath, 'utf-8');
      if (existing.includes('CogmemAi Memory')) {
        // Already has our section — update it
        const updated = existing.replace(
          /# CogmemAi Memory[\s\S]*?(?=\n#\s|\n*$)/,
          cogmemaiSection.trim()
        );
        writeFileSync(claudeMdPath, updated);
        return { success: true };
      }
      // Append our section
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      writeFileSync(claudeMdPath, existing + separator + cogmemaiSection);
    } else {
      writeFileSync(claudeMdPath, cogmemaiSection);
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to create CLAUDE.md' };
  }
}

// ── Configure Hooks ──────────────────────────────────────────

export function configureHooks(): { success: boolean; error?: string } {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json');

    // Read existing settings or start fresh
    let settings: Record<string, any> = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      // File doesn't exist or invalid JSON — start fresh
    }

    // Ensure hooks object exists
    if (!settings.hooks) {
      settings.hooks = {};
    }

    // Helper: check if a cogmemai hook already exists in a hook array
    const hasCogmemaiHook = (hookArray: any[], command: string): boolean => {
      if (!Array.isArray(hookArray)) return false;
      return hookArray.some(
        (entry: any) =>
          Array.isArray(entry.hooks) &&
          entry.hooks.some((h: any) => typeof h.command === 'string' && h.command.includes(command))
      );
    };

    // Add PreCompact hook
    if (!settings.hooks.PreCompact) {
      settings.hooks.PreCompact = [];
    }
    if (!hasCogmemaiHook(settings.hooks.PreCompact, 'cogmemai-mcp hook precompact')) {
      settings.hooks.PreCompact.push({
        hooks: [
          {
            type: 'command',
            command: 'cogmemai-mcp hook precompact',
            timeout: 15,
          },
        ],
      });
    }

    // Add UserPromptSubmit hook
    if (!settings.hooks.UserPromptSubmit) {
      settings.hooks.UserPromptSubmit = [];
    }
    if (!hasCogmemaiHook(settings.hooks.UserPromptSubmit, 'cogmemai-mcp hook context-reload')) {
      settings.hooks.UserPromptSubmit.push({
        hooks: [
          {
            type: 'command',
            command: 'cogmemai-mcp hook context-reload',
            timeout: 10,
          },
        ],
      });
    }

    // Add Stop hook (auto-session-summary)
    if (!settings.hooks.Stop) {
      settings.hooks.Stop = [];
    }
    if (!hasCogmemaiHook(settings.hooks.Stop, 'cogmemai-mcp hook stop')) {
      settings.hooks.Stop.push({
        hooks: [
          {
            type: 'command',
            command: 'cogmemai-mcp hook stop',
            timeout: SUMMARY_CONFIG.hookTimeoutSeconds,
          },
        ],
      });
    }

    // v3.15.0 — PostToolUse hook (autonomous event capture for server-side extraction)
    // Fires after every tool call; appends a compact event record to the
    // session's events log. The Stop hook flushes the log to the server.
    if (!settings.hooks.PostToolUse) {
      settings.hooks.PostToolUse = [];
    }
    if (!hasCogmemaiHook(settings.hooks.PostToolUse, 'cogmemai-mcp hook posttooluse')) {
      settings.hooks.PostToolUse.push({
        hooks: [
          {
            type: 'command',
            command: 'cogmemai-mcp hook posttooluse',
            timeout: 3,
          },
        ],
      });
    }

    // v3.19.0 — Smart-nag PostToolUse:Edit hook. Replaces a static `echo` that
    // fired on every Write/Edit and asked the agent to consider saving a
    // memory. Now applies heuristics: skip lockfiles, build outputs, version
    // bumps, hidden state .json files. Only nags on substantive edits.
    if (!hasCogmemaiHook(settings.hooks.PostToolUse, 'cogmemai-mcp hook posttooluse-edit')) {
      settings.hooks.PostToolUse.push({
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [
          {
            type: 'command',
            command: 'cogmemai-mcp hook posttooluse-edit',
            timeout: 5,
          },
        ],
      });
    }

    // v3.16.0 — SessionStart hook (guaranteed one-shot context injection).
    // Fires exactly once when Claude Code starts/resumes/clears a session,
    // regardless of whether the agent thinks to call get_project_context.
    // This is the parity feature with file-based auto-memory: memories are
    // present in Claude's initial context before it responds to anything.
    if (!settings.hooks.SessionStart) {
      settings.hooks.SessionStart = [];
    }
    if (!hasCogmemaiHook(settings.hooks.SessionStart, 'cogmemai-mcp hook sessionstart')) {
      settings.hooks.SessionStart.push({
        hooks: [
          {
            type: 'command',
            command: 'cogmemai-mcp hook sessionstart',
            timeout: 10,
          },
        ],
      });
    }

    // Create ~/.cogmemai/ directory
    mkdirSync(FLAG_DIR, { recursive: true });

    // Write settings back
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to configure hooks' };
  }
}

// ── Help ──────────────────────────────────────────────────────

export function showHelp(): void {
  log('');
  log(`${BOLD}${CYAN}  CogmemAi${RESET} — Persistent memory for Ai coding assistants`);
  log('');
  log(`  ${BOLD}Usage:${RESET}`);
  log(`    npx cogmemai-mcp setup [key]    Set up CogmemAi for Claude Code`);
  log(`    npx cogmemai-mcp verify         Verify your API key and connection`);
  log(`    npx cogmemai-mcp help           Show this help message`);
  log('');
  log(`  ${BOLD}As MCP server:${RESET}`);
  log(`    cogmemai-mcp                    Start MCP server (stdio transport)`);
  log('');
  log(`  ${BOLD}Hooks:${RESET}`);
  log(`    cogmemai-mcp hook sessionstart   Inject top memories at session open (v3.16+)`);
  log(`    cogmemai-mcp hook precompact     Save context before compaction`);
  log(`    cogmemai-mcp hook context-reload Reload context after compaction / smart recall`);
  log(`    cogmemai-mcp hook posttooluse    Capture tool events for autonomous memory`);
  log(`    cogmemai-mcp hook stop           Auto-save session summary on exit`);
  log('');
  log(`  ${BOLD}Get started:${RESET}`);
  log(`    1. Get a free API key at ${CYAN}https://hifriendbot.com/developer/${RESET}`);
  log(`    2. Run ${CYAN}npx cogmemai-mcp setup${RESET}`);
  log(`    3. Restart Claude Code`);
  log('');
  log(`  ${BOLD}Links:${RESET}`);
  log(`    Dashboard:  ${CYAN}https://hifriendbot.com/developer/${RESET}`);
  log(`    npm:        ${CYAN}https://www.npmjs.com/package/cogmemai-mcp${RESET}`);
  log(`    GitHub:     ${CYAN}https://github.com/hifriendbot/cogmemai-mcp${RESET}`);
  log('');
}
