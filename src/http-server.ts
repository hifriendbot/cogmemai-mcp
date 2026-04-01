/**
 * CogmemAi Remote MCP Server — Streamable HTTP transport.
 *
 * Stateless server: each request creates a fresh McpServer + transport.
 * Bearer token auth using existing cm_ API keys validated against WordPress.
 * Designed to run behind nginx with SSL at mcp.hifriendbot.com.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { Request, Response, NextFunction } from 'express';
import { VERSION, HTTP_PORT, API_BASE, TOKEN_CACHE_TTL_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX } from './config.js';
import { registerTools, setRemoteMode } from './tools.js';
import { CloudStorage } from './storage-cloud.js';

// ── Token Cache ────────────────────────────────────────────

interface CachedToken {
  userId: string;
  tier: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * Validate a cm_ API key against the WordPress backend.
 * Caches successful validations for TOKEN_CACHE_TTL_MS.
 */
async function validateApiKey(token: string): Promise<CachedToken | null> {
  // Check cache first
  const cached = tokenCache.get(token);
  if (cached && Date.now() < cached.expiresAt) {
    return cached;
  }

  try {
    const res = await fetch(`${API_BASE}/cogmemai/usage`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const data = await res.json() as { user_id?: number; tier_name?: string };
    const entry: CachedToken = {
      userId: String(data.user_id || 'unknown'),
      tier: data.tier_name || 'free',
      expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
    };

    tokenCache.set(token, entry);
    return entry;
  } catch {
    return null;
  }
}

// ── Rate Limiting ──────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// Periodic cleanup of expired rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(key);
  }
}, 60_000);

// ── System Instructions ────────────────────────────────────

function getRemoteInstructions(): string {
  // Import the same instruction builder from index.ts would create a circular dep.
  // Remote mode always uses cloud instructions (the full set).
  // We inline a minimal pointer — the real instructions come from the McpServer config.
  return ''; // Instructions are set on the McpServer instance
}

// ── HTTP Server ────────────────────────────────────────────

export function startHttpServer(): void {
  setRemoteMode(true);

  const app = createMcpExpressApp({ host: '0.0.0.0' });

  // ── CORS ──
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, COGMEMAI_API_KEY');
    res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // ── Health Check ──
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: VERSION, mode: 'remote' });
  });

  // ── POST /mcp — Handle MCP requests (stateless) ──
  app.post('/mcp', async (req: Request, res: Response) => {
    // Extract API key from Authorization header or COGMEMAI_API_KEY header
    const authHeader = req.headers.authorization;
    const customKeyHeader = req.headers['cogmemai_api_key'] || req.headers['cogmemai-api-key'];
    let apiKey = '';

    if (authHeader && authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.slice(7);
    } else if (typeof customKeyHeader === 'string' && customKeyHeader.startsWith('cm_')) {
      apiKey = customKeyHeader;
    }

    if (!apiKey) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Missing API key. Use Authorization: Bearer cm_YOUR_KEY or COGMEMAI_API_KEY header.' },
        id: null,
      });
      return;
    }

    // Validate API key
    const tokenInfo = await validateApiKey(apiKey);
    if (!tokenInfo) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Invalid API key. Get one free at https://hifriendbot.com/developer/' },
        id: null,
      });
      return;
    }

    // Rate limit by API key
    if (!checkRateLimit(apiKey)) {
      res.status(429).json({
        jsonrpc: '2.0',
        error: { code: -32002, message: `Rate limit exceeded. Max ${RATE_LIMIT_MAX} requests per minute.` },
        id: null,
      });
      return;
    }

    // Create per-request server + storage with user's API key
    const storage = new CloudStorage(apiKey);
    const server = new McpServer(
      { name: 'cogmemai', version: VERSION },
      { instructions: getCloudInstructions() }
    );

    registerTools(server, storage);

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // ── GET /mcp — Not supported in stateless mode ──
  app.get('/mcp', (_req: Request, res: Response) => {
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
      id: null,
    }));
  });

  // ── DELETE /mcp — Not supported in stateless mode ──
  app.delete('/mcp', (_req: Request, res: Response) => {
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Stateless server has no sessions to close.' },
      id: null,
    }));
  });

  // ── Start ──
  app.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`CogmemAi Remote MCP Server v${VERSION} listening on port ${HTTP_PORT}`);
    console.log(`Endpoint: http://0.0.0.0:${HTTP_PORT}/mcp`);
    console.log(`Health: http://0.0.0.0:${HTTP_PORT}/health`);
  });

  process.on('SIGINT', () => {
    console.log('Shutting down...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('Shutting down...');
    process.exit(0);
  });
}

// ── Cloud Instructions (inlined to avoid circular import with index.ts) ──

function getCloudInstructions(): string {
  return `You have persistent memory powered by CogmemAi. Use it proactively:

## CRITICAL: Always Have Context Loaded
Before responding to any user message, verify you have CogmemAi project context
in this conversation. If you cannot see the results of a recent get_project_context
call in your conversation history, call it NOW before doing anything else.

## On Session Start
- Call get_project_context to load your top memories from previous sessions.
- Pass an optional context parameter describing the current task to get more relevant memories.

## While Working — Be Proactive
Use your memory tools continuously, not just when asked:
- Save important learnings (architecture, preferences, bugs, decisions) with save_memory.
- Search before debugging — call recall_memories with error messages first.
- When the user asks about prior work, ALWAYS call recall_memories before answering.

## Think Before You Speak — ALWAYS Recall Before Suggesting
Before suggesting ANY action, approach, or recommendation, ALWAYS recall_memories first.
This applies to EVERY topic — technical, business, people, strategy, everything.
- "Let's reach out to X" — did we already contact them?
- "We should try approach Y" — did we already try it? What happened?
- "Let's add feature Z" — did we already build, evaluate, or reject it?
The user's brain should NEVER be the safety net for things your memory already knows.
Search first, suggest second. Always.

## Memory Types
identity, preference, architecture, decision, bug, dependency, pattern, context

## Session Protection — Save Early, Save Often
Save a memory IMMEDIATELY after each file edit, bug fix, or user decision. Sessions can end unexpectedly.

## Intelligence Features
- Auto-linking, contradiction detection, memory decay, cross-project pattern detection
- Auto-generated behavioral skills from corrections/preferences
- Wisdom Engine: auto-extracted factual principles from memory clusters (extract_principles)
- Mandatory rules (save_rule) for absolute requirements
- Knowledge graph, document ingestion, analytics

## Tool Selection Guide
| Goal | Tool |
|------|------|
| Load context at session start | get_project_context |
| Save a fact or decision | save_memory |
| Save an absolute rule | save_rule |
| Find a specific memory | recall_memories |
| Browse/filter memories | list_memories |
| Learn from a conversation | extract_memories |
| Onboard from docs | ingest_document |
| Track cross-session work | save_task / get_tasks |
| Avoid repeated mistakes | save_correction |
| Connect related memories | link_memories |
| Extract factual patterns | extract_principles |
| Improve recall quality | feedback_memory (useful/irrelevant) |
| Clean up old memories | get_stale_memories / consolidate_memories |
| Check system health | get_analytics / get_usage |
| End of session | save_session_summary |

Note: get_file_changes is not available in remote mode (requires local git access).`;
}
