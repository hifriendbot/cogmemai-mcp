/**
 * CogmemAi MCP tool definitions — 18 tools for developer memory.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { api } from './api.js';
import { detectProjectId } from './project.js';

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

const CONTEXT_REMINDER = '\n\n[!] REMINDER: You have not called get_project_context yet this session. Call it now to load your memories from previous sessions.';

function wrapResult(result: unknown, skipReminder = false): { content: Array<{ type: 'text'; text: string }> } {
  let text = JSON.stringify(result, null, 2);
  if (!contextLoaded && !skipReminder) {
    text += CONTEXT_REMINDER;
  }
  return { content: [{ type: 'text' as const, text }] };
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

        if (compact) {
          return wrapResult({
            formatted_context: result.formatted_context || '',
            total_count: result.total_count || 0,
          }, true);
        }
        return wrapResult(result, true);
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
    },
    async ({ memory_type, category, importance_min, scope, limit, tag, offset }) => {
      try {
        const projectId = detectProjectId();
        const params: Record<string, unknown> = {
          limit,
          offset,
          project_id: projectId,
        };
        if (memory_type) params.memory_type = memory_type;
        if (category) params.category = category;
        if (importance_min) params.importance_min = importance_min;
        if (scope && scope !== 'all') params.scope = scope;
        if (tag) params.tag = tag;

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
    },
    async ({ memory_id, content, importance, scope }) => {
      try {
        const body: Record<string, unknown> = {};
        if (content !== undefined) body.content = content;
        if (importance !== undefined) body.importance = importance;
        if (scope !== undefined) body.scope = scope;

        const result = await api(`/cogmemai/memory/${memory_id}`, 'PATCH', body);
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
    {},
    async () => {
      try {
        const projectId = detectProjectId();
        const result = await api('/cogmemai/analytics', 'GET', {
          project_id: projectId,
        });
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
}
