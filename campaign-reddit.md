# Reddit Campaign Drafts — CogmemAi Skills Launch

Three subreddit-tailored posts. Each leads with value (workflow + insight), not sales. Repo + skills links are at the bottom as supporting reference, not the lede.

Reddit-specific etiquette notes:
- Do NOT cross-post identical text across subs (mods auto-flag). Use the three different drafts below.
- Be ready to respond to comments within the first hour (Reddit ranking rewards early engagement).
- If asked "are you affiliated?", answer truthfully on first ask: yes, you built it. The community respects upfront disclosure far more than evasion.

Suggested posting cadence: r/ClaudeAI first (most aligned audience), then r/LocalLLaMA 6-12 hours later, then r/cursor a day after that. Don't all-three-at-once.

---

## Draft 1: r/ClaudeAI

**Title:** Five Claude Code skills for the "we fixed this before" problem

**Body:**

Most teams I work with waste hours re-debugging things that someone (or past-them) already fixed. The fix lives in someone's head, buried in Slack, or attached to an old ticket nobody can find.

I shipped five Claude Code skills this week that try to fix that for any team using an Ai assistant. They are open in the Skills Marketplace and the source is on GitHub.

The two that matter most for the duplicate-debugging problem are:

- **save-bugfix** — after any verified fix, captures symptom + root cause + fix + why-it-works as a searchable memory. Triggers on "got it", "that fixed it", "nailed it".
- **search-before-debugging** — before debugging any new bug or error, searches the memory store for an existing fix from this or any past session. The same Stripe webhook bug that bit you in February finds its fix in 30 seconds in May.

Three other workflow skills round it out: save-context (preserve state before compaction), remember-this (persist explicit user-stated preferences), and session-start (load top project memories before the first message of every session).

All five sit on top of CogmemAi's MCP server, which scored 95.1% on LongMemEval (Apr 19, 2026) — the top published score on the benchmark.

Install:
```
npm install -g cogmemai-mcp
npx cogmemai-mcp setup
```

Free tier covers 500 memories + 500 extractions per month, no card.

Source: https://github.com/hifriendbot/cogmemai-mcp/tree/main/skill
Skills Marketplace listings will appear as the scraper picks them up.

Curious what other "fixed this before" workflows people have built. The bugfix loop feels like the most obvious one but I bet there are domain-specific ones (deployment recovery, infra incidents, security review patterns) that would be worth packaging the same way.

---

## Draft 2: r/LocalLLaMA

**Title:** Top published LongMemEval score (95.1%) — five new skills for the underlying memory layer

**Body:**

For folks who follow long-term memory benchmarks: CogmemAi published 95.1% on LongMemEval (Apr 19, 2026) and 91% on LoCoMo (Apr 2, 2026). The paper's best baseline on LongMemEval was 64%. Most production memory systems sit between 50-70%.

Methodology, for repeatability: answering model Claude Opus 4.7, judge model GPT-4o, dataset is the LME-100 subset plus two additions (102 total), 97 correct.

This week I published five Claude Code skills that wire that memory engine into common workflows:

1. save-context — preserve state before compaction
2. remember-this — persist explicit user preferences
3. session-start — load top memories at session start
4. save-bugfix — capture every fix as a searchable memory
5. search-before-debugging — recall existing fixes before debugging from scratch

The infrastructure is MCP server + REST API + direct API. Three storage modes: cloud, local (SQLite via better-sqlite3), and hybrid (write-both, read-prefer-cloud-with-fallback).

```
npm install -g cogmemai-mcp
npx cogmemai-mcp setup
```

Free tier: 500 memories + 500 extractions per month, no card.

Repo: https://github.com/hifriendbot/cogmemai-mcp

Happy to compare notes with anyone running memory benchmarks. The honest comparison is hard because every vendor runs their own eval setup, but I'd love to see more public methodology disclosure across the field.

---

## Draft 3: r/cursor

**Title:** Five MCP skills for persistent memory across Cursor sessions

**Body:**

If you've ever finished a long Cursor session, opened a new one the next morning, and watched the assistant ask you the same architecture questions you answered yesterday — this is for you.

I published five MCP-based memory skills this week. They work with any MCP-compatible editor (Cursor, Windsurf, Cline, Claude Code, Continue):

- **session-start** — loads top project memories at the start of every session before the assistant responds
- **save-context** — preserves conversation state before compaction or end-of-day
- **remember-this** — persists explicit preferences ("always use Bun, never npm") globally across all projects
- **save-bugfix** — captures every verified bugfix (symptom + root cause + fix) as a searchable memory
- **search-before-debugging** — before debugging any new bug, recalls existing fixes from prior sessions

The MCP server (CogmemAi) scored 95.1% on LongMemEval, so the recall quality is high enough to actually trust in your flow.

```
npm install -g cogmemai-mcp
npx cogmemai-mcp setup
```

Cursor MCP config: the wizard handles it, or manually point your Cursor MCP settings at `cogmemai-mcp`. Free tier: 500 memories + 500 extractions/mo.

Repo: https://github.com/hifriendbot/cogmemai-mcp

If anyone is running CogmemAi (or any persistent memory layer) in Cursor and has favorite trigger patterns for the assistant, I'd love to hear them. The five skills above cover the common cases but I'm sure there are better-tuned domain-specific ones out there.
