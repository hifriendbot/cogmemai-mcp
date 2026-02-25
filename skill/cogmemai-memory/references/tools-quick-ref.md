# CogmemAi Tools Quick Reference

## Session Management
| Tool | When to Use |
|------|------------|
| `get_project_context` | First thing every session. Includes health score and session replay. Pass `context` for relevance. |
| `save_session_summary` | End of session. Capture what was done and next steps. |

## Memory CRUD
| Tool | When to Use |
|------|------------|
| `save_memory` | You learned something worth remembering. |
| `recall_memories` | You need to find specific knowledge. Use natural language. |
| `list_memories` | Browse all memories with filters (type, category, scope, sort). |
| `update_memory` | Change content, importance, or scope of existing memory. |
| `delete_memory` | Remove a memory that's wrong, stale, or duplicate. |
| `bulk_delete` | Delete up to 100 memories at once. |
| `bulk_update` | Update up to 50 memories at once (content, type, category, tags). |

## Ai-Powered
| Tool | When to Use |
|------|------------|
| `extract_memories` | Pass a conversation exchange — Ai finds facts to save. |
| `ingest_document` | Feed in a README, API doc, or spec to auto-extract memories. |
| `consolidate_memories` | Merge related memories into comprehensive summaries using Ai. |

## Task Tracking
| Tool | When to Use |
|------|------------|
| `save_task` | Create a persistent task with status and priority. |
| `get_tasks` | Pick up where you left off — see pending work across sessions. |
| `update_task` | Change task status, priority, or description as you work. |

## Learning
| Tool | When to Use |
|------|------------|
| `save_correction` | Store a wrong approach → right approach pattern. |
| `set_reminder` | Set a nudge that surfaces at the start of your next session. |

## Organization
| Tool | When to Use |
|------|------------|
| `link_memories` | Connect related memories (led_to, contradicts, extends, related). |
| `get_memory_links` | Explore connections around a memory. |
| `get_memory_versions` | See edit history of a memory. |
| `promote_memory` | Move project memory to global scope. |
| `list_tags` | See all tags in use for grouping. |

## Analytics & Health
| Tool | When to Use |
|------|------------|
| `get_analytics` | Memory health dashboard with self-tuning insights. |
| `get_usage` | Check tier info, limits, and usage stats. |
| `get_stale_memories` | Find outdated memories that need review or cleanup. |
| `get_file_changes` | See what files changed since your last session. |

## Data Portability
| Tool | When to Use |
|------|------------|
| `export_memories` | Backup all memories as JSON (with tags, references, timestamps). |
| `import_memories` | Bulk import from JSON array (preserves tags). |
