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
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const API_BASE = 'https://hifriendbot.com/wp-json/hifriendbot/v1';
const VERSION = '2.2.0';

const FLAG_DIR = join(homedir(), '.cogmemai');

// Helper: read session_id from stdin hook input
function readHookInput(): { session_id: string; transcript_path: string; cwd: string } {
  let stdinData = '';
  try {
    stdinData = readFileSync(0, 'utf-8');
  } catch {
    return { session_id: '', transcript_path: '', cwd: '' };
  }
  try {
    const input = JSON.parse(stdinData);
    return {
      session_id: input.session_id || '',
      transcript_path: input.transcript_path || '',
      cwd: input.cwd || '',
    };
  } catch {
    return { session_id: '', transcript_path: '', cwd: '' };
  }
}

// Flag file is per-session to avoid cross-terminal consumption
function flagPath(sessionId: string): string {
  // Sanitize session_id for filename safety
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return join(FLAG_DIR, `compacted-${safe || 'unknown'}`);
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
  try {
    await fetch(`${API_BASE}/cogmemai/store`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: `CogmemAi MCP server v${VERSION} is installed. This is the latest version.`,
        memory_type: 'dependency',
        category: 'tooling',
        subject: 'cogmemai_version',
        importance: 6,
        scope: 'global',
      }),
    });
  } catch {
    // Non-critical — don't fail setup if this doesn't work
  }
}

function isClaudeInstalled(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function configureClaudeCode(apiKey: string): { success: boolean; error?: string } {
  try {
    execSync(
      `claude mcp add cogmemai cogmemai-mcp -e COGMEMAI_API_KEY=${apiKey} --scope user`,
      { stdio: 'pipe', timeout: 10000 }
    );
    return { success: true };
  } catch (err: any) {
    // If cogmemai already exists, remove and re-add
    try {
      execSync(`claude mcp remove cogmemai --scope user`, { stdio: 'pipe', timeout: 5000 });
      execSync(
        `claude mcp add cogmemai cogmemai-mcp -e COGMEMAI_API_KEY=${apiKey} --scope user`,
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

  // Step 1: Get API key
  let apiKey = providedKey || process.env.COGMEMAI_API_KEY || '';

  if (apiKey && apiKey.startsWith('cm_')) {
    log(`  Using API key: ${DIM}${apiKey.slice(0, 6)}...${apiKey.slice(-4)}${RESET}`);
  } else {
    log(`  ${BOLD}Step 1:${RESET} Enter your CogmemAi API key`);
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

  // Step 2: Verify the key
  log('');
  log(`  ${BOLD}Step 2:${RESET} Verifying API key...`);

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

  // Step 3: Configure Claude Code
  log('');
  log(`  ${BOLD}Step 3:${RESET} Configuring Claude Code...`);

  if (!isClaudeInstalled()) {
    warn('Claude Code CLI not found in PATH.');
    log('');
    log(`  ${BOLD}Manual setup:${RESET}`);
    log(`  Run this command after installing Claude Code:`);
    log('');
    log(`  ${CYAN}claude mcp add cogmemai cogmemai-mcp -e COGMEMAI_API_KEY=${apiKey} --scope user${RESET}`);
    log('');
    log(`  Or add to your ${BOLD}.mcp.json${RESET}:`);
    log('');
    log(`  ${DIM}{`);
    log(`    "mcpServers": {`);
    log(`      "cogmemai": {`);
    log(`        "command": "npx",`);
    log(`        "args": ["-y", "cogmemai-mcp"],`);
    log(`        "env": { "COGMEMAI_API_KEY": "${apiKey}" }`);
    log(`      }`);
    log(`    }`);
    log(`  }${RESET}`);
    log('');
    return;
  }

  const config = configureClaudeCode(apiKey);

  if (!config.success) {
    warn(`Auto-configuration failed: ${config.error}`);
    log('');
    log(`  ${BOLD}Run manually:${RESET}`);
    log(`  ${CYAN}claude mcp add cogmemai cogmemai-mcp -e COGMEMAI_API_KEY=${apiKey} --scope user${RESET}`);
    log('');
    return;
  }

  success('Claude Code configured successfully');

  // Step 4: Configure compaction recovery hooks
  log('');
  log(`  ${BOLD}Step 4:${RESET} Enabling compaction recovery...`);

  const hookResult = configureHooks();
  if (hookResult.success) {
    success('Compaction recovery hooks installed');
    log(`  ${DIM}Context auto-saves before compaction and reloads after${RESET}`);
  } else {
    warn(`Could not install hooks: ${hookResult.error}`);
    log(`  ${DIM}CogmemAi will still work, but context won't auto-recover after compaction${RESET}`);
  }

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

export async function runHookPrecompact(): Promise<void> {
  try {
    const apiKey = resolveApiKey();
    if (!apiKey) return;

    const hookInput = readHookInput();
    const transcriptPath = hookInput.transcript_path;
    const cwd = hookInput.cwd;
    const sessionId = hookInput.session_id;

    // Build a summary from the transcript if available
    let summary = '';
    if (transcriptPath) {
      try {
        const raw = readFileSync(transcriptPath, 'utf-8');
        const lines = raw.trim().split('\n');
        const recent: string[] = [];

        // Extract last ~20 meaningful messages
        for (let i = Math.max(0, lines.length - 40); i < lines.length; i++) {
          try {
            const entry = JSON.parse(lines[i]);
            if (entry.role === 'user' || entry.role === 'assistant') {
              const text =
                typeof entry.content === 'string'
                  ? entry.content
                  : Array.isArray(entry.content)
                    ? entry.content
                        .filter((b: any) => b.type === 'text')
                        .map((b: any) => b.text)
                        .join(' ')
                    : '';
              if (text && text.length > 5) {
                // Truncate long messages
                recent.push(
                  `${entry.role}: ${text.length > 200 ? text.slice(0, 200) + '...' : text}`
                );
              }
            }
          } catch {
            // Skip unparseable lines
          }
        }

        if (recent.length > 0) {
          // Keep last 20
          const last20 = recent.slice(-20);
          summary = `Auto-saved before context compaction. Working directory: ${cwd || 'unknown'}. Recent conversation:\n${last20.join('\n')}`;
        }
      } catch {
        // Can't read transcript — save a minimal summary
      }
    }

    if (!summary) {
      summary = `Context compacted at ${new Date().toISOString()}. Working directory: ${cwd || 'unknown'}.`;
    }

    // Truncate summary to 2000 chars max
    if (summary.length > 2000) {
      summary = summary.slice(0, 1997) + '...';
    }

    // Save session summary via API
    try {
      await fetch(`${API_BASE}/cogmemai/session-summary`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ summary }),
      });
    } catch {
      // Non-critical
    }

    // Write session-specific flag file for context-reload hook
    mkdirSync(FLAG_DIR, { recursive: true });
    const flag = flagPath(sessionId);
    writeFileSync(
      flag,
      JSON.stringify({
        timestamp: Math.floor(Date.now() / 1000),
        key_prefix: apiKey.slice(0, 8),
        session_id: sessionId,
      })
    );
  } catch {
    // Never fail — don't block compaction
  }
}

// ── Hook: Context Reload ─────────────────────────────────────

export async function runHookContextReload(): Promise<void> {
  try {
    // Read session_id from stdin to find the matching flag
    const hookInput = readHookInput();
    const sessionId = hookInput.session_id;
    const flag_file = flagPath(sessionId);

    // Fast exit if no flag file for this session
    if (!existsSync(flag_file)) return;

    const apiKey = resolveApiKey();
    if (!apiKey) {
      // No key — clean up flag and exit
      try { unlinkSync(flag_file); } catch {}
      return;
    }

    // Check flag freshness (< 1 hour)
    let flagData: { timestamp: number; key_prefix: string; session_id: string };
    try {
      flagData = JSON.parse(readFileSync(flag_file, 'utf-8'));
    } catch {
      try { unlinkSync(flag_file); } catch {}
      return;
    }

    const age = Math.floor(Date.now() / 1000) - flagData.timestamp;
    if (age > 3600) {
      // Stale flag — delete without action
      try { unlinkSync(flag_file); } catch {}
      return;
    }

    // Fetch project context from API
    const res = await fetch(`${API_BASE}/cogmemai/context`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    // Delete flag regardless of API result
    try { unlinkSync(flag_file); } catch {}

    if (!res.ok) return;

    const data = await res.json() as {
      formatted_context?: string;
      project_memories?: Array<{ content: string; subject: string; importance: number }>;
      global_memories?: Array<{ content: string; subject: string; importance: number }>;
    };

    // Build context string
    let context = '';
    if (data.formatted_context) {
      context = data.formatted_context;
    } else {
      // Fallback: build from raw memories
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

    if (!context) return;

    // Output as additionalContext JSON — Claude Code injects this into conversation
    const output = JSON.stringify({
      additionalContext: `CogmemAi — Context recovered after compaction. Your memories have been reloaded:\n\n${context}`,
    });
    process.stdout.write(output);
  } catch {
    // Never fail — don't break user's message flow
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
