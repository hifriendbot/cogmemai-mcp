# CogmemAi Tools Quick Reference

## Session Management
| Tool | When to Use |
|------|------------|
| `get_project_context` | First thing every session. Pass `context` for relevance. |
| `save_session_summary` | End of session. Capture what was done and next steps. |

## Memory CRUD
| Tool | When to Use |
|------|------------|
| `save_memory` | You learned something worth remembering. |
| `recall_memories` | You need to find specific knowledge. Use natural language. |
| `list_memories` | Browse all memories with filters (type, category, scope). |
| `update_memory` | Change content, importance, or scope of existing memory. |
| `delete_memory` | Remove a memory that's wrong, stale, or duplicate. |

## Ai-Powered
| Tool | When to Use |
|------|------------|
| `extract_memories` | Pass a conversation exchange — Ai finds facts to save. |
| `ingest_document` | Feed in a README, API doc, or spec to auto-extract memories. |

## Organization
| Tool | When to Use |
|------|------------|
| `link_memories` | Connect related memories (led_to, contradicts, extends, related). |
| `get_memory_links` | Explore connections around a memory. |
| `get_memory_versions` | See edit history of a memory. |
| `promote_memory` | Move project memory to global scope. |
| `list_tags` | See all tags in use for grouping. |

## Analytics
| Tool | When to Use |
|------|------------|
| `get_analytics` | Memory health dashboard — most/never recalled, by type. |
| `get_usage` | Check tier info, limits, and usage stats. |

## Data Portability
| Tool | When to Use |
|------|------------|
| `export_memories` | Backup all memories as JSON. |
| `import_memories` | Bulk import from JSON array. |
