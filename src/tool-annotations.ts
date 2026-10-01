/**
 * MCP tool annotations (title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint)
 * for every CogmemAi tool. Clients use them to decide what needs confirmation and how to
 * label a tool; the Claude directory review asks for them. Applied centrally in registerTools.
 */

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const ro = (title: string, idempotent = true): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false });
const add = (title: string, idempotent = false): ToolAnnotations => ({ title, readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false });
const change = (title: string, idempotent = true): ToolAnnotations => ({ title, readOnlyHint: false, destructiveHint: true, idempotentHint: idempotent, openWorldHint: false });

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Memory
  save_memory:            add('Save memory'),
  recall_memories:        ro('Recall memories'),
  get_project_context:    ro('Load project context'),
  preflight:              ro('Preflight recall'),
  list_memories:          ro('List memories'),
  update_memory:          change('Update memory'),
  delete_memory:          change('Move memory to trash'),
  restore_memory:         add('Restore memory from trash', true),
  list_trash:             ro('List trashed memories'),
  bulk_delete:            change('Delete memories permanently'),
  bulk_update:            change('Update several memories'),
  promote_memory:         add('Promote memory to global', true),
  link_memories:          add('Link two memories', true),
  get_memory_links:       ro('Memory links'),
  get_memory_versions:    ro('Memory history'),
  consolidate_memories:   change('Consolidate memories'),
  extract_memories:       add('Extract memories from an exchange'),
  ingest_document:        add('Ingest a document into memory'),
  import_memories:        add('Import memories'),
  export_memories:        ro('Export memories'),
  list_tags:              ro('List tags'),
  get_stale_memories:     ro('Find stale memories'),
  get_analytics:          ro('Memory analytics'),
  feedback_memory:        add('Rate a recalled memory', true),
  save_session_summary:   add('Save session summary'),
  get_file_changes:       ro('Files changed since last session'),
  get_usage:              ro('Usage and plan'),
  extract_principles:     add('Extract principles'),
  generate_skills:        add('Generate skills'),
  // Rules, intent, guard, review
  save_rule:              add('Save a mandatory rule'),
  list_rules:             ro('List rules'),
  delete_rule:            change('Delete rule'),
  set_intent:             change('Set project intent'),
  get_intent:             ro('Read project intent'),
  guard_check:            ro('Guard: may I do this?', false),
  review_work:            ro('Review work against intent', false),
  save_correction:        add('Save a correction'),
  // Tasks and reminders
  save_task:              add('Create task'),
  get_tasks:              ro('List tasks'),
  update_task:            change('Update task'),
  set_reminder:           add('Set reminder'),
};
