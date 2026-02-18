/**
 * CogmemAi MCP tool definitions — 8 tools for developer memory.
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

const CATEGORIES = [
  'frontend',
  'backend',
  'database',
  'devops',
  'testing',
  'security',
  'performance',
  'tooling',
  'api',
  'general',
] as const;

/**
 * Register all 8 CogmemAi tools on the MCP server.
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
        .enum(MEMORY_TYPES)
        .default('context')
        .describe(
          'Type: identity, preference, architecture, decision, bug, dependency, pattern, context'
        ),
      category: z
        .enum(CATEGORIES)
        .default('general')
        .describe(
          'Category: frontend, backend, database, devops, testing, security, performance, tooling, api, general'
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
    },
    async ({ content, memory_type, category, subject, importance, scope }) => {
      const projectId = detectProjectId();
      const result = await api('/cogmemai/store', 'POST', {
        content,
        memory_type,
        category,
        subject,
        importance,
        scope,
        project_id: projectId,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
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
    },
    async ({ query, scope, limit, memory_type }) => {
      const projectId = detectProjectId();
      const result = await api('/cogmemai/recall', 'POST', {
        query,
        scope,
        limit,
        memory_type: memory_type || undefined,
        project_id: projectId,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
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
      const projectId = detectProjectId();
      const result = await api('/cogmemai/extract', 'POST', {
        user_message,
        assistant_response: assistant_response || '',
        previous_context: previous_context || '',
        project_id: projectId,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
  );

  // ─── 4. get_project_context ──────────────────────────────

  server.tool(
    'get_project_context',
    'Load all stored memories for the current project plus relevant global memories. Use at the start of a session to get full context from previous sessions.',
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
    },
    async ({ project_id, include_global }) => {
      const pid = project_id || detectProjectId();
      const result = await api('/cogmemai/context', 'GET', {
        project_id: pid,
        include_global: include_global ? 'true' : 'false',
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
  );

  // ─── 5. list_memories ────────────────────────────────────

  server.tool(
    'list_memories',
    'List all stored memories with optional filters by type, category, scope, or project.',
    {
      memory_type: z.enum(MEMORY_TYPES).optional().describe('Filter by type'),
      category: z.enum(CATEGORIES).optional().describe('Filter by category'),
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
      offset: z.number().int().default(0).describe('Pagination offset'),
    },
    async ({ memory_type, category, scope, limit, offset }) => {
      const projectId = detectProjectId();
      const params: Record<string, unknown> = {
        limit,
        offset,
        project_id: projectId,
      };
      if (memory_type) params.memory_type = memory_type;
      if (category) params.category = category;
      if (scope && scope !== 'all') params.scope = scope;

      const result = await api('/cogmemai/memories', 'GET', params);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
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
      const result = await api(`/cogmemai/memory/${memory_id}`, 'DELETE');
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
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
      const body: Record<string, unknown> = {};
      if (content !== undefined) body.content = content;
      if (importance !== undefined) body.importance = importance;
      if (scope !== undefined) body.scope = scope;

      const result = await api(`/cogmemai/memory/${memory_id}`, 'PATCH', body);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
  );

  // ─── 8. get_usage ────────────────────────────────────────

  server.tool(
    'get_usage',
    'Get current usage statistics — memory count, extractions this month, tier info, projects.',
    {},
    async () => {
      const result = await api('/cogmemai/usage', 'GET');
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
  );
}
