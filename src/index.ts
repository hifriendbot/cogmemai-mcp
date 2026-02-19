#!/usr/bin/env node
/**
 * CogmemAi — Cognitive Memory for Claude Code
 *
 * MCP server that gives Claude Code persistent memory across sessions.
 * Developers install with one command, set one env var, and Claude Code
 * remembers architecture, patterns, decisions, bugs, and preferences.
 *
 * Run: npx -y cogmemai-mcp
 * Docs: https://hifriendbot.com/developer/
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';

const server = new McpServer(
  {
    name: 'cogmemai',
    version: '2.0.0',
  },
  {
    instructions: `You have persistent memory powered by CogmemAi. Use it proactively:

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

## While Working
- When you learn something important about the codebase (architecture, tech stack, patterns, conventions), save it with save_memory.
- When the user tells you a preference or makes a decision, save it immediately.
- When you fix a bug or discover a gotcha, save it so you remember next time.
- When you encounter something you should have known from a previous session, that's a sign you should be saving more.
- At the end of a substantial session, use save_session_summary to capture what was accomplished and next steps.

## What to Save
- Architecture decisions and tech stack details (importance: 8-10)
- User preferences for coding style, tools, workflow (importance: 7-9)
- Bug fixes, gotchas, and workarounds (importance: 6-8)
- Key file paths and project structure (importance: 7-9)
- Dependency versions and constraints (importance: 5-7)
- Patterns and conventions used in the codebase (importance: 6-8)

## What NOT to Save
- Temporary or session-specific context (current task details, in-progress work)
- Information that's obvious from reading the code
- Speculative or unverified conclusions
- Raw code snippets (save facts about code, not the code itself)
- Secrets, API keys, passwords, or tokens (these are auto-detected and flagged)

## Scoping
- Use scope "project" for things specific to this codebase (default)
- Use scope "global" for user preferences and identity that apply everywhere

## Tips
- Keep memories concise — complete sentences, 1-2 lines each
- Use descriptive subjects like "auth_system", "database_setup", "css_conventions"
- Higher importance = surfaced more often. Reserve 9-10 for core architecture.
- Use recall_memories when you need to look up something specific from past sessions.
- Use ingest_document to quickly onboard from READMEs, architecture docs, or API specs.
- Use export_memories to back up memories before major changes.`,
  }
);

registerTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('CogmemAi MCP server v2.0.0 running on stdio');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
