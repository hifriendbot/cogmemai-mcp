"""
CogmemAi + OpenAI Frontier Agent Demo
======================================
Demonstrates how to give a Frontier agent persistent cross-platform memory
using CogmemAi as an MCP server via the OpenAI Agents SDK.

Prerequisites:
    pip install openai-agents
    npm install -g cogmemai-mcp
    export COGMEMAI_API_KEY=cm_your_api_key_here
    export OPENAI_API_KEY=sk-your_openai_key_here

Usage:
    python frontier-agent-demo.py

Learn more: https://hifriendbot.com/frontier/
"""

import asyncio
import os

from agents import Agent, Runner
from agents.mcp import MCPServerStdio


async def main():
    api_key = os.environ.get("COGMEMAI_API_KEY")
    if not api_key:
        print("Error: Set COGMEMAI_API_KEY environment variable")
        print("  Get your free key at https://hifriendbot.com/developer/")
        return

    # Connect CogmemAi as an MCP memory server
    cogmemai = MCPServerStdio(
        name="cogmemai",
        command="npx",
        args=["cogmemai-mcp"],
        env={"COGMEMAI_API_KEY": api_key},
    )

    # Create a Frontier agent with persistent memory
    agent = Agent(
        name="frontier-memory-demo",
        instructions="""You have persistent memory via CogmemAi.

At the start of every task:
1. Call get_project_context to load relevant memories from previous sessions.
2. Read the returned memories carefully — they contain past decisions and context.

While working:
- Save important discoveries with save_memory (set appropriate importance 1-10).
- Use recall_memories when a topic might have prior context.
- Use save_correction to record "wrong approach -> right approach" patterns.
- Use save_task to track cross-session work.

At the end of a session:
- Call save_session_summary to capture what was accomplished.""",
        mcp_servers=[cogmemai],
    )

    async with cogmemai:
        print("CogmemAi MCP server connected.")
        print("Agent has access to 28 memory tools.\n")

        # Demo 1: Save a memory
        print("--- Demo 1: Saving a memory ---")
        result = await Runner.run(
            agent,
            "Save a memory that this Frontier demo project uses Python 3.11 "
            "with the OpenAI Agents SDK. Set importance to 7 and category to 'backend'.",
        )
        print(f"Agent: {result.final_output}\n")

        # Demo 2: Recall memories
        print("--- Demo 2: Recalling memories ---")
        result = await Runner.run(
            agent,
            "What do you remember about this project's tech stack? "
            "Use recall_memories to search.",
        )
        print(f"Agent: {result.final_output}\n")

        # Demo 3: Load full project context
        print("--- Demo 3: Loading project context ---")
        result = await Runner.run(
            agent,
            "Load the full project context using get_project_context "
            "and tell me what you know about this project.",
        )
        print(f"Agent: {result.final_output}\n")

        # Demo 4: Save a correction pattern
        print("--- Demo 4: Saving a correction ---")
        result = await Runner.run(
            agent,
            "Save a correction: the wrong approach is 'using pip install openai' "
            "and the right approach is 'using pip install openai-agents' "
            "for the Agents SDK. Context: 'installing OpenAI Agents SDK'.",
        )
        print(f"Agent: {result.final_output}\n")

        print("Demo complete. Memories persist across sessions and platforms.")
        print("Try recalling these memories from Claude Code, Cursor, or any MCP client.")


if __name__ == "__main__":
    asyncio.run(main())
