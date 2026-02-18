# CogmemAi — Cognitive Memory for Claude Code

**Claude Code forgets everything between sessions. CogmemAi fixes that.**

One command. One env var. Claude Code remembers your architecture, patterns, decisions, bugs, and preferences — permanently.

```
npx -y cogmemai-mcp
```

## The Problem

Every time you start a new Claude Code session, you lose context. You re-explain your tech stack, your architecture decisions, your coding preferences. Claude Code's built-in memory is a 200-line flat file with no search, no structure, and no intelligence.

CogmemAi gives Claude Code a real memory system:

- **Semantic search** — finds relevant memories by meaning, not keywords
- **Ai-powered extraction** — automatically identifies facts worth remembering from your conversations
- **Project scoping** — memories tied to specific repos, plus global preferences that follow you everywhere
- **Time-aware surfacing** — recent and important memories rank higher
- **Zero setup** — no databases, no Docker, no Python, no vector stores

## Why Not Local Memory?

Every local memory solution has the same problems: database corruption, memory leaks, version conflicts, complex setup. [claude-mem](https://github.com/nicobailon/claude-mem) (13K+ stars) leaks 15GB+ of RAM. [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) released v10.0.0 marked "BROKEN."

CogmemAi runs extraction and search server-side. Your MCP server is a thin HTTP client — **zero local databases, zero RAM issues, zero crashes.**

## Quick Start

### 1. Get your API key

Sign up at [hifriendbot.com/developer](https://hifriendbot.com/developer/) and generate an API key.

### 2. Install

```bash
npm install -g cogmemai-mcp
```

### 3. Add to Claude Code

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

**Option B — Global** (available in every project, no `.mcp.json` needed):

```bash
claude mcp add-json cogmemai '{"command":"cogmemai-mcp","env":{"COGMEMAI_API_KEY":"cm_your_api_key_here"}}' --scope user
```

### 4. Done

Restart Claude Code. It now has persistent memory — it will remember your architecture, preferences, and decisions across every session. No prompting needed.

## Tools

CogmemAi provides 8 tools that Claude Code can use automatically:

| Tool | Description |
|------|-------------|
| `save_memory` | Store a fact explicitly (architecture decision, preference, etc.) |
| `recall_memories` | Search memories using natural language (semantic search) |
| `extract_memories` | Ai extracts facts from a conversation exchange automatically |
| `get_project_context` | Load all relevant memories at session start |
| `list_memories` | Browse all memories with filters |
| `update_memory` | Update a memory's content, importance, or scope |
| `delete_memory` | Permanently delete a memory |
| `get_usage` | Check your usage stats and tier info |

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

## Scoping

- **Project memories** — Architecture, decisions, bugs specific to one repo. Auto-detected from `git remote`.
- **Global memories** — Your coding preferences, identity, tool choices. Available in every project.

## Pricing

| | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| **Price** | $0 | $14.99/mo | $39.99/mo | $99.99/mo |
| **Memories** | 50 | 2,000 | 10,000 | 50,000 |
| **Extractions/mo** | 100 | 2,000 | 5,000 | 20,000 |
| **Projects** | 2 | 20 | 50 | 200 |

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

## How It Works

```
Your Terminal                          CogmemAi Cloud
┌──────────────┐                     ┌─────────────────────┐
│ Claude Code  │                     │ 3-Layer Memory      │
│              │                     │                     │
│ cogmemai-mcp │ ──── HTTPS ────►    │ 1. Ai Extraction    │
│ (MCP Server) │ ◄──── JSON ────    │ 2. Semantic Search  │
│              │                     │ 3. Time-Aware Rank  │
└──────────────┘                     └─────────────────────┘
```

1. **Extraction** — When Claude Code works on your project, CogmemAi's Ai identifies important facts (architecture decisions, preferences, bugs) and stores them.
2. **Embedding** — Each memory gets a semantic embedding vector for meaning-based search.
3. **Surfacing** — When you start a new session, relevant memories are surfaced by meaning, importance, and recency.

## Works Everywhere

CogmemAi works in any terminal that runs Claude Code:

- PowerShell
- bash / zsh
- Windows Terminal
- macOS Terminal / iTerm2
- VS Code terminal
- Any SSH session

## Support

- Issues: [GitHub Issues](https://github.com/hifriendbot/cogmemai-mcp/issues)
- Docs: [hifriendbot.com/developer](https://hifriendbot.com/developer/)

## License

MIT — see [LICENSE](./LICENSE)

---

Built by [HiFriendbot](https://hifriendbot.com) — Better Friends, Better Memories, Better Ai.
