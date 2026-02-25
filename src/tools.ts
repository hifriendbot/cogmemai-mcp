/**
 * CogmemAi MCP tool definitions — 28 tools for developer memory.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { api } from './api.js';
import { detectProjectId } from './project.js';
import { FLAG_DIR } from './config.js';

const MEMORY_TYPES = [
  'identity',
  'preference',
  'architecture',
  'decision',
  'bug',
  'dependency',
  'pattern',
  'context',
] as const;

// Session tracking: detect if get_project_context was called
let contextLoaded = false;
let toolCallCount = 0;
const MAX_REMINDER_CALLS = 3; // Stop nagging after this many tool calls

const CONTEXT_REMINDER = '\n\n[!] REMINDER: You have not called get_project_context yet this session. Call it now to load your memories from previous sessions.';

function wrapResult(result: unknown, skipReminder = false): { content: Array<{ type: 'text'; text: string }> } {
  let text = JSON.stringify(result, null, 2);
  toolCallCount++;
  if (!contextLoaded && !skipReminder && toolCallCount <= MAX_REMINDER_CALLS) {
    text += CONTEXT_REMINDER;
  }
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Cache topic index to disk for hook-based smart recall.
 * Written when get_project_context succeeds.
 */
function cacheTopicIndex(projectId: string, topicIndex: unknown[]): void {
  try {
    mkdirSync(FLAG_DIR, { recursive: true });
    const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const cachePath = join(FLAG_DIR, `topics-${safe}.json`);
    writeFileSync(cachePath, JSON.stringify({
      timestamp: Math.floor(Date.now() / 1000),
      project_id: projectId,
      topics: topicIndex,
    }));
  } catch {
    // Non-critical — smart recall just won't work until next cache write
  }
}

/**
 * Save current git state to a snapshot file for file-change tracking.
 */
function saveGitSnapshot(snapshotPath: string, branch: string, commit: string): void {
  try {
    mkdirSync(FLAG_DIR, { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify({
      branch,
      commit,
      timestamp: Math.floor(Date.now() / 1000),
    }));
  } catch { /* non-critical */ }
}

function wrapError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: message }),
    }],
    isError: true,
  };
}

/**
 * Register all CogmemAi tools on the MCP server.
 */
export function registerTools(server: McpServer): void {
  // ─── 1. save_memory ──────────────────────────────────────

  server.tool(
    'save_memory',
    'Store a developer memory (fact, preference, decision, architecture detail). Memories persist across all Claude Code sessions and are available in future conversations.',
    {
      content: z
        .string()
        .min(5)
        .max(500)
        .describe('The fact to remember (complete sentence)'),
      memory_type: z
        .string()
        .default('context')
        .describe(
          'Type: identity, preference, architecture, decision, bug, dependency, pattern, context. Custom types also accepted for non-developer domains.'
        ),
      category: z
        .string()
        .max(50)
        .default('general')
        .describe(
          'Category: frontend, backend, database, devops, testing, security, performance, tooling, api, general. Custom categories also accepted for non-developer domains.'
        ),
      subject: z
        .string()
        .max(100)
        .default('')
        .describe(
          'What this is about, e.g. "auth_system", "react_version", "tab_width"'
        ),
      importance: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe('1-10 (10 = core architecture, 1 = trivial)'),
      scope: z
        .enum(['global', 'project'])
        .default('project')
        .describe(
          'global = applies everywhere, project = specific to this codebase'
        ),
      tags: z
        .array(z.string().max(30))
        .max(5)
        .optional()
        .describe(
          'Optional tags for grouping/threading memories (max 5 tags, each max 30 chars). E.g., ["marketing-campaign", "feb-2026"]'
        ),
      ttl: z
        .string()
        .max(10)
        .optional()
        .describe(
          'Set an expiration time. Use for temporary context like current task status. Format: "24h", "7d", "30d". Memory auto-archives after expiry.'
        ),
    },
    async ({ content, memory_type, category, subject, importance, scope, tags, ttl }) => {
      try {
        const projectId = detectProjectId();
        const body: Record<string, unknown> = {
          content,
          memory_type,
          category,
          subject,
          importance,
          scope,
          project_id: projectId,
        };
        if (tags && tags.length > 0) body.tags = tags;
        if (ttl) body.ttl = ttl;
        const result = await api('/cogmemai/store', 'POST', body);
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 2. recall_memories ──────────────────────────────────

  server.tool(
    'recall_memories',
    'Search stored memories using semantic search. Returns memories ranked by relevance, importance, and recency. Use this to find relevant context from past sessions.',
    {
      query: z
        .string()
        .min(2)
        .max(500)
        .describe('What to search for (natural language)'),
      scope: z
        .enum(['global', 'project', 'all'])
        .default('all')
        .describe('Filter by scope'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(10)
        .describe('Max results'),
      memory_type: z.enum(MEMORY_TYPES).optional().describe('Filter by type'),
      category: z
        .string()
        .max(50)
        .optional()
        .describe('Filter by category (e.g., "backend", "frontend", or any custom category)'),
      importance_min: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Only return memories with importance >= this value'),
      tag: z
        .string()
        .max(30)
        .optional()
        .describe('Filter by tag (e.g., "marketing-campaign")'),
    },
    async ({ query, scope, limit, memory_type, category, importance_min, tag }) => {
      try {
        const projectId = detectProjectId();
        const result = await api('/cogmemai/recall', 'POST', {
          query,
          scope,
          limit,
          memory_type: memory_type || undefined,
          category: category || undefined,
          importance_min: importance_min || undefined,
          tag: tag || undefined,
          project_id: projectId,
        });
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 3. extract_memories ─────────────────────────────────

  server.tool(
    'extract_memories',
    'Extract memories from a conversation exchange using AI. Send the developer message and assistant response, and the server identifies facts worth remembering (architecture decisions, preferences, bug fixes, etc.).',
    {
      user_message: z
        .string()
        .min(1)
        .max(4000)
        .describe("The developer's message"),
      assistant_response: z
        .string()
        .max(4000)
        .optional()
        .describe("The assistant's response"),
      previous_context: z
        .string()
        .max(2000)
        .optional()
        .describe('Previous exchange for context'),
    },
    async ({ user_message, assistant_response, previous_context }) => {
      try {
        const projectId = detectProjectId();
        const result = await api('/cogmemai/extract', 'POST', {
          user_message,
          assistant_response: assistant_response || '',
          previous_context: previous_context || '',
          project_id: projectId,
        });
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 4. get_project_context ──────────────────────────────

  server.tool(
    'get_project_context',
    'Load top memories for the current project plus relevant global memories. Use at the start of a session to get full context from previous sessions. Optionally pass context to get memories most relevant to your current task.',
    {
      project_id: z
        .string()
        .max(200)
        .optional()
        .describe('Project identifier (auto-detected from git remote if omitted)'),
      include_global: z
        .boolean()
        .default(true)
        .describe('Include global developer preferences'),
      context: z
        .string()
        .max(500)
        .optional()
        .describe('Optional context to improve relevance ranking (e.g., current task or topic)'),
      context_type: z
        .enum(['debugging', 'planning', 'reviewing', 'general'])
        .optional()
        .describe('Optional context type that shifts scoring weights. debugging = boost bug/pattern memories, planning = boost architecture/decision, reviewing = boost pattern/preference.'),
      compact: z
        .boolean()
        .default(true)
        .describe('When true (default), returns only formatted_context text instead of full JSON arrays. Saves ~60% tokens.'),
      limit: z
        .number()
        .int()
        .min(5)
        .max(100)
        .default(25)
        .describe('Max total memories to return (default 25). Lower values save context tokens.'),
    },
    async ({ project_id, include_global, context, context_type, compact, limit }) => {
      try {
        const pid = project_id || detectProjectId();
        const params: Record<string, string> = {
          project_id: pid,
          include_global: include_global ? 'true' : 'false',
        };
        if (context) params.context = context;
        if (context_type) params.context_type = context_type;
        if (limit) params.limit = String(limit);
        const result = await api('/cogmemai/context', 'GET', params) as Record<string, unknown>;
        contextLoaded = true;

        // Cache topic index for hook-based smart recall
        if (Array.isArray(result.topic_index)) {
          cacheTopicIndex(pid, result.topic_index);
        }

        if (compact) {
          const compactResult: Record<string, unknown> = {
            formatted_context: result.formatted_context || '',
            total_count: result.total_count || 0,
          };
          if (result.recalls_total) compactResult.recalls_total = result.recalls_total;
          if (result.last_session) compactResult.last_session = result.last_session;
          if (result.health_score) compactResult.health_score = result.health_score;
          return wrapResult(compactResult, true);
        }
        // Strip topic_index from full response (internal use only)
        const { topic_index: _ti, ...clientResult } = result;
        return wrapResult(clientResult, true);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 5. list_memories ────────────────────────────────────

  server.tool(
    'list_memories',
    'List stored memories with optional filters by type, category, scope, or project.',
    {
      memory_type: z.enum(MEMORY_TYPES).optional().describe('Filter by type'),
      category: z
        .string()
        .max(50)
        .optional()
        .describe('Filter by category (e.g., "backend", "frontend", or any custom category)'),
      importance_min: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Only return memories with importance >= this value'),
      scope: z
        .enum(['global', 'project', 'all'])
        .default('all')
        .describe('Filter by scope'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .describe('Results per page'),
      tag: z
        .string()
        .max(30)
        .optional()
        .describe('Filter by tag (e.g., "marketing-campaign")'),
      offset: z.number().int().default(0).describe('Pagination offset'),
      untyped: z
        .boolean()
        .optional()
        .describe('When true, only return memories with no memory_type set'),
      sort_by: z
        .enum(['importance', 'updated', 'created', 'referenced', 'least_used'])
        .default('importance')
        .describe('Sort order: importance (default), updated, created, referenced (most used first), least_used'),
    },
    async ({ memory_type, category, importance_min, scope, limit, tag, offset, untyped, sort_by }) => {
      try {
        const projectId = detectProjectId();
        const params: Record<string, unknown> = {
          limit,
          offset,
        };
        // Don't send project_id when filtering for global scope (globals have project_id = NULL)
        if (scope !== 'global') {
          params.project_id = projectId;
        }
        if (memory_type) params.memory_type = memory_type;
        if (category) params.category = category;
        if (importance_min) params.importance_min = importance_min;
        if (scope && scope !== 'all') params.scope = scope;
        if (tag) params.tag = tag;
        if (untyped) params.untyped = 'true';
        if (sort_by && sort_by !== 'importance') params.sort_by = sort_by;

        const result = await api('/cogmemai/memories', 'GET', params);
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 6. delete_memory ────────────────────────────────────

  server.tool(
    'delete_memory',
    'Delete a specific memory by its ID. This is permanent.',
    {
      memory_id: z.number().int().describe('Memory ID to delete'),
    },
    async ({ memory_id }) => {
      try {
        const result = await api(`/cogmemai/memory/${memory_id}`, 'DELETE');
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 7. update_memory ────────────────────────────────────

  server.tool(
    'update_memory',
    "Update an existing memory's content, importance, or scope.",
    {
      memory_id: z.number().int().describe('Memory ID to update'),
      content: z
        .string()
        .min(5)
        .max(500)
        .optional()
        .describe('New content'),
      importance: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('New importance (1-10)'),
      scope: z
        .enum(['global', 'project'])
        .optional()
        .describe('New scope'),
      memory_type: z
        .enum(MEMORY_TYPES)
        .optional()
        .describe('New memory type'),
      category: z
        .string()
        .max(50)
        .optional()
        .describe('New category (e.g., "backend", "frontend", or any custom category)'),
      subject: z
        .string()
        .max(100)
        .optional()
        .describe('New subject (e.g., "auth_system", "react_version")'),
      tags: z
        .array(z.string().max(30))
        .max(5)
        .optional()
        .describe('New tags (replaces existing tags)'),
    },
    async ({ memory_id, content, importance, scope, memory_type, category, subject, tags }) => {
      try {
        const body: Record<string, unknown> = {};
        if (content !== undefined) body.content = content;
        if (importance !== undefined) body.importance = importance;
        if (scope !== undefined) body.scope = scope;
        if (memory_type !== undefined) body.memory_type = memory_type;
        if (category !== undefined) body.category = category;
        if (subject !== undefined) body.subject = subject;
        if (tags !== undefined) body.tags = tags;

        const result = await api(`/cogmemai/memory/${memory_id}`, 'PATCH', body);
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 7b. bulk_delete ─────────────────────────────────

  server.tool(
    'bulk_delete',
    'Delete multiple memories at once by their IDs. Maximum 100 IDs per call. This is permanent.',
    {
      ids: z
        .array(z.number().int())
        .min(1)
        .max(100)
        .describe('Array of memory IDs to delete (max 100)'),
    },
    async ({ ids }) => {
      try {
        const result = await api('/cogmemai/bulk-delete', 'POST', { ids });
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 7c. bulk_update ─────────────────────────────────

  server.tool(
    'bulk_update',
    'Update multiple memories at once. Each item needs a memory_id and fields to update. Maximum 50 items per call.',
    {
      updates: z
        .array(
          z.object({
            memory_id: z.number().int().describe('Memory ID to update'),
            content: z.string().min(5).max(500).optional().describe('New content'),
            importance: z.number().int().min(1).max(10).optional().describe('New importance'),
            scope: z.enum(['global', 'project']).optional().describe('New scope'),
            memory_type: z.enum(MEMORY_TYPES).optional().describe('New memory type'),
            category: z.string().max(50).optional().describe('New category'),
            subject: z.string().max(100).optional().describe('New subject'),
            tags: z.array(z.string().max(30)).max(5).optional().describe('New tags'),
          })
        )
        .min(1)
        .max(50)
        .describe('Array of update objects (max 50)'),
    },
    async ({ updates }) => {
      try {
        const result = await api('/cogmemai/bulk-update', 'POST', { updates });
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 8. get_usage ────────────────────────────────────────

  server.tool(
    'get_usage',
    'Get current usage statistics — memory count, extractions this month, tier info, projects.',
    {},
    async () => {
      try {
        const result = await api('/cogmemai/usage', 'GET');
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 9. export_memories ─────────────────────────────────

  server.tool(
    'export_memories',
    'Export all memories as JSON. Use this to back up memories or transfer them to another project.',
    {},
    async () => {
      try {
        const projectId = detectProjectId();
        const result = await api('/cogmemai/export', 'GET', {
          project_id: projectId,
        });
        return wrapResult(result, true);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 10. import_memories ──────────────────────────────

  server.tool(
    'import_memories',
    'Bulk import memories from a JSON array. Each memory needs at minimum a content field. Deduplication is applied automatically.',
    {
      memories: z
        .string()
        .min(2)
        .max(100000)
        .describe(
          'JSON string containing an array of memory objects. Each must have "content", optionally: memory_type, category, subject, importance, scope.'
        ),
    },
    async ({ memories }) => {
      try {
        const projectId = detectProjectId();
        let parsed;
        try {
          parsed = JSON.parse(memories);
        } catch {
          return wrapError(new Error('Invalid JSON. Provide a JSON array of memory objects.'));
        }
        const result = await api('/cogmemai/import', 'POST', {
          memories: parsed,
          project_id: projectId,
        });
        return wrapResult(result, true);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 11. ingest_document ───────────────────────────────

  server.tool(
    'ingest_document',
    'Extract memories from a document by splitting it into chunks and processing each one. Great for onboarding — feed in READMEs, architecture docs, or API specs to quickly build project context.',
    {
      text: z
        .string()
        .min(20)
        .max(50000)
        .describe('The document text to ingest (up to 50K characters)'),
      document_type: z
        .string()
        .max(50)
        .default('general')
        .describe(
          'Type hint for extraction (e.g., readme, api_docs, architecture, changelog)'
        ),
    },
    async ({ text, document_type }) => {
      try {
        const projectId = detectProjectId();
        const result = await api('/cogmemai/ingest', 'POST', {
          text,
          document_type,
          project_id: projectId,
        });
        return wrapResult(result, true);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 12. save_session_summary ──────────────────────────

  server.tool(
    'save_session_summary',
    'Save a summary of the current coding session. Captures what was accomplished, decisions made, and next steps. Stored as a session_summary memory for future reference.',
    {
      summary: z
        .string()
        .min(10)
        .max(2000)
        .describe(
          'Summary of the session — what was done, key decisions, and next steps'
        ),
    },
    async ({ summary }) => {
      try {
        const projectId = detectProjectId();
        const result = await api('/cogmemai/session-summary', 'POST', {
          summary,
          project_id: projectId,
        });
        return wrapResult(result, true);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 13. list_tags ─────────────────────────────────────

  server.tool(
    'list_tags',
    'List all tags in use across your memories, with counts. Use this to see what threads/groups exist and find related memories by tag.',
    {},
    async () => {
      try {
        const projectId = detectProjectId();
        const result = await api('/cogmemai/tags', 'GET', {
          project_id: projectId,
        });
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 14. link_memories ─────────────────────────────────

  server.tool(
    'link_memories',
    'Connect two related memories with a named relationship. Use this to build a knowledge graph — e.g., linking a bug fix to the architecture decision that caused it, or connecting a preference to the pattern it led to.',
    {
      memory_id: z.number().int().describe('The source memory ID'),
      related_memory_id: z.number().int().describe('The target memory ID to link to'),
      relationship: z
        .enum(['led_to', 'contradicts', 'extends', 'related'])
        .describe(
          'How the memories relate: led_to (A caused B), contradicts (A conflicts with B), extends (A builds on B), related (general connection)'
        ),
    },
    async ({ memory_id, related_memory_id, relationship }) => {
      try {
        const result = await api(`/cogmemai/memory/${memory_id}/link`, 'POST', {
          related_memory_id,
          relationship,
        });
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 15. get_memory_links ─────────────────────────────

  server.tool(
    'get_memory_links',
    'View all memories linked to a specific memory. Returns the relationship type and full memory details for each connection. Use this to explore the knowledge graph around a memory.',
    {
      memory_id: z.number().int().describe('The memory ID to get links for'),
    },
    async ({ memory_id }) => {
      try {
        const result = await api(`/cogmemai/memory/${memory_id}/links`, 'GET');
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 15. get_memory_versions ──────────────────────────

  server.tool(
    'get_memory_versions',
    'View the edit history of a memory. Shows all previous versions with timestamps and what changed. Useful for understanding how a decision or fact evolved over time.',
    {
      memory_id: z.number().int().describe('The memory ID to get version history for'),
    },
    async ({ memory_id }) => {
      try {
        const result = await api(`/cogmemai/memory/${memory_id}/versions`, 'GET');
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 16. get_analytics ────────────────────────────────

  server.tool(
    'get_analytics',
    'Get a memory health dashboard with insights: most recalled memories, never-recalled memories, stale memories, growth trends, and breakdowns by type and category. Use this to identify cleanup opportunities and understand memory usage patterns.',
    {
      project_id: z
        .string()
        .max(200)
        .optional()
        .describe('Filter analytics to a specific project. Omit for current project. Use "all" for cross-project analytics.'),
    },
    async ({ project_id }) => {
      try {
        const params: Record<string, string> = {};
        if (project_id === 'all') {
          // Omit project_id entirely for cross-project
        } else {
          params.project_id = project_id || detectProjectId();
        }
        const result = await api('/cogmemai/analytics', 'GET', params);
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 17. promote_memory ───────────────────────────────

  server.tool(
    'promote_memory',
    'Promote a project-scoped memory to global scope so it applies across all projects. Use this when you discover a preference or pattern that should be universal — e.g., "user prefers tabs over spaces" or "always use Bun instead of npm".',
    {
      memory_id: z.number().int().describe('The project memory ID to promote to global scope'),
    },
    async ({ memory_id }) => {
      try {
        const result = await api(`/cogmemai/memory/${memory_id}/promote`, 'POST');
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 18. consolidate_memories ──────────────────────────

  server.tool(
    'consolidate_memories',
    'Consolidate related memories into fewer, richer memories. Finds clusters of memories sharing the same subject (3+ memories required), then uses AI to synthesize each cluster into 1-2 comprehensive facts. Originals are archived (not deleted) with full version history. Use dry_run=true to preview without making changes. Great for cleaning up memory clutter after many sessions.',
    {
      subject: z
        .string()
        .max(100)
        .optional()
        .describe('Consolidate only memories with this exact subject (e.g., "auth_system"). Omit to auto-detect all qualifying clusters.'),
      memory_type: z
        .enum(MEMORY_TYPES)
        .optional()
        .describe('Only consolidate memories of this type'),
      category: z
        .string()
        .max(50)
        .optional()
        .describe('Only consolidate memories in this category'),
      dry_run: z
        .boolean()
        .default(false)
        .describe('When true, preview consolidation results without making changes. Recommended for first use.'),
    },
    async ({ subject, memory_type, category, dry_run }) => {
      try {
        const projectId = detectProjectId();
        const body: Record<string, unknown> = {
          project_id: projectId,
          dry_run,
        };
        if (subject) body.subject = subject;
        if (memory_type) body.memory_type = memory_type;
        if (category) body.category = category;

        const result = await api('/cogmemai/consolidate', 'POST', body);
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 19. save_task ─────────────────────────────────────────

  server.tool(
    'save_task',
    'Create a task that persists across sessions. Tasks are tracked with status (pending, in_progress, done, blocked) and priority (high, medium, low). Use this to maintain continuity on multi-session work.',
    {
      title: z
        .string()
        .min(3)
        .max(200)
        .describe('Short task title (e.g., "Fix auth bug in login flow")'),
      description: z
        .string()
        .max(500)
        .default('')
        .describe('Detailed description of what needs to be done'),
      priority: z
        .enum(['high', 'medium', 'low'])
        .default('medium')
        .describe('Task priority'),
      status: z
        .enum(['pending', 'in_progress', 'done', 'blocked'])
        .default('pending')
        .describe('Initial task status'),
    },
    async ({ title, description, priority, status }) => {
      try {
        const projectId = detectProjectId();
        const importance = priority === 'high' ? 9 : priority === 'medium' ? 7 : 5;
        const content = description
          ? `[${status.toUpperCase()}] ${title} — ${description}`
          : `[${status.toUpperCase()}] ${title}`;

        const result = await api('/cogmemai/store', 'POST', {
          content,
          memory_type: 'task',
          category: 'tasks',
          subject: title.slice(0, 100),
          importance,
          scope: 'project',
          project_id: projectId,
          tags: [`priority-${priority}`, `status-${status}`],
        });
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 20. get_tasks ─────────────────────────────────────────

  server.tool(
    'get_tasks',
    'Get tasks for the current project. Returns tasks filtered by status — defaults to showing pending and in_progress tasks. Use at session start to pick up where you left off.',
    {
      status: z
        .enum(['pending', 'in_progress', 'done', 'blocked', 'all'])
        .default('all')
        .describe('Filter by task status. "all" returns pending + in_progress + blocked (excludes done).'),
      include_done: z
        .boolean()
        .default(false)
        .describe('When true, also include completed tasks'),
    },
    async ({ status, include_done }) => {
      try {
        const projectId = detectProjectId();
        const params: Record<string, unknown> = {
          limit: 50,
          offset: 0,
          project_id: projectId,
          memory_type: 'task',
        };

        if (status !== 'all') {
          params.tag = `status-${status}`;
        }

        const result = await api('/cogmemai/memories', 'GET', params) as {
          memories?: Array<{ id: number; content: string; subject: string; tags?: string[]; importance: number; updated_at?: string; created_at: string }>;
          total?: number;
        };

        // Format tasks for readability
        const memories = result.memories || [];
        const tasks = memories
          .filter((m) => {
            if (status === 'all' && !include_done) {
              // Exclude done tasks unless requested
              const tags = m.tags || [];
              return !tags.includes('status-done');
            }
            return true;
          })
          .map((m) => {
            const tags = m.tags || [];
            const statusTag = tags.find((t) => t.startsWith('status-'));
            const priorityTag = tags.find((t) => t.startsWith('priority-'));
            return {
              id: m.id,
              title: m.subject || m.content.slice(0, 100),
              description: m.content,
              status: statusTag ? statusTag.replace('status-', '') : 'pending',
              priority: priorityTag ? priorityTag.replace('priority-', '') : 'medium',
              updated: m.updated_at || m.created_at,
            };
          });

        return wrapResult({ tasks, total: tasks.length });
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 21. update_task ───────────────────────────────────────

  server.tool(
    'update_task',
    'Update a task\'s status, title, description, or priority. Use this to mark tasks as in_progress, done, or blocked as you work.',
    {
      task_id: z.number().int().describe('The task memory ID (from get_tasks)'),
      status: z
        .enum(['pending', 'in_progress', 'done', 'blocked'])
        .optional()
        .describe('New status'),
      title: z.string().min(3).max(200).optional().describe('New title'),
      description: z.string().max(500).optional().describe('New description'),
      priority: z
        .enum(['high', 'medium', 'low'])
        .optional()
        .describe('New priority'),
    },
    async ({ task_id, status, title, description, priority }) => {
      try {
        const body: Record<string, unknown> = {};

        // Build updated content if title or description changed
        if (title !== undefined || description !== undefined || status !== undefined) {
          // Fetch current task to get existing values
          const current = await api(`/cogmemai/memories`, 'GET', {
            limit: '1',
            offset: '0',
            memory_type: 'task',
          }) as { memories?: Array<{ id: number; content: string; subject: string; tags?: string[] }> };

          // We need to reconstruct content with new status prefix
          const currentTask = current.memories?.find((m) => m.id === task_id);
          const currentSubject = currentTask?.subject || '';
          const currentContent = currentTask?.content || '';
          const currentTags = currentTask?.tags || [];

          const newTitle = title || currentSubject;
          const newStatus = status || currentTags.find((t) => t.startsWith('status-'))?.replace('status-', '') || 'pending';

          // Rebuild content with status prefix
          if (description !== undefined) {
            body.content = `[${newStatus.toUpperCase()}] ${newTitle} — ${description}`;
          } else if (title !== undefined || status !== undefined) {
            // Preserve existing description if present
            const descMatch = currentContent.match(/^(?:\[[A-Z_]+\]\s*)?(?:.*?\s—\s)?(.*)$/);
            const existingDesc = descMatch?.[1] || '';
            body.content = existingDesc
              ? `[${newStatus.toUpperCase()}] ${newTitle} — ${existingDesc}`
              : `[${newStatus.toUpperCase()}] ${newTitle}`;
          }

          if (title !== undefined) body.subject = title.slice(0, 100);
        }

        // Build new tags
        if (status !== undefined || priority !== undefined) {
          // Fetch current tags to preserve non-status/priority ones
          const currentMem = await api(`/cogmemai/memories`, 'GET', {
            limit: '50',
            offset: '0',
            memory_type: 'task',
          }) as { memories?: Array<{ id: number; tags?: string[] }> };

          const task = currentMem.memories?.find((m) => m.id === task_id);
          const oldTags = task?.tags || [];

          const newTags = oldTags.filter((t) => !t.startsWith('status-') && !t.startsWith('priority-'));
          if (status !== undefined) newTags.push(`status-${status}`);
          else {
            const existingStatus = oldTags.find((t) => t.startsWith('status-'));
            if (existingStatus) newTags.push(existingStatus);
          }
          if (priority !== undefined) {
            newTags.push(`priority-${priority}`);
            body.importance = priority === 'high' ? 9 : priority === 'medium' ? 7 : 5;
          } else {
            const existingPriority = oldTags.find((t) => t.startsWith('priority-'));
            if (existingPriority) newTags.push(existingPriority);
          }
          body.tags = newTags;
        }

        const result = await api(`/cogmemai/memory/${task_id}`, 'PATCH', body);
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 22. save_correction ───────────────────────────────────

  server.tool(
    'save_correction',
    'Save a correction pattern — what went wrong and what the right approach is. These are surfaced automatically when similar situations arise in future sessions, helping avoid repeated mistakes.',
    {
      wrong_approach: z
        .string()
        .min(5)
        .max(300)
        .describe('What was done incorrectly (e.g., "Used npm install instead of bun add")'),
      right_approach: z
        .string()
        .min(5)
        .max(300)
        .describe('The correct approach (e.g., "Always use bun add for this project")'),
      context: z
        .string()
        .max(200)
        .default('')
        .describe('When/where this applies (e.g., "package management in monorepo")'),
      scope: z
        .enum(['global', 'project'])
        .default('project')
        .describe('global = applies everywhere, project = specific to this codebase'),
    },
    async ({ wrong_approach, right_approach, context, scope }) => {
      try {
        const projectId = detectProjectId();
        const content = context
          ? `WRONG: ${wrong_approach} → RIGHT: ${right_approach} (context: ${context})`
          : `WRONG: ${wrong_approach} → RIGHT: ${right_approach}`;

        const result = await api('/cogmemai/store', 'POST', {
          content,
          memory_type: 'correction',
          category: 'corrections',
          subject: context || 'general',
          importance: 8,
          scope,
          project_id: projectId,
          tags: ['correction'],
        });
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 23. set_reminder ──────────────────────────────────────

  server.tool(
    'set_reminder',
    'Set a reminder that surfaces automatically at the start of your next session. Use for follow-ups, things to check, or deferred work. Reminders auto-archive after being shown.',
    {
      content: z
        .string()
        .min(5)
        .max(300)
        .describe('What to remind about (e.g., "Check if PR #42 was merged")'),
      ttl: z
        .string()
        .max(10)
        .default('7d')
        .describe('How long to keep the reminder alive. Format: "24h", "7d", "30d". Default: 7 days.'),
    },
    async ({ content, ttl }) => {
      try {
        const projectId = detectProjectId();
        const result = await api('/cogmemai/store', 'POST', {
          content: `REMINDER: ${content}`,
          memory_type: 'reminder',
          category: 'reminders',
          subject: 'next_session',
          importance: 8,
          scope: 'project',
          project_id: projectId,
          tags: ['reminder', 'next-session'],
          ttl,
        });
        return wrapResult(result);
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 24. get_stale_memories ────────────────────────────────

  server.tool(
    'get_stale_memories',
    'Find memories that may be outdated based on age and access patterns. Returns memories that haven\'t been recalled or updated recently, so you can review, update, or delete them.',
    {
      days_threshold: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(30)
        .describe('Consider memories stale if not accessed in this many days (default: 30)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe('Max results to return'),
    },
    async ({ days_threshold, limit }) => {
      try {
        const projectId = detectProjectId();
        const result = await api('/cogmemai/stale', 'GET', {
          project_id: projectId,
          days_threshold,
          limit,
        }) as Record<string, unknown>;

        return wrapResult({
          ...result,
          tip: 'Review these memories — update if still relevant, delete if outdated.',
        });
      } catch (error) {
        return wrapError(error);
      }
    }
  );

  // ─── 25. get_file_changes ──────────────────────────────────

  server.tool(
    'get_file_changes',
    'Show what files changed since your last session. Compares the current git state to a snapshot saved when your previous session ended. Helps you understand what happened between sessions.',
    {},
    async () => {
      try {
        const projectId = detectProjectId();
        const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        const snapshotPath = join(FLAG_DIR, `git-snapshot-${safe}.json`);

        // Get current git state
        let currentBranch = '';
        let currentCommit = '';
        let currentStatus: string[] = [];

        try {
          currentBranch = execSync('git branch --show-current', {
            encoding: 'utf-8',
            timeout: 3000,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
        } catch { /* not a git repo */ }

        try {
          currentCommit = execSync('git rev-parse HEAD', {
            encoding: 'utf-8',
            timeout: 3000,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
        } catch { /* no commits */ }

        try {
          const statusOutput = execSync('git status --porcelain', {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          if (statusOutput) {
            currentStatus = statusOutput.split('\n').map((l) => l.trim()).filter(Boolean);
          }
        } catch { /* git error */ }

        // Load previous snapshot
        if (!existsSync(snapshotPath)) {
          // No previous snapshot — save current state for next time
          saveGitSnapshot(snapshotPath, currentBranch, currentCommit);
          return wrapResult({
            message: 'No previous session snapshot found. Current state saved for next time.',
            current: { branch: currentBranch, commit: currentCommit.slice(0, 8), uncommitted_files: currentStatus.length },
          });
        }

        let snapshot: { branch: string; commit: string; timestamp: number };
        try {
          snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
        } catch {
          saveGitSnapshot(snapshotPath, currentBranch, currentCommit);
          return wrapResult({ message: 'Previous snapshot was corrupted. Current state saved.', current: { branch: currentBranch, commit: currentCommit.slice(0, 8) } });
        }

        // Compare
        const changes: string[] = [];
        if (snapshot.branch !== currentBranch) {
          changes.push(`Branch changed: ${snapshot.branch} → ${currentBranch}`);
        }

        let commitsBetween: string[] = [];
        if (snapshot.commit && currentCommit && snapshot.commit !== currentCommit) {
          try {
            const log = execSync(`git log --oneline ${snapshot.commit.slice(0, 8)}..HEAD`, {
              encoding: 'utf-8',
              timeout: 5000,
              stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            if (log) {
              commitsBetween = log.split('\n').filter(Boolean);
            }
          } catch { /* range may not exist */ }

          // Files changed between commits
          try {
            const diffStat = execSync(`git diff --stat ${snapshot.commit.slice(0, 8)}..HEAD`, {
              encoding: 'utf-8',
              timeout: 5000,
              stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            if (diffStat) {
              changes.push(`Files changed since last session:\n${diffStat}`);
            }
          } catch { /* diff error */ }
        }

        // Save new snapshot for next session
        saveGitSnapshot(snapshotPath, currentBranch, currentCommit);

        const sessionAge = snapshot.timestamp
          ? Math.floor((Date.now() / 1000 - snapshot.timestamp) / 3600)
          : null;

        return wrapResult({
          hours_since_last_session: sessionAge,
          previous: { branch: snapshot.branch, commit: snapshot.commit?.slice(0, 8) },
          current: { branch: currentBranch, commit: currentCommit.slice(0, 8) },
          new_commits: commitsBetween,
          uncommitted_files: currentStatus,
          summary: changes.length > 0 ? changes : ['No changes since last session'],
        });
      } catch (error) {
        return wrapError(error);
      }
    }
  );
}
