#!/usr/bin/env node
/**
 * CogmemAi — Cognitive Memory for Claude Code
 *
 * MCP server that gives Claude Code persistent memory across sessions.
 * Developers install with one command, set one env var, and Claude Code
 * remembers architecture, patterns, decisions, bugs, and preferences.
 *
 * Run: npx cogmemai-mcp setup
 * Docs: https://hifriendbot.com/developer/
 */

import { VERSION, STORAGE_MODE } from './config.js';
import { runSetup, runVerify, showHelp, runHookPrecompact, runHookContextReload, runHookStop } from './cli.js';

// Shared state: latest version from npm (set by checkForUpdate, read by tools)
export let latestVersion: string | null = null;

// ── CLI routing ───────────────────────────────────────────────
// Check if invoked with a subcommand (setup, verify, help).
// If so, run the CLI flow. Otherwise, start the MCP server.

const subcommand = process.argv[2]?.toLowerCase();

if (subcommand === 'setup') {
  const providedKey = process.argv[3];
  runSetup(providedKey).catch((err) => {
    console.error('Setup failed:', err.message || err);
    process.exit(1);
  });
} else if (subcommand === 'hook') {
  const hookName = process.argv[3]?.toLowerCase();
  if (hookName === 'precompact') {
    runHookPrecompact().catch(() => process.exit(0));
  } else if (hookName === 'context-reload') {
    runHookContextReload().catch(() => process.exit(0));
  } else if (hookName === 'stop') {
    runHookStop().catch(() => process.exit(0));
  } else {
    console.error(`Unknown hook: ${hookName}. Available: precompact, context-reload, stop`);
    process.exit(1);
  }
} else if (subcommand === 'verify') {
  runVerify().catch((err) => {
    console.error('Verify failed:', err.message || err);
    process.exit(1);
  });
} else if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
  showHelp();
} else if (subcommand === '--version' || subcommand === '-v' || subcommand === 'version') {
  console.log(`cogmemai-mcp ${VERSION}`);
} else if (subcommand === 'serve' || process.env.COGMEMAI_TRANSPORT === 'http') {
  // Remote HTTP server mode
  import('./http-server.js').then(({ startHttpServer }) => startHttpServer()).catch((err) => {
    console.error('Failed to start HTTP server:', err.message || err);
    process.exit(1);
  });
} else {
  // Default: start MCP server (stdio)
  startMcpServer();
}

// ── Version check ────────────────────────────────────────────

function checkForUpdate(): void {
  fetch('https://registry.npmjs.org/cogmemai-mcp/latest', {
    signal: AbortSignal.timeout(5000),
  })
    .then((res) => res.json())
    .then((data: unknown) => {
      const latest = (data as { version?: string }).version;
      if (latest && latest !== VERSION) {
        latestVersion = latest;
        console.error(
          `\n  ⚡ Update available: cogmemai-mcp v${VERSION} → v${latest}` +
          `\n     Run: npx cogmemai-mcp@latest setup\n`
        );
      }
    })
    .catch(() => {}); // Silently ignore network errors
}

// ── MCP Server ────────────────────────────────────────────────

async function startMcpServer() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { registerTools } = await import('./tools.js');
  const { createStorage } = await import('./storage.js');

  const storage = await createStorage();

  const server = new McpServer(
    {
      name: 'cogmemai',
      version: VERSION,
    },
    {
      instructions: getSystemInstructions(STORAGE_MODE),
    }
  );

  registerTools(server, storage);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`CogmemAi MCP server v${VERSION} running on stdio (${STORAGE_MODE} mode)`);

  // Non-blocking version check — writes to stderr and sets latestVersion for tools
  checkForUpdate();
}

// ── System Instructions by Mode ──────────────────────────────

function getSystemInstructions(mode: string): string {
  const CORE_INSTRUCTIONS = `You have persistent memory powered by CogmemAi. Use it proactively:

## CRITICAL: Always Have Context Loaded
Before responding to any user message, verify you have CogmemAi project context
in this conversation. If you cannot see the results of a recent get_project_context
call in your conversation history, call it NOW before doing anything else.
This ensures you always have relevant memories available, even after context
compaction or session restart. This is what makes you remember — never skip it.

## On Session Start
- Call get_project_context to load your top memories (by importance) from previous sessions for this project.
- Pass an optional context parameter describing the current task to get more relevant memories.
- Read the returned memories carefully — they contain architecture decisions, preferences, patterns, and context from past work.

## While Working — Be Proactive
Use your memory tools continuously, not just when asked:
- When you edit a file, save what you changed immediately (see Session Protection below).
- When you learn something important about the codebase (architecture, tech stack, patterns, conventions), save it with save_memory.
- When the user tells you a preference or makes a decision, save it immediately.
- When you fix a bug or discover a gotcha, save it so you remember next time. Include what broke, the root cause, and the fix — with file paths and method names. This builds a searchable fix database.
- When you encounter a new bug or error, ALWAYS call recall_memories first with the error message or symptom. A fix may already exist from a previous session or team member. Search before you debug.
- When you add or remove code, save the details so post-compaction you don't duplicate or undo your own work.
- When a topic comes up that might have prior context, call recall_memories to check before answering.
- When the user asks about their projects, work history, past decisions, or anything from prior sessions, ALWAYS call recall_memories first — never say "I don't know" without searching.
- When you encounter something you should have known from a previous session, that's a sign you should be saving more.

## What to Save (with importance guidelines)
- Architecture decisions and tech stack details (importance: 8-10)
- User preferences for coding style, tools, workflow (importance: 7-9)
- Bug fixes, gotchas, and workarounds (importance: 6-8)
- Key file paths and project structure (importance: 7-9)
- Dependency versions and constraints (importance: 5-7)
- Patterns and conventions used in the codebase (importance: 6-8)

## Memory Types
Use the right type for better organization and retrieval:
- **identity** — Who the user is, their role, team
- **preference** — Coding style, tool choices, conventions
- **architecture** — System design, tech stack, file structure
- **decision** — Why X was chosen over Y
- **bug** — Known issues, fixes, workarounds
- **dependency** — Version constraints, package notes
- **pattern** — Reusable patterns, conventions
- **context** — General project context

## Categories
Organize memories by domain: frontend, backend, database, devops, testing, security, performance, tooling, api, general. Custom categories are also accepted.

## Scoping
- Use scope "project" for things specific to this codebase (default)
- Use scope "global" for user preferences and identity that apply everywhere

## Task Tracking
Track work across sessions with persistent tasks:
- save_task — Create a task with title, description, status (pending/in_progress/done/blocked), and priority (high/medium/low)
- get_tasks — Load tasks at session start to pick up where you left off
- update_task — Update status, priority, or description as work progresses

## Memory Management
- recall_memories — Search your memories. Use when you need something specific.
- list_memories — Browse and filter memories by type, category, scope, or tag. Supports sorting and pagination.
- update_memory — Change content, importance, type, category, subject, or tags on existing memories.
- bulk_update / bulk_delete — Efficient batch operations for cleanup.

## Session Protection — Save Early, Save Often
Sessions can crash, compact, or terminate unexpectedly. Context compaction can erase
your working memory mid-session. Do NOT wait until the end to save — you may never get the chance.

**Save a memory IMMEDIATELY after each of these events:**
- **Every file edit** — Save the exact file path, what was changed (method/function names, line ranges), and why.
- **New code introduced** — Save new method/function/class signatures, their file location, and purpose.
- **Code removed** — Save what was deleted and why, so you don't accidentally re-introduce it.
- **Bug fix** — Save what broke, root cause, and the fix applied.
- **New API endpoint or route** — Save the route path, handler, file, and purpose.
- **User decision or preference** — Save it the moment they say it.
- **Every 3-4 edits** — Save a running list of all files modified this session.

**What to include in edit memories:**
- Full absolute file path (never relative)
- Method/function names added, modified, or removed
- Approximate line numbers or ranges
- The reason for the change
- Use TTL "7d" for transient edit tracking, no TTL for architectural changes

## Session End
- save_session_summary — Capture what was accomplished, key decisions, and next steps. Helps future sessions pick up seamlessly.

## Working with CLAUDE.md / auto-memory files
If your editor also uses a local memory file (like CLAUDE.md or auto-memory), keep it slim — just critical rules and quick-reference paths (~30-50 lines). Let CogmemAi handle the detailed, searchable knowledge. The local file is a safety net for when the MCP server hasn't loaded yet; CogmemAi is the real memory. Avoid duplicating the same facts in both places.

## Tips
- Keep memories concise — complete sentences, 1-2 lines each.
- Use descriptive subjects like "auth_system", "database_setup", "css_conventions".
- Higher importance = surfaced more often. Reserve 9-10 for core architecture.
- Use tags to group related memories (e.g. ["auth", "oauth2"]).
- Export memories with export_memories for backup. Import with import_memories.
- Memories work across any MCP-compatible editor and any AI model — they are not tied to one tool or platform.`;

  // Cloud-only sections appended for cloud and hybrid modes
  const CLOUD_INTELLIGENCE = `

## Correction Learning
Prevent repeated mistakes:
- save_correction — Record "wrong approach → right approach" patterns with context
- Corrections surface automatically in future sessions when similar situations arise

## Session Reminders
- set_reminder — Set a nudge that appears at the start of the next session (e.g. "Check if PR was merged")
- Reminders auto-expire after their TTL (default 7 days)

## Advanced Memory Management
- recall_memories supports context_type (debugging/planning/reviewing) for type-aware ranking, and synthesize=true for AI-synthesized answers from multiple memories. Automatically detects contradictions (same-subject conflicts) in results.
- get_stale_memories — Find outdated memories that need review or removal.
- consolidate_memories — Merge related memories into fewer, richer summaries. Use dry_run first to preview.
- Use promote_memory to upgrade a project memory to global when you discover it applies everywhere.

## Intelligence Features (Automatic)
The memory system includes self-improving intelligence that works automatically:
- **Self-improving recall**: Memories that are frequently useful rank higher over time (reference boost).
- **Memory decay**: Stale, unreferenced memories gradually sink in ranking. Core memories (importance 9-10) never decay.
- **Auto-linking**: When you save a memory similar to an existing one (similarity 0.65+), they are automatically linked in the knowledge graph.
- **Contradiction detection**: Recall results flag when multiple memories share the same subject, suggesting consolidation.
- **Cross-project pattern detection**: When a subject appears in 3+ projects, it is auto-promoted to global scope.
- **Proactive insights**: get_project_context surfaces stale critical memories, duplicate subjects needing consolidation, and cross-project promotion candidates.

## Auto-Generated Skills (Closed-Loop Learning)
CogmemAi automatically synthesizes behavioral skills from your corrections, preferences, and patterns.
When enough evidence accumulates on a subject (3+ corrections/preferences/decisions), CogmemAi generates
a behavioral directive — an instruction that tells the AI HOW to behave, not just what to know.

Skills appear in get_project_context as "Behavioral Skills" — treat them as rules to follow, not facts to reference.
Skills have a confidence score (0.0-1.0) that adjusts automatically:
- Confidence increases when the skill proves useful (no further corrections on the subject)
- Confidence decreases when new corrections contradict the skill (it's not working)
- Low-confidence skills are automatically retired after self-evaluation

This creates a closed learning loop: detect pattern → generate skill → measure effectiveness → adapt or retire.
Use generate_skills to manually trigger skill creation, or let it happen automatically.
If a skill is wrong, delete it or give it "irrelevant" feedback via feedback_memory.

## Learned Principles (Wisdom Engine)
CogmemAi automatically detects factual patterns across your memories and extracts principles.
While skills are behavioral ("always do X"), principles are factual ("this codebase tends to have Y").
Principles are extracted from clusters of 5+ related memories spanning multiple subjects.
They appear in get_project_context with a confidence score and evidence count.
Use extract_principles to manually trigger pattern detection, or let it happen automatically.
Principles have a lifecycle: candidate → established → proven → challenged → retired.

## Knowledge Graph
Build connections between related memories:
- link_memories — Connect two memories with a relationship: led_to, contradicts, extends, or related. (Auto-linking also creates 'related' links automatically on save.)
- get_memory_links — Explore connections around a memory.
- get_memory_versions — View edit history of a memory to understand how decisions evolved.

## Document Ingestion
- ingest_document — Feed in a README, architecture doc, or API spec to auto-extract memories. Great for onboarding on a new project.

## Analytics and Health
- get_analytics — Memory health dashboard with usage patterns, growth trends, and cleanup opportunities.
- get_usage — Check memory count, extractions this month, and tier info.
- get_file_changes — See what files changed since the last session.

## Mandatory Rules
CogmemAi supports **rules** — mandatory memories that ALWAYS surface in every session, regardless of relevance scoring.
Use rules for absolute requirements the user has stated: "NEVER do X", "ALWAYS do Y", hard constraints that must never be violated.
Rules bypass all scoring, decay, and filtering. They appear first in get_project_context, before skills and memories.
- **save_rule** — create a mandatory rule (auto importance 10, no decay)
- **list_rules** — view all active rules
- **delete_rule** — remove a rule by ID
When a user says something is a hard requirement, an absolute rule, or a "never/always" directive, save it as a rule, not a memory.

## Tool Selection Guide
| Goal | Tool |
|------|------|
| Load context at session start | get_project_context |
| Save a fact or decision | save_memory |
| Save an absolute rule | save_rule |
| List/manage rules | list_rules / delete_rule |
| Find a specific memory | recall_memories |
| Browse/filter memories | list_memories |
| Learn from a conversation | extract_memories |
| Onboard from docs | ingest_document |
| Track cross-session work | save_task / get_tasks |
| Avoid repeated mistakes | save_correction |
| Set next-session nudge | set_reminder |
| Connect related memories | link_memories |
| Improve recall quality | feedback_memory (useful/irrelevant) |
| Extract factual patterns | extract_principles |
| Clean up old memories | get_stale_memories / consolidate_memories |
| Check system health | get_analytics / get_usage |
| End of session | save_session_summary |`;

  if (mode === 'local') {
    return `⚡ CogmemAi is running in LOCAL MODE (SQLite on your machine).

Local mode gives you: save, recall (keyword search), list, update, delete, export, import, tasks, and session summaries.

What you're missing in local mode:
- Semantic search (understands meaning, not just keywords — "how does auth work?" finds JWT and cookie memories)
- Auto-linking, contradiction detection, memory decay
- Auto-Skills (closed-loop behavioral learning from your corrections)
- Knowledge graph, version history, memory consolidation
- Ai-powered extraction and document ingestion
- Team collaboration and cross-device portability

Important: Local memory is NOT more private than cloud. Every memory your Ai reads gets sent to the model provider
(Anthropic, OpenAI, Google) at inference time. The data leaves your machine regardless of where it's stored.
Cloud mode adds encryption at rest, secret detection, and intelligent features — with the same data flow.

Upgrade to cloud (free tier available): https://hifriendbot.com/developer/
Set COGMEMAI_MODE=cloud or COGMEMAI_MODE=hybrid with your API key.

${CORE_INSTRUCTIONS}

## Tool Selection Guide (Local Mode)
| Goal | Tool |
|------|------|
| Load context at session start | get_project_context |
| Save a fact or decision | save_memory |
| Save an absolute rule | save_rule |
| List/manage rules | list_rules / delete_rule |
| Find a specific memory | recall_memories (keyword search) |
| Browse/filter memories | list_memories |
| Track cross-session work | save_task / get_tasks |
| Improve recall quality | feedback_memory (useful/irrelevant) |
| End of session | save_session_summary |`;
  }

  if (mode === 'hybrid') {
    return `⚡ CogmemAi is running in HYBRID MODE — the best of both worlds.

Hybrid mode saves memories locally (fast, guaranteed) AND to cloud (intelligent, portable).
Reads prefer cloud semantic search with automatic local fallback if offline.
Unsynced memories push to cloud at session start and end.

You get the full CogmemAi Intelligence Engine plus offline resilience:
- Semantic search with local keyword fallback
- Auto-linking, contradiction detection, memory decay
- Auto-Skills, knowledge graph, version history
- Ai-powered extraction and document ingestion
- Team collaboration and cross-device portability
- Works offline — local SQLite keeps your memories safe when cloud is unreachable

${CORE_INSTRUCTIONS}
${CLOUD_INTELLIGENCE}`;
  }

  // Cloud mode — full instructions (default)
  return `${CORE_INSTRUCTIONS}
${CLOUD_INTELLIGENCE}`;
}
