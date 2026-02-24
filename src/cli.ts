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
import { API_BASE, VERSION, FLAG_DIR, SESSION_EXPIRY_SECONDS, COMPACTION_FLAG_MAX_AGE, SUMMARY_CONFIG } from './config.js';

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

// Session marker — tracks whether context was already injected for this session
function sessionMarkerPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return join(FLAG_DIR, `session-${safe || 'unknown'}`);
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
    success('Hooks installed (compaction recovery + auto-session-summary)');
    log(`  ${DIM}Context auto-saves before compaction, reloads after, and sessions save automatically${RESET}`);
  } else {
    warn(`Could not install hooks: ${hookResult.error}`);
    log(`  ${DIM}CogmemAi will still work, but auto-recovery and auto-summary won't be active${RESET}`);
  }

  // Step 5: Configure auto-memory loading via CLAUDE.md
  log('');
  log(`  ${BOLD}Step 5:${RESET} Configuring auto-memory loading...`);

  const claudeMdResult = generateClaudeMd();
  if (claudeMdResult.success) {
    success('CLAUDE.md configured — memories load automatically every session');
  } else {
    warn(`Could not configure CLAUDE.md: ${claudeMdResult.error}`);
    log(`  ${DIM}You can manually add memory instructions to ~/.claude/CLAUDE.md${RESET}`);
  }

  // Step 6: Offer document ingestion to seed project memory
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
  } catch {
    // Never fail — don't block compaction
  }
}

// ── Hook: Context Reload ─────────────────────────────────────

export async function runHookContextReload(): Promise<void> {
  try {
    const hookInput = readHookInput();
    const sessionId = hookInput.session_id;
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

    // Fast exit: not post-compaction AND not new session
    if (!isPostCompaction && !isNewSession) {
      // Opt-in recall hint for existing sessions
      if (process.env.COGMEMAI_RECALL_HINT === '1' && existsSync(marker)) {
        console.log(JSON.stringify({
          result: 'success',
          additionalContext: 'CogmemAi: You have persistent memory. If this task involves past context, use recall_memories to search for relevant memories.',
        }));
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
    const res = await fetch(`${API_BASE}/cogmemai/context?limit=${contextLimit}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    // Clean up compaction flag
    if (isPostCompaction) {
      try { unlinkSync(compactionFlag); } catch {}
    }

    // Write/update session marker so subsequent messages skip injection
    mkdirSync(FLAG_DIR, { recursive: true });
    writeFileSync(marker, JSON.stringify({
      timestamp: Math.floor(Date.now() / 1000),
      session_id: sessionId,
    }));

    if (!res.ok) return;

    const data = await res.json() as {
      formatted_context?: string;
      total_count?: number;
      project_memories?: Array<{ content: string; subject: string; importance: number }>;
      global_memories?: Array<{ content: string; subject: string; importance: number }>;
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

    if (!context || (data.total_count !== undefined && data.total_count === 0)) return;

    // Cap context size to prevent bloating the conversation after compaction
    const maxChars = isPostCompaction ? 4000 : 6000;
    if (context.length > maxChars) {
      context = context.slice(0, maxChars - 80) + '\n\n[Condensed — use recall_memories to search for specific past context]';
    }

    // Different label depending on trigger
    const label = isPostCompaction
      ? 'CogmemAi — Context recovered after compaction.'
      : 'CogmemAi — Project context loaded from previous sessions.';

    const instruction = '\n\nIMPORTANT: Your memories are loaded above. Use recall_memories to search for specific past context. Save new learnings with save_memory.';

    const output = JSON.stringify({
      result: 'success',
      additionalContext: `${label} Your memories have been reloaded:\n\n${context}${instruction}`,
    });

    // Use console.log for reliable stdout flushing (adds newline, auto-flushes)
    console.log(output);
  } catch (err) {
    // Log errors to stderr for debugging (never to stdout)
    console.error(`CogmemAi hook error: ${err instanceof Error ? err.message : String(err)}`);
  }
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

export async function runHookStop(): Promise<void> {
  try {
    const hookInput = readStopHookInput();

    // CRITICAL: If stop_hook_active is true, a previous Stop hook already ran.
    // Exit immediately to prevent infinite loops.
    if (hookInput.stop_hook_active) return;

    const sessionId = hookInput.session_id;
    if (!sessionId) return;

    // Check if we already saved a summary for this session recently
    const flag = summaryFlagPath(sessionId);
    if (existsSync(flag)) {
      try {
        const flagData = JSON.parse(readFileSync(flag, 'utf-8'));
        const age = Math.floor(Date.now() / 1000) - flagData.timestamp;
        if (age < SUMMARY_CONFIG.cooldownSeconds) return;
      } catch {
        // Corrupt flag — continue and save
      }
    }

    // Check if session is substantial enough to save
    const { transcript_path } = hookInput;
    if (!transcript_path) return;

    const isSubstantial = checkSessionSubstantial(transcript_path);
    if (!isSubstantial) return;

    const apiKey = resolveApiKey();
    if (!apiKey) return;

    // Build summary from transcript
    let summary = '';
    try {
      summary = buildStopSummary(transcript_path, hookInput.cwd, hookInput.last_assistant_message);
    } catch {
      return;
    }

    if (!summary || summary.length < 20) return;

    // Truncate
    if (summary.length > SUMMARY_CONFIG.maxSummaryChars) {
      summary = summary.slice(0, SUMMARY_CONFIG.maxSummaryChars - 3) + '...';
    }

    // Save via API (fire-and-forget — never block Claude from stopping)
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
      // Network failure — non-critical
    }

    // Write flag so we don't save again this session
    mkdirSync(FLAG_DIR, { recursive: true });
    writeFileSync(flag, JSON.stringify({
      timestamp: Math.floor(Date.now() / 1000),
      session_id: sessionId,
    }));
  } catch {
    // Never fail — don't interfere with Claude stopping
  }

  // Output empty JSON to allow Claude to stop
  console.log(JSON.stringify({}));
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
  log(`  ${BOLD}Step 6:${RESET} Seed project memory`);
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
  log(`    cogmemai-mcp hook precompact    Save context before compaction`);
  log(`    cogmemai-mcp hook context-reload Reload context after compaction/new session`);
  log(`    cogmemai-mcp hook stop          Auto-save session summary on exit`);
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
