<p align="center">
  <img src="assets/hero.png" alt="CogmemAi — Cognitive Memory for Any Ai System" width="800">
</p>

[![npm version](https://img.shields.io/npm/v/cogmemai-mcp)](https://www.npmjs.com/package/cogmemai-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Quantum Safe](https://img.shields.io/badge/🛡%EF%B8%8F_Quantum-Safe-02ffba?style=flat&labelColor=1a1a2e)](https://hifriendbot.com/developer/)

# CogmemAi — Cognitive Memory for Any Ai System

**Autonomous robots. Self-driving vehicles. Defense systems. Coding assistants. Any Ai system that needs to remember.**

<p align="center">
  <img src="assets/demo.svg" alt="CogmemAi demo — your Ai assistant remembers your project across sessions" width="800">
</p>

CogmemAi is a portable memory layer that gives any Ai system persistent recall across sessions, devices, users, and teams — and captures knowledge autonomously, even when your Ai forgets to save. **95.10% accuracy on LongMemEval — top published score on the field's hardest long-term memory benchmark.** 91% on LoCoMo, above human performance (87.9%). Quantum-safe encryption. Works with Claude Code, Cursor, Windsurf, Cline, Continue, and any MCP-compatible tool. Switch editors, switch models, switch machines — your knowledge stays. Not just one score on a test — the most complete Ai memory system available.

## What's New in v3

### CogmemAi Intent: You Read the Intent, Not the Code (v3.26.0)

Spec files that live in a repository are per-repo, per-tool, and they rot. v3.26.0 adds one plain-English intent document per project that lives with you instead: what the project is for, what must always hold, what was decided and why, and what is out of scope. Write it with `set_intent`, read it with `get_intent`. Every session loads it right after the rules, every replacement is versioned, and it follows you into every tool that talks to CogmemAi.

Then it does two things a spec file cannot. The sentences under **Invariants** are compiled into the same enforceable patterns as rule memories, so `NEVER run \`pkill -u www lsphp\`` in your intent denies that command before it runs, with no network call. And at the end of every turn the changes are judged against the document on the CogmemAi server and reported in plain English for someone who does not read code: what changed, whether the intent covers it, what conflicts with it, and what the intent does not mention yet. A covered change earns silence. `COGMEMAI_INTENT_VERBOSE=1` shows the summary on every judged turn. Every check is logged to `~/.cogmemai/intent-log.jsonl`, so precision is measured rather than assumed.

The judged check runs on the paid tiers; the free tier still gets the enforced invariants and every deterministic review. See [Intent](#intent) below.

### CogmemAi Guard: Your Memory Now Stops Your Ai From Repeating Mistakes (v3.24.0)

Memory that only advises is memory your Ai can ignore under pressure. v3.24.0 adds a guard that turns what your project remembers into enforcement.

A PreToolUse hook judges every shell command before it runs. Six built-in rules cover the operations with no good unattended use: rewriting a whole crontab from a pipeline, destructive SQL against a live database, recursive deletes outside temp and build paths, force-pushing to a shared branch, piping a download into a shell, and killing shared server workers by name. The same rules are applied to what a command carries inside `ssh host "..."`, `bash -c "..."`, and a heredoc fed to a shell, because that payload runs on the far side exactly as written.

Then the part only a memory layer can do. Rule memories you save with `save_rule` become enforceable patterns. Write `NEVER run \`pkill -u www lsphp\`` in a rule and the next session denies that command, over ssh too, with the rule's own words as the reason. No code to edit. Add a `GUARD: <regex>` line to a rule for an exact pattern, or `GUARD: off` to keep a rule advisory.

A Stop hook reviews what actually changed at the end of each turn: credentials pasted into tracked source, version strings that disagree across release files, deleted files, large net deletions, a function now defined in two places, and remembered gotchas about the files that were touched. It reports; it never edits.

Every verdict is logged locally with secrets redacted, so precision is measured rather than assumed. Denials name the deliberate path forward, usually "run it yourself". The guard fails open on any error, and git remains the real undo. See [Guard](#guard) below.

v3.25.0 extends it past Claude Code: `guard shell-install` hooks every `bash -c` and `zsh -c` on the machine through `BASH_ENV`, so Cursor, Codex, Gemini CLI, and plain scripts get the same guard, the same remembered rules, and the same log.

### Loud Failures on Firewall Blocks (v3.20.0)

When a request to the CogmemAi backend is intercepted by an upstream firewall, CDN, or proxy, the response is HTML, not JSON. Earlier versions tried to JSON-parse it and threw a confusing `Unexpected token '<'` error, then silently retried the same blocked payload. v3.20.0 detects HTML responses, names the blocking layer when it can (NinjaFirewall, Cloudflare, ModSecurity), and surfaces a clear actionable error. Retryable 4xx responses with HTML bodies no longer trigger retry loops. The class of incident that can silently drop memory writes is now loud.

### Autonomous Memory — Your Ai Doesn't Decide Whether to Save Anymore (v3.15)

Every memory system has the same hidden failure mode: **the Ai has to choose to save, and under pressure it doesn't.** You can bake instructions into system prompts. You can nudge. But when your Ai is head-down on a coding task, it forgets to save — and the decisions you made two hours ago vanish when the context compacts.

CogmemAi v3.15 moves the decision out of the Ai's hands entirely. Your coding sessions are captured at the infrastructure level — decisions, file changes, bug fixes, and deployments land in memory without a single prompt. At session end, an intelligence pass distills them into structured memories: the right types, the right importance scores, the right scopes. Your Ai never sees this happen.

The result: a day of heavy coding produces 15–20 quality memories instead of 3. Future sessions pick up seamlessly. Your Ai stops re-litigating architectural choices you already made. **Stop reminding your Ai to remember. It just does.**

### Proactive Memory Recall (v3.12)

CogmemAi now **thinks before it speaks**. Before your Ai assistant suggests any action, approach, or recommendation, CogmemAi checks its memory first — automatically, on every topic.

- **`preflight` tool** — A fast, lightweight recall designed to be called before every suggestion. Your assistant checks what it already knows about a topic before opening its mouth. "Let's try approach X" → first checks if X was already tried, rejected, or completed. Sub-200ms, near-zero cost.
- **Prior context surfacing** — Every time a memory is saved, CogmemAi automatically searches for related prior memories across all topics — people, companies, technical approaches, features, everything — and surfaces them in the response. Your assistant never suggests something redundant.
- **Smart recall hooks** — In Claude Code, CogmemAi reads every user message and automatically injects relevant memories before the assistant responds. No manual recall needed — context arrives before the assistant starts thinking.
- **Upgraded recall engine** — Higher-dimensional semantic understanding, balanced reranking, keyword-expanded search, dual-path memory storage for more reliable retrieval, and adaptive search that expands automatically when initial results are low confidence.

The result: your Ai assistant stops suggesting things you've already tried, people you've already contacted, and approaches you've already rejected. Your brain is no longer the safety net for what your tools should already know.

### Wisdom Engine — Auto-Extracted Principles (v3.10)

CogmemAi now automatically detects patterns across your memories and extracts **factual principles**. While skills tell your Ai HOW to behave ("always use Zustand"), principles tell it what's TRUE about your project ("this codebase never validates inputs at service boundaries"). Principles are extracted from clusters of 5+ related memories, scored by confidence, and injected into every session. Use `extract_principles` to trigger manually or let it happen automatically.

### Remote MCP — Zero Install (v3.9)

CogmemAi now supports **Streamable HTTP transport** — connect from any MCP client without installing anything. No npm, no config files, no Node.js required. Just point your client to `https://hifriendbot.com/mcp/` with your API key and start using persistent memory immediately. Same 35 tools, same Intelligence Engine, same benchmark-topping accuracy — zero setup friction.

### Quantum-Safe Encryption (v3.7)

CogmemAi is the **first quantum-safe Ai memory system.** All memories are encrypted at rest with quantum-resistant encryption — both in cloud mode and local mode. Your data is protected against today's threats and tomorrow's quantum computers. Encryption is automatic, zero-config, and enabled by default. No setup required.

### Choose Your Storage Mode (v3.6)

CogmemAi now runs three ways — pick the one that fits your workflow:

| | Cloud (default) | Local | Hybrid |
|---|---|---|---|
| **Best for** | Full intelligence, team collaboration, cross-device portability | Zero-config start, offline-only environments | Local speed + cloud brains, travel/unreliable networks |
| **Setup** | `npx cogmemai-mcp setup` (choose Cloud) | `npx cogmemai-mcp setup` (choose Local) | `npx cogmemai-mcp setup` (choose Hybrid) |
| **API key needed** | Yes (free) | Yes (free) — like a license key, your data stays local | Yes (free) |
| **Search** | Semantic (by meaning) | Full-text search (FTS5) | Semantic with local fallback |
| **Intelligence Engine** | Full — auto-linking, contradiction detection, memory decay, auto-skills, query synthesis | FTS5 search + CRUD — data stays on your machine | Full — with offline resilience |
| **Team collaboration** | Yes | No | Yes |
| **Cross-device sync** | Automatic | No — data stays on your machine | Automatic with local cache |
| **Offline support** | Requires internet | Full offline | Falls back to local when offline |
| **Encryption** | Quantum-safe (server) | Quantum-safe (local) | Quantum-safe (both) |

**Cloud mode is the recommended experience.** It gives you the full Intelligence Engine — semantic search that finds memories by meaning, auto-linking knowledge graph, contradiction detection, self-improving recall, auto-skills, query synthesis, and team collaboration. Everything that makes CogmemAi more than just a database.

**Local mode keeps your data on your machine.** A free API key is required for registration (like a software license key), but all your data stays local. Full-text search (FTS5) provides quality recall. Works offline after initial setup. When you're ready for semantic search and the full Intelligence Engine, upgrading to cloud takes one command.

**Hybrid mode is for developers who travel or work on unreliable networks.** Saves to both local and cloud simultaneously. Reads from cloud when available, falls back to local when offline. Unsynced memories automatically push to cloud when connectivity returns.

### Intelligence Engine + Auto-Skills (v3.5)

CogmemAi now gets smarter every time you use it. The Intelligence Engine is a self-improving memory system that learns what matters, connects related knowledge automatically, and synthesizes answers from your entire memory. Auto-Skills takes it further — CogmemAi doesn't just remember, it **learns how to behave**.

### Auto-Skills (Closed-Loop Learning)

- **Behavioral skills** — CogmemAi automatically synthesizes your corrections, preferences, and patterns into behavioral directives that tell your Ai assistant HOW to work, not just what to know
- **Closed learning loop** — correct your assistant once, and CogmemAi detects the pattern. After enough evidence accumulates, it generates a skill that prevents the mistake from ever happening again
- **Confidence tracking** — each skill has a confidence score that rises when it works and drops when it doesn't. Low-confidence skills are automatically retired
- **Self-evaluation** — skills periodically review themselves against new evidence and adapt, strengthen, or retire as your practices evolve

### Intelligence Engine — 95.10% on LongMemEval, 91% on LoCoMo

CogmemAi scores **95.10% accuracy on [LongMemEval](https://github.com/xiaowu0162/LongMemEval)** — the top published score on the field's hardest long-term memory benchmark — and **91% accuracy on [LoCoMo](https://github.com/snap-research/locomo)** with a 100% retrieval hit rate, above human performance (87.9%). Two benchmarks, two #1-tier scores. CogmemAi finds the right memories when you need them.

- **Precision reranking** — every recall runs a second-pass reranker that re-scores candidates for precision, balanced with the initial ranking signal to surface the most relevant memory first
- **Self-improving recall** — memories that consistently help you rank higher over time; memories you never use fade naturally. Your recall quality improves automatically with every session
- **Auto-linking knowledge graph** — related memories are automatically connected when you save them. Your knowledge builds into a web of relationships, not a flat list
- **Contradiction detection** — when recalled memories conflict with each other, CogmemAi flags the contradiction so you catch stale or outdated information before it causes problems
- **Context-aware ranking** — tell CogmemAi what you're doing (debugging, planning, reviewing) and it boosts the right types of memories. Debugging? Bug reports and patterns surface first. Planning? Architecture decisions lead
- **Query synthesis** — ask a question and get one coherent answer synthesized from all your relevant memories, not just a list of matches. Like asking a teammate who's read everything
- **Cross-project intelligence** — patterns that appear across 3+ projects are automatically promoted to global scope. Your best practices follow you everywhere without manual effort
- **Proactive insights** — at session start, CogmemAi tells you what you should know before you ask. Stale critical memories, duplicate subjects that need merging, patterns ready for promotion

### Also in v3

- **Memory health score** — 0-100 score with actionable factors
- **Session replay** — pick up exactly where you left off with automatic session summaries
- **Self-tuning memory** — importance adjusts based on real usage; stale memories auto-archive
- **Auto-ingest README** — learn from your README on new projects instantly
- **Smart recall** — relevant memories surface automatically as you switch topics
- **Auto-learning** — CogmemAi learns from your sessions automatically
- **Task tracking** — persistent tasks with status and priority
- **Correction learning** — teach your assistant to avoid repeated mistakes
- **Session reminders** — nudges that surface at the start of your next session
- **Mandatory rules** — define absolute requirements ("NEVER do X", "ALWAYS do Y") that surface in every session, bypassing all scoring and decay
- **Autonomous memory** — captures work even when your Ai skips saves
- **35+ tools** — the most complete memory toolkit for any Ai system

## Quick Start

### Option 1: Remote (Zero Install)

Connect directly — no npm, no setup, no config files. Just add the remote endpoint to your MCP client with your API key:

**Endpoint:** `https://hifriendbot.com/mcp/`
**Auth:** Bearer token (your `cm_` API key)

Get your free API key at [hifriendbot.com/developer](https://hifriendbot.com/developer/).

Works with any MCP client that supports Streamable HTTP transport (Claude Desktop, Cursor, and more).

### Option 2: Local Install

```bash
npx cogmemai-mcp setup
```

The setup wizard walks you through three choices: **Cloud** (recommended — full Ai intelligence), **Local** (data stays on your machine), or **Hybrid** (both). Pick your mode, enter your API key if needed, and you're ready in under 60 seconds.

Don't have an API key yet? Get one free at [hifriendbot.com/developer](https://hifriendbot.com/developer/). Or choose Local mode to start immediately with no account.

## The Problem

Every time you start a new session, you lose context. You re-explain your tech stack, your architecture decisions, your coding preferences. Built-in memory in tools like Claude Code is a flat file with no search, no structure, and no intelligence.

CogmemAi gives your Ai assistant a real memory system:

- **Semantic search** — finds relevant memories by meaning, not keywords
- **Ai-powered extraction** — automatically identifies facts worth remembering from your conversations
- **Smart deduplication** — detects duplicate and conflicting memories automatically
- **Privacy controls** — auto-detects API keys, tokens, and secrets before storing
- **Document ingestion** — feed in READMEs and docs to instantly build project context
- **Project scoping** — memories tied to specific repos, plus global preferences that follow you everywhere
- **Smart context** — intelligently ranked for maximum relevance to your current work
- **Autonomous memory capture** — saves knowledge even when your Ai forgets to call save. Decisions, file changes, and fixes land in memory without prompting
- **Compaction recovery** — survives Claude Code context compaction automatically
- **Token-efficient** — compact context loading that won't bloat your conversation
- **Zero setup** — no databases, no Docker, no Python, no vector stores

## Why Cloud Is the Recommended Mode

CogmemAi offers three storage modes, but cloud is where the magic happens. The Intelligence Engine — semantic search, auto-linking knowledge graph, contradiction detection, self-improving recall, auto-skills, and query synthesis — runs server-side. In cloud mode, your MCP server is a thin HTTP client with **zero local databases, zero RAM issues, zero maintenance.** All memories are encrypted at rest, so your data is just as secure as local storage — with cross-device portability and team features on top.

**Your memory follows you everywhere.** Memories created in Claude Code are instantly available in Cursor, Windsurf, Cline, and any MCP-compatible tool. Switch between Opus, Sonnet, Haiku, or any model your editor supports — your memories persist regardless. New laptop? New OS? Log in and your full project knowledge is waiting. A local SQLite file dies with your machine. Cloud memory is permanent.

**The privacy argument is a myth.** Some memory tools market "local-first" as a privacy advantage. But think about what happens next: every memory your Ai reads gets sent to the model provider (Anthropic, OpenAI, Google) as part of the prompt. Your data leaves your machine at inference time no matter where it's stored. A local SQLite file doesn't protect your memories — it just makes them harder to search, slower to access, and impossible to share. CogmemAi encrypts at rest, transmits over HTTPS, and adds intelligence that local storage simply can't match.

**Teams and collaboration.** Cloud memory is the only way to share project knowledge across teammates. When one developer saves an architecture decision or documents a bug fix, every team member's Ai assistant knows about it instantly. No syncing, no merge conflicts, no stale local databases. Whether it's two developers or twenty, everyone's assistant has the same up-to-date context. This is impossible with local-only memory solutions.

## Compaction Recovery

When your Ai assistant compacts your context, conversation history gets compressed and context is lost. CogmemAi handles this automatically — your context is preserved before compaction and seamlessly restored afterward. No re-explaining, no manual prompting.

The `npx cogmemai-mcp setup` command configures everything automatically.

## Skill

CogmemAi includes a [Claude Skill](https://github.com/hifriendbot/cogmemai-mcp/tree/main/skill/cogmemai-memory) that teaches Claude best practices for memory management — when to save, importance scoring, memory types, and session workflows.

**Claude Code:**
```
/skill install https://github.com/hifriendbot/cogmemai-mcp/tree/main/skill/cogmemai-memory
```

**Claude.ai:** Upload the `skill/cogmemai-memory` folder in Settings > Skills.


## CLI Commands

```bash
npx cogmemai-mcp setup          # Interactive setup wizard
npx cogmemai-mcp setup <key>    # Setup with API key
npx cogmemai-mcp verify         # Test connection and show usage
npx cogmemai-mcp --version      # Show installed version
npx cogmemai-mcp help           # Show all commands
npx cogmemai-mcp guard status   # Cached rules for this project and verdict counts
npx cogmemai-mcp guard sync     # Refresh remembered rules from CogmemAi
npx cogmemai-mcp guard test "<command>"   # Judge a command without running it
npx cogmemai-mcp guard log [n]  # Show the last n verdicts
npx cogmemai-mcp guard install  # Add the guard hooks to an existing setup
npx cogmemai-mcp guard shell-install   # Guard bash -c / zsh -c from any tool, not just Claude Code
npx cogmemai-mcp guard shell-remove    # Undo shell-install
```

## Guard

CogmemAi Guard is two Claude Code hooks, installed by `setup` (or by `guard install` on an existing setup). Both fail open: any error, any unparseable input, and the command runs untouched. Neither calls a language model.

**Before a command runs** (`PreToolUse` on Bash), the guard judges the command against six built-in rules and the rules this project remembers. A denial is not a refusal to let something happen; it is a refusal to do it unattended, and every denial says how to proceed deliberately.

| Built-in rule | Why it exists |
|---|---|
| Rewriting a whole crontab from a pipeline | silently destroys scheduled jobs |
| `DELETE`, `DROP`, `TRUNCATE`, `UPDATE` sent to a live database client | a scoped `DELETE` is not proof of safety |
| Recursive delete outside temp, build, and dependency paths | unrecoverable by definition |
| Force-push to main, master, or prod | overwrites commits that exist only on the remote |
| Piping a downloaded script into a shell | runs code nobody has read |
| `pkill` or `killall` of shared server workers by name | aborts every in-flight request on a shared host |

Quoted strings and heredoc bodies are stripped before the rules run, so writing a dangerous command into a notes file is not the same as running it. The payload of `ssh host "..."`, `bash -c "..."`, and a heredoc fed to a shell is judged as if typed directly.

**Rules from memory.** Rule memories (`save_rule`, or any memory with type `rule`) are compiled into patterns and cached locally at session start, so the pre-check needs no network. Two sources:

- A line reading `GUARD: <regex>` is used as written, case-insensitive. `GUARD: off` keeps a rule advisory only.
- A backticked command that follows NEVER, DO NOT, or MUST NOT in the same sentence, when it is shaped like a command (a command name plus at least one argument, no placeholders). `NEVER run \`pkill -u www lsphp\`` is enough.

When a remembered rule fires, the reason quotes the rule and names it, and the way forward is to run the command yourself or delete the rule with `delete_rule`.

**After a turn** (`Stop`), the guard reviews the working tree: possible secrets added to tracked source, version strings that disagree across release files, deleted files, large net deletions, a function newly defined in more than one place, and remembered gotchas that name the project or a touched file. Silence is the correct output for a clean turn.

**The log.** Every verdict, including silent allows, is appended to `~/.cogmemai/guard-verdicts.jsonl` (override with `COGMEMAI_GUARD_LOG`) with the decision, the rule, a redacted copy of the command, the session, and the working directory. `guard status` summarizes it.

**Every tool, not just Claude Code (v3.25.0).** Cursor, Codex, Gemini CLI, Cline, and plain scripts all end up running `bash -c "<command>"`, and non-interactive bash sources the file named in `BASH_ENV` before it runs anything, with the full command in `BASH_EXECUTION_STRING`. `cogmemai-mcp guard shell-install` writes that file and points `BASH_ENV` at it, so every such shell hands its command to the same engine, the same rule cache, and the same log, and exits with status 2 and the reason on stderr when denied. zsh is covered through `ZSH_EXECUTION_STRING`. Set `COGMEMAI_GUARD_OFF=1` to skip one process; `guard shell-remove` undoes the install. Not covered: `sh -c` on systems where `sh` is dash, and the body of a script file (only the `-c` string is judged).

**What it is not.** It is not a sandbox and not a substitute for git, backups, or review. A blanket `Bash` entry in `permissions.allow` makes an "ask" verdict inert, which is why the guard denies rather than asks.

## Intent

CogmemAi Intent (v3.26.0) is one plain-English document per project, kept by CogmemAi rather than in the repository. It is the owner's source of truth, written for a reader who may never open the code.

**Write it** with the `set_intent` tool (or ask your assistant to draft it and approve the words). Four sections work well:

```markdown
# my-shop

## Purpose
A checkout for a small shop. Customers pay by card and get an email receipt.

## Invariants
- NEVER charge a card before the address is validated.
- NEVER run `pkill -u www lsphp` on the shared host.
- Every email goes through the queue, never sent inline.

## Decisions
- Tax is computed after discounts because the accountant said so.

## Out of scope
- Subscriptions.
```

**Every session loads it** right after the mandatory rules, above the truncation cut, so it is always in front of the assistant. `get_intent` returns the full text; `cogmemai-mcp guard intent` prints the cached copy; every replacement keeps the previous text as a version.

**Invariants are enforced.** The sentences under a heading that reads like Invariants, Rules, Must, Never, or Always are compiled exactly like rule memories: a backticked command after NEVER or MUST NOT becomes a pattern the PreToolUse guard denies, and `GUARD: <regex>` lines work too. No network on that path; the cache is refreshed at session start and by `guard sync`.

**Every turn is checked.** At Stop, the turn's diff (unstaged, staged, and the head of new files, capped at 16,000 characters so it judges within the hook's budget) is sent to the CogmemAi server and judged against the intent there, so the hook itself still never calls a model. The result comes back as a few lines for a person:

```
CogmemAi Guard reviewed this turn:
  - Intent check: Charges the card as soon as the form is submitted.
  - Conflicts with your intent ("NEVER charge a card before the address is validated."): The charge now happens before validation.
  - Not in your intent yet: Stores the card number for later. Say "add that to the intent" to record it, or ask for it to be reverted.
```

A change the intent already covers earns silence. Set `COGMEMAI_INTENT_VERBOSE=1` to see the one-line summary on every judged turn instead. Nothing is ever blocked or edited by the review; it reports, and you decide.

**The log.** Every check is appended to `~/.cogmemai/intent-log.jsonl` with the project, the diff size, the time taken, how many conflicts and gaps were found, and what was shown. That is the number behind the feature: how often the code drifts from what you meant, and whether it is falling.

**Tiers.** The judged check runs on the paid tiers, because each one is a model request. The free tier gets the enforced invariants, the context injection, and every deterministic review. Local-only storage mode has no intent document, since the judgment needs the server.

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

For local mode (free API key required for registration, data stays local):
```json
{
  "mcpServers": {
    "cogmemai": {
      "command": "cogmemai-mcp",
      "env": {
        "COGMEMAI_MODE": "local",
        "COGMEMAI_API_KEY": "cm_your_api_key_here"
      }
    }
  }
}
```

**Option B — Global** (available in every project):

```bash
# Cloud (default)
claude mcp add cogmemai cogmemai-mcp -e COGMEMAI_API_KEY=cm_your_api_key_here --scope user

# Local (free API key required, data stays local)
claude mcp add cogmemai cogmemai-mcp -e COGMEMAI_API_KEY=cm_your_api_key_here -e COGMEMAI_MODE=local --scope user

# Hybrid (both)
claude mcp add cogmemai cogmemai-mcp -e COGMEMAI_API_KEY=cm_your_api_key_here -e COGMEMAI_MODE=hybrid --scope user
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

### CogmemUI

[CogmemUI](https://hifriendbot.com/cogmemui/) is a free multi-model Ai workspace with built-in CogmemAi memory. Add your CogmemAi API key in **Settings > API Keys** and your memory is instantly available. CogmemUI also supports connecting any MCP-compatible tool server via **Settings > MCP Servers** — add endpoints, auto-discover tools, and use them in chat.

Get your free API key at [hifriendbot.com/developer](https://hifriendbot.com/developer/).

## Tools

CogmemAi provides 37 tools that your Ai assistant uses automatically:

| Tool | Description |
|------|-------------|
| `preflight` | **Proactive recall.** Fast recall to check prior context before making any suggestion |
| `save_memory` | Store a fact explicitly (architecture decision, preference, etc.) |
| `recall_memories` | Search memories using natural language (semantic search) |
| `extract_memories` | Ai extracts facts from a conversation exchange automatically |
| `get_project_context` | Load top memories at session start (with smart ranking, health score, and session replay) |
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
| `get_analytics` | Memory health dashboard with self-tuning insights (filterable by project) |
| `promote_memory` | Promote a project memory to global scope |
| `consolidate_memories` | Merge related memories into comprehensive summaries using Ai |
| `save_task` | Create a persistent task with status and priority tracking |
| `get_tasks` | Retrieve tasks for the current project — pick up where you left off |
| `update_task` | Change task status, priority, or description as you work |
| `save_correction` | Store a "wrong approach → right approach" pattern to avoid repeated mistakes |
| `set_reminder` | Set a reminder that surfaces at the start of your next session |
| `get_stale_memories` | Find memories that may be outdated for review or cleanup |
| `get_file_changes` | See what files changed since your last session |
| `feedback_memory` | Signal whether a recalled memory was useful or irrelevant to improve future recall |
| `generate_skills` | Trigger skill generation from your corrections and preferences — or preview candidates with dry run |
| `save_rule` | Save a mandatory rule that surfaces in every session — bypasses all scoring and decay |
| `list_rules` | List all mandatory rules for the current project and/or globally |
| `delete_rule` | Delete a mandatory rule by ID |
| `get_intent` | Read the project's Intent document, the owner's plain-English source of truth |
| `set_intent` | Create or replace the project's Intent document (versioned; invariants are enforced by the guard) |
| `extract_principles` | Trigger Wisdom Engine to detect factual patterns across memory clusters |

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
- **rule** — Mandatory directives that surface in every session, bypassing all scoring and decay

## Scoping

- **Project memories** — Architecture, decisions, bugs specific to one repo. Auto-detected from your repository.
- **Global memories** — Your coding preferences, identity, tool choices. Available in every project.

## Pricing

| | Free | Pro | Team | Enterprise |
|---|---|---|---|---|
| **Price** | $0 | $14.99/mo | $39.99/mo | $99.99/mo |
| **Memories** | 500 | 2,000 | 10,000 | 50,000 |
| **Extractions/mo** | 500 | 2,000 | 5,000 | 20,000 |
| **Projects** | 5 | 20 | 50 | 200 |

Start free. Upgrade when you need more. Or pay per operation with USDC on-chain — no credit card required.

## Privacy & Security

- **🛡️ Quantum-safe encryption at rest.** All memories are encrypted with quantum-resistant cryptography — in cloud mode and local mode. Protected against both current threats and future quantum computers.
- **No source code leaves your machine.** We store extracted facts (short sentences), never raw code.
- **API keys cryptographically hashed** (irreversible) server-side.
- **All traffic over HTTPS.**
- **No model training** on your data. Ever.
- **Delete everything** instantly via dashboard or MCP tool.
- **No cross-user data sharing.**

Read our full [privacy policy](https://hifriendbot.com/privacy-policy/).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `COGMEMAI_API_KEY` | Cloud/Hybrid | Your API key (starts with `cm_`). Not needed for local mode. |
| `COGMEMAI_MODE` | No | Storage mode: `cloud` (default), `local` (data stays on your machine), or `hybrid` |
| `COGMEMAI_LOCAL_DB` | No | Path to local database (default: `~/.cogmemai/local.db`). Used in local and hybrid modes. |
| `COGMEMAI_API_URL` | No | Custom API URL (default: hifriendbot.com) |
| `COGMEMAI_ENCRYPTION_KEY` | No | Custom encryption passphrase for local mode. If not set, a key is auto-generated. |
| `COGMEMAI_LOCAL_ENCRYPTION` | No | Set to `off` to disable local encryption (not recommended). |

## Support

- Issues: [GitHub Issues](https://github.com/hifriendbot/cogmemai-mcp/issues)
- Docs: [hifriendbot.com/developer](https://hifriendbot.com/developer/)

## License

MIT — see [LICENSE](./LICENSE)

---

Built by [HiFriendbot](https://hifriendbot.com) — Better Friends, Better Memories, Better Ai. 🛡️ Quantum Safe.
