/**
 * CogmemAi upsell messages for cloud-only tools in local mode.
 */

const UPGRADE_URL = 'https://hifriendbot.com/developer/';

export function cloudOnly(tool: string, description: string, benefit: string, tip?: string) {
  return {
    cloud_only: true,
    tool,
    message: `${description} requires cloud mode.`,
    what_you_get: benefit,
    upgrade: UPGRADE_URL,
    tip: tip || 'Add a free CogmemAi API key to unlock cloud features.',
  };
}

export const UPSELL = {
  extract_memories: () =>
    cloudOnly(
      'extract_memories',
      'AI-powered memory extraction',
      'Automatic fact extraction from conversations — the AI identifies architecture decisions, preferences, bug fixes, and more without you manually saving each one.',
      'You can still save memories manually with save_memory.'
    ),
  ingest_document: () =>
    cloudOnly(
      'ingest_document',
      'Document ingestion',
      'Feed in a README, architecture doc, or API spec and CogmemAi auto-extracts dozens of memories in seconds. Instant project onboarding.',
      'You can manually save key facts from docs with save_memory.'
    ),
  consolidate_memories: () =>
    cloudOnly(
      'consolidate_memories',
      'AI-powered memory consolidation',
      'Merge related memories into fewer, richer summaries using AI. Keeps your memory clean and focused as it grows.'
    ),
  generate_skills: () =>
    cloudOnly(
      'generate_skills',
      'Auto-Skills engine',
      'CogmemAi synthesizes behavioral skills from your corrections and preferences — it learns HOW you want the AI to behave, not just what to remember. Closed-loop learning that no other memory product offers.'
    ),
  link_memories: () =>
    cloudOnly(
      'link_memories',
      'Knowledge graph linking',
      'Connect memories with relationships (led_to, contradicts, extends, related). Auto-linking detects similar memories on save. Build a web of connected knowledge.'
    ),
  get_memory_links: () =>
    cloudOnly(
      'get_memory_links',
      'Knowledge graph exploration',
      'Explore connections around any memory — see what it led to, what contradicts it, and what extends it.'
    ),
  get_memory_versions: () =>
    cloudOnly(
      'get_memory_versions',
      'Memory version history',
      'View the full edit history of any memory. See how decisions evolved over time.'
    ),
  promote_memory: () =>
    cloudOnly(
      'promote_memory',
      'Cross-project memory promotion',
      'Upgrade a project-scoped memory to global scope when you discover it applies everywhere. Cloud tracks usage across all your projects.'
    ),
  get_analytics: () =>
    cloudOnly(
      'get_analytics',
      'Memory health analytics',
      'Dashboard with usage patterns, growth trends, most/least recalled memories, and cleanup opportunities. Understand how your memory is performing.'
    ),
  save_correction: () =>
    cloudOnly(
      'save_correction',
      'Correction learning',
      'Record "wrong approach → right approach" patterns. Corrections surface automatically in future sessions when similar situations arise, and feed into the Auto-Skills engine.',
      'You can save corrections as regular memories with save_memory, but they won\'t auto-surface or feed into skills.'
    ),
  set_reminder: () =>
    cloudOnly(
      'set_reminder',
      'Session reminders',
      'Set nudges that appear at the start of your next session (e.g. "Check if PR was merged"). Auto-expire after their TTL.',
      'You can save a high-importance memory as a workaround.'
    ),
  get_stale_memories: () =>
    cloudOnly(
      'get_stale_memories',
      'Stale memory detection',
      'Find outdated memories that need review or removal. Uses memory decay algorithms to identify what\'s gone stale — core memories (importance 9-10) never decay.'
    ),
} as const;
