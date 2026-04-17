/**
 * CogmemAi centralized configuration — single source of truth.
 */

import { homedir } from 'os';
import { join } from 'path';

export const VERSION = '3.16.0';

export const API_BASE =
  process.env.COGMEMAI_API_URL?.replace(/\/+$/, '') ||
  'https://hifriendbot.com/wp-json/hifriendbot/v1';

export const API_KEY = process.env.COGMEMAI_API_KEY || '';

export const FLAG_DIR = join(homedir(), '.cogmemai');

// Storage mode: local (SQLite only), cloud (API only), hybrid (both)
export type StorageMode = 'local' | 'cloud' | 'hybrid';

export const STORAGE_MODE: StorageMode = (() => {
  const explicit = process.env.COGMEMAI_MODE?.toLowerCase();
  if (explicit === 'local' || explicit === 'hybrid' || explicit === 'cloud') return explicit;
  // Auto-detect: API key present → cloud, otherwise → local
  return API_KEY ? 'cloud' : 'local';
})();

export const LOCAL_DB_PATH =
  process.env.COGMEMAI_LOCAL_DB || join(FLAG_DIR, 'local.db');

// Session thresholds
export const SESSION_EXPIRY_SECONDS = 14400; // 4 hours
export const COMPACTION_FLAG_MAX_AGE = 3600;  // 1 hour

// Network configuration
export const FETCH_TIMEOUT_MS = 30000;       // 30s for MCP tool API calls (recall can take 8-13s on cache miss due to OpenAI embedding latency)
export const HOOK_FETCH_TIMEOUT_MS = 5000;   // 5s for hook API calls (must not block Claude)
export const STALE_FLAG_MAX_AGE = 86400;     // 24 hours — clean up old flag files

// Retry configuration
export const RETRY_CONFIG = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 3000,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
} as const;

// Stop hook / auto-summary configuration
export const SUMMARY_CONFIG = {
  minTranscriptLines: 4,
  minUserMessages: 1,
  maxSummaryChars: 2000,
  hookTimeoutSeconds: 20,
  cooldownSeconds: 900, // 15 minutes between saves for same session
} as const;

// Smart recall — proactive mid-session memory injection on topic shift
export const SMART_RECALL_COOLDOWN = 60;        // 1 min between smart injections (TBYS: think before you speak)
export const SMART_RECALL_MAX_CHARS = 1500;      // Max injected content size
export const SMART_RECALL_MIN_MSG_LENGTH = 15;   // Min user message length to trigger (TBYS: lower threshold)
export const SMART_RECALL_MIN_MATCH_SCORE = 1;   // Min keyword matches to trigger recall (TBYS: single match is enough)

// Remote HTTP server configuration
export const HTTP_PORT = parseInt(process.env.MCP_PORT || '3100', 10);
export const TOKEN_CACHE_TTL_MS = 300_000; // 5 minutes
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 120;

// Auto-extract — learn from every session automatically
export const AUTO_EXTRACT_COOLDOWN = 1800;         // 30 minutes between auto-extractions (global)
export const AUTO_EXTRACT_MIN_USER_MESSAGES = 2;   // Min substantial user messages to trigger
export const AUTO_EXTRACT_MIN_MSG_LENGTH = 30;     // Min chars for a "substantial" message

// PostToolUse autonomous-memory config (v3.15.0)
// Events captured by PostToolUse hook are flushed at session end to /cogmemai/extract-events,
// where server-side Haiku extracts structured memories without Claude's involvement.
export const POST_TOOL_USE_MAX_FIELD_CHARS = 500;  // Per-field truncation to cap event size
export const POST_TOOL_USE_MAX_EVENTS = 500;       // Hard cap on events per session log (older events discarded on overflow)
export const POST_TOOL_USE_SKIP_TOOLS = new Set([  // Tools whose events add no signal for memory extraction
  'Read',
  'Glob',
  'Grep',
  'ToolSearch',
]);
