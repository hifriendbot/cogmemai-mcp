<p align="center">
  <img src="assets/hero.png" alt="CogmemAi — Why Claude Code Forgets Everything (And How to Fix It)" width="800">
</p>

# CogmemAi — Cognitive Memory for Claude Code

**Claude Code forgets everything between sessions. CogmemAi fixes that.**

One command. Claude Code remembers your architecture, patterns, decisions, bugs, and preferences — permanently.

## What's New in v3.0

- **Task tracking** — save tasks that persist across sessions with status and priority, so you always pick up where you left off
- **Correction learning** — teach Claude what went wrong and what's right, so mistakes aren't repeated
- **Session reminders** — set nudges that surface automatically at the start of your next session
- **Stale memory detection** — find outdated memories that need review or cleanup
- **File change awareness** — see what files changed since your last session, powered by automatic git snapshots
- **Smart recall** — relevant memories surface automatically as you switch topics
- **Auto-learning** — CogmemAi learns from your sessions automatically
- **Memory consolidation** — merge related memories into comprehensive summaries
- **28 tools** — the most complete memory toolkit for Ai coding assistants

## Quick Start

```bash
npx cogmemai-mcp setup
```

That's it. The setup wizard verifies your API key, configures Claude Code, installs automatic context recovery, and you're ready. Start Claude Code by typing `claude` and your memories are ready.

Don't have an API key yet? Get one free at [hifriendbot.com/developer](https://hifriendbot.com/developer/).

## The Problem

Every time you start a new Claude Code session, you lose context. You re-explain your tech stack, your architecture decisions, your coding preferences. Claude Code's built-in memory is a flat file with no search, no structure, and no intelligence.

CogmemAi gives Claude Code a real memory system:

- **Semantic search** — finds relevant memories by meaning, not keywords
- **Ai-powered extraction** — automatically identifies facts worth remembering from your conversations
- **Smart deduplication** — detects duplicate and conflicting memories automatically
- **Privacy controls** — auto-detects API keys, tokens, and secrets before storing
- **Document ingestion** — feed in READMEs and docs to instantly build project context
- **Project scoping** — memories tied to specific repos, plus global preferences that follow you everywhere
- **Smart context** — blends importance, semantic relevance, and recency for optimal retrieval
- **Compaction recovery** — survives Claude Code context compaction automatically
- **Token-efficient** — compact context loading that won't bloat your conversation
- **Zero setup** — no databases, no Docker, no Python, no vector stores

## Why Cloud Memory?

Local memory solutions come with maintenance overhead: database management, version conflicts, storage growth, and setup complexity. CogmemAi runs extraction and search server-side. Your MCP server is a thin HTTP client — **zero local databases, zero RAM issues, zero maintenance.**

## Compaction Recovery

When Claude Code compacts your context, conversation history gets compressed and context is lost. CogmemAi handles this automatically — your context is preserved before compaction and seamlessly restored afterward. No re-explaining, no manual prompting.

The `npx cogmemai-mcp setup` command configures everything automatically.

## Skill

CogmemAi includes a [Claude Skill](https://github.com/hifriendbot/cogmemai-mcp/tree/main/skill/cogmemai-memory) that teaches Claude best practices for memory management — when to save, importance scoring, memory types, and session workflows.

**Claude Code:**
```
/skill install https://github.com/hifriendbot/cogmemai-mcp/tree/main/skill/cogmemai-memory
```

**Claude.ai:** Upload the `skill/cogmemai-memory` folder in Settings > Skills.

**Claude API:** Use the [Skills API](https://docs.claude.com/en/api/skills-guide) to attach the skill to your requests.

## CLI Commands

```bash
npx cogmemai-mcp setup          # Interactive setup wizard
npx cogmemai-mcp setup <key>    # Setup with API key
npx cogmemai-mcp verify         # Test connection and show usage
npx cogmemai-mcp --version      # Show installed version
npx cogmemai-mcp help           # Show all commands
```

## Manual Setup

If you prefer to configure manually instead of using `npx cogmemai-mcp setup`:

**Option A — Per project** (add `.mcp.json` to your project root):

```json
{
  "mcpServers": {
    "cogmemai": {
      "command": "cogmemai-mcp",
      "env": {
        "COGMEMAI_API_KEY": "cm_your_api_key_here"
      }
    }
  }
}
```

**Option B — Global** (available in every project):

```bash
claude mcp add cogmemai cogmemai-mcp -e COGMEMAI_API_KEY=cm_your_api_key_here --scope user
```

## Works With

### Claude Code (Recommended)

Automatic setup:
```bash
npx cogmemai-mcp setup
```

### Cursor

Add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "cogmemai": {
      "command": "npx",
      "args": ["-y", "cogmemai-mcp"],
      "env": { "COGMEMAI_API_KEY": "cm_your_api_key_here" }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:
```json
{
  "mcpServers": {
    "cogmemai": {
      "command": "npx",
      "args": ["-y", "cogmemai-mcp"],
      "env": { "COGMEMAI_API_KEY": "cm_your_api_key_here" }
    }
  }
}
```

### Cline (VS Code)

Open VS Code Settings > Cline > MCP Servers, add:
```json
{
  "cogmemai": {
    "command": "npx",
    "args": ["-y", "cogmemai-mcp"],
    "env": { "COGMEMAI_API_KEY": "cm_your_api_key_here" }
  }
}
```

### Continue

Add to `~/.continue/config.yaml`:
```yaml
mcpServers:
  - name: cogmemai
    command: npx
    args: ["-y", "cogmemai-mcp"]
    env:
      COGMEMAI_API_KEY: cm_your_api_key_here
```

Get your free API key at [hifriendbot.com/developer](https://hifriendbot.com/developer/).

## Tools

CogmemAi provides 28 tools that your Ai assistant uses automatically:

| Tool | Description |
|------|-------------|
| `save_memory` | Store a fact explicitly (architecture decision, preference, etc.) |
| `recall_memories` | Search memories using natural language (semantic search) |
| `extract_memories` | Ai extracts facts from a conversation exchange automatically |
| `get_project_context` | Load top memories at session start (with smart ranking and compact mode) |
| `list_memories` | Browse memories with filters (paginated, with untyped filter) |
| `update_memory` | Update content, importance, scope, type, category, subject, and tags |
| `delete_memory` | Permanently delete a memory |
| `bulk_delete` | Delete up to 100 memories at once |
| `bulk_update` | Update up to 50 memories at once (content, type, category, tags, etc.) |
| `get_usage` | Check your usage stats and tier info |
| `export_memories` | Export all memories as JSON for backup or transfer |
| `import_memories` | Bulk import memories from a JSON array |
| `ingest_document` | Feed in a document (README, API docs) to auto-extract memories |
| `save_session_summary` | Save a summary of what was accomplished in this session |
| `list_tags` | View all tags in use across your memories |
| `link_memories` | Connect related memories with named relationships |
| `get_memory_links` | Explore the knowledge graph around a memory |
| `get_memory_versions` | View edit history of a memory |
| `get_analytics` | Memory health dashboard with insights (filterable by project) |
| `promote_memory` | Promote a project memory to global scope |
| `consolidate_memories` | Merge related memories into comprehensive summaries using Ai |
| `save_task` | Create a persistent task with status and priority tracking |
| `get_tasks` | Retrieve tasks for the current project — pick up where you left off |
| `update_task` | Change task status, priority, or description as you work |
| `save_correction` | Store a "wrong approach → right approach" pattern to avoid repeated mistakes |
| `set_reminder` | Set a reminder that surfaces at the start of your next session |
| `get_stale_memories` | Find memories that may be outdated for review or cleanup |
| `get_file_changes` | See what files changed since your last session |

## SDKs

Build your own integrations with the CogmemAi API:

- **JavaScript/TypeScript:** `npm install cogmemai-sdk` — [npm](https://www.npmjs.com/package/cogmemai-sdk) · [GitHub](https://github.com/hifriendbot/cogmemai-sdk)
- **Python:** `pip install cogmemai` — [PyPI](https://pypi.org/project/cogmemai/) · [GitHub](https://github.com/hifriendbot/cogmemai-python)

## Memory Types

Memories are categorized for better organization and retrieval:

- **identity** — Who you are, your role, team
- **preference** — Coding style, tool choices, conventions
- **architecture** — System design, tech stack, file structure
- **decision** — Why you chose X over Y
- **bug** — Known issues, fixes, workarounds
- **dependency** — Version constraints, package notes
- **pattern** — Reusable patterns, conventions
- **context** — General project context
- **task** — Persistent tasks with status and priority tracking
- **correction** — Wrong approach → right approach patterns
- **reminder** — Next-session nudges that auto-expire

## Scoping

- **Project memories** — Architecture, decisions, bugs specific to one repo. Auto-detected from `git remote`.
- **Global memories** — Your coding preferences, identity, tool choices. Available in every project.

## Pricing

| | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| **Price** | $0 | $14.99/mo | $39.99/mo | $99.99/mo |
| **Memories** | 1,000 | 2,000 | 10,000 | 50,000 |
| **Extractions/mo** | 500 | 2,000 | 5,000 | 20,000 |
| **Projects** | 5 | 20 | 50 | 200 |

Start free. Upgrade when you need more.

## Privacy & Security

- **No source code leaves your machine.** We store extracted facts (short sentences), never raw code.
- **API keys hashed** with SHA-256 (irreversible) server-side.
- **All traffic over HTTPS.**
- **No model training** on your data. Ever.
- **Delete everything** instantly via dashboard or MCP tool.
- **No cross-user data sharing.**

Read our full [privacy policy](https://hifriendbot.com/privacy-policy/).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `COGMEMAI_API_KEY` | Yes | Your API key (starts with `cm_`) |
| `COGMEMAI_API_URL` | No | Custom API URL (default: hifriendbot.com) |

## Support

- Issues: [GitHub Issues](https://github.com/hifriendbot/cogmemai-mcp/issues)
- Docs: [hifriendbot.com/developer](https://hifriendbot.com/developer/)

## License

MIT — see [LICENSE](./LICENSE)

---

Built by [HiFriendbot](https://hifriendbot.com) — Better Friends, Better Memories, Better Ai.
