# X / Twitter Thread — CogmemAi Skills Launch

8 tweets, each under 280 chars. Each can stand alone if quote-RT'd. Use the cogmemai-mcp GitHub link in the final tweet; pin tweet 1.

---

**Tweet 1 (the hook)**

Most Ai coding assistants are goldfish.

The fix you walked them through yesterday? Forgotten.
The preference you stated three times? Forgotten.
The two-hour Stripe SDK gotcha from February? Forgotten.

I shipped 5 Claude Code skills this week that fix it. 🧵

---

**Tweet 2**

CogmemAi is the Smart Persistent Memory layer for Ai agents.

95.1% on LongMemEval (Apr 19, 2026). The top published score on the benchmark. The paper's best baseline was 64%.

The new skills wire that memory engine into 5 common dev workflows.

---

**Tweet 3 — save-context**

1/ save-context

Captures the live conversation state before compaction or session end.

Triggers: "save context", "checkpoint", "don't lose this".

Long planning session? One extract_memories call saves every decision, constraint, and file path. Implementation phase resumes intact.

---

**Tweet 4 — remember-this**

2/ remember-this

Persists a single user-stated preference the moment you say it.

"I always use Bun, never npm" → lands as a global preference, importance 8.

Carries to every future session, every project. No more re-stating the same rule for the third time.

---

**Tweet 5 — session-start**

3/ session-start

Loads top project memories before the assistant responds to the first message of every session.

Open the IDE. Three pending tasks and an active reminder from yesterday surface immediately. Work resumes without re-discovery.

The single highest-leverage continuity move.

---

**Tweet 6 — save-bugfix + search-before-debugging**

4 & 5/ The bugfix pair.

save-bugfix: after any verified fix, save symptom + root cause + fix + why-it-works.

search-before-debugging: before debugging anything new, recall existing fixes first.

Result: the same bug never gets debugged twice. Whole-team productivity unlock.

---

**Tweet 7 — install**

Install:

```
npm install -g cogmemai-mcp
npx cogmemai-mcp setup
```

60 seconds. Free tier: 500 memories + 500 extractions/mo, no card.

Works with Claude Code, Cursor, Windsurf, Cline, Continue. Anything MCP.

---

**Tweet 8 — star CTA**

If the skills are useful, star the repo. The Skills Marketplace ranker weights stars, so more devs find these workflows.

→ https://github.com/hifriendbot/cogmemai-mcp

Source for all 5 skills is in skill/. Fork them, suggest improvements, build your own.
