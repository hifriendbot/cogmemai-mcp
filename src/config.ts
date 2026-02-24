/**
 * CogmemAi centralized configuration — single source of truth.
 */

import { homedir } from 'os';
import { join } from 'path';

export const VERSION = '2.7.2';

export const API_BASE =
  process.env.COGMEMAI_API_URL?.replace(/\/+$/, '') ||
  'https://hifriendbot.com/wp-json/hifriendbot/v1';

export const API_KEY = process.env.COGMEMAI_API_KEY || '';

export const FLAG_DIR = join(homedir(), '.cogmemai');

// Session thresholds
export const SESSION_EXPIRY_SECONDS = 14400; // 4 hours
export const COMPACTION_FLAG_MAX_AGE = 3600;  // 1 hour

// Network configuration
export const FETCH_TIMEOUT_MS = 10000;       // 10s for MCP tool API calls
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
  minTranscriptLines: 8,
  minUserMessages: 2,
  maxSummaryChars: 2000,
  hookTimeoutSeconds: 20,
  cooldownSeconds: 1800, // 30 minutes between saves for same session
} as const;
