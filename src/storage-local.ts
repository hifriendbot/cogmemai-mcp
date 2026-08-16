/**
 * CogmemAi Local Storage Backend — SQLite via better-sqlite3.
 *
 * 17 tools work locally (CRUD, tasks, export/import, tags, feedback, usage).
 * 12 tools return upsell messages pointing users toward cloud mode.
 * Keyword search is functional but deliberately inferior to cloud semantic search.
 */

import type { StorageBackend } from './storage.js';
import type { StorageMode } from './config.js';
import { getDb, computeExpiresAt, ftsUpsert, ftsDelete, ftsSearch } from './local-db.js';
import { UPSELL } from './upsell.js';
import { VERSION } from './config.js';
import { encrypt, decrypt, isEncryptionEnabled, getEncryptionInfo } from './encryption.js';

// Stop words — common English words that add noise to keyword search
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must',
  'it', 'its', 'this', 'that', 'these', 'those', 'he', 'she', 'they',
  'we', 'you', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'our',
  'his', 'their', 'what', 'which', 'who', 'whom', 'where', 'when', 'how',
  'not', 'no', 'nor', 'but', 'and', 'or', 'if', 'then', 'so', 'than',
  'too', 'very', 'just', 'about', 'above', 'after', 'again', 'all',
  'also', 'any', 'because', 'before', 'between', 'both', 'by', 'each',
  'for', 'from', 'get', 'got', 'here', 'in', 'into', 'of', 'off', 'on',
  'only', 'other', 'out', 'over', 'own', 'same', 'some', 'such',
  'to', 'under', 'up', 'with',
]);

/**
 * Filter query words: remove stop words, keep words >= 2 chars.
 * Returns both exact words and prefix-matchable stems.
 */
function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * Score a text field against query words.
 * Exact word match = full weight, prefix match (4+ chars) = half weight.
 */
function scoreField(text: string, words: string[], weight: number): number {
  const textLower = text.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (textLower.includes(word)) {
      score += weight;
    } else if (word.length >= 4) {
      // Prefix match: "auth" matches "authentication", "react" matches "reactivity"
      const prefix = word.slice(0, Math.max(4, Math.floor(word.length * 0.75)));
      if (textLower.includes(prefix)) {
        score += weight * 0.5;
      }
    }
  }
  return score;
}

/**
 * Compute a recency boost factor (0.0–1.0) based on updated_at.
 * Memories updated today = 1.0, 30+ days ago = 0.0.
 */
function recencyBoost(updatedAt: string): number {
  const updated = new Date(updatedAt).getTime();
  const now = Date.now();
  const daysSince = (now - updated) / (1000 * 60 * 60 * 24);
  if (daysSince <= 1) return 1.0;
  if (daysSince >= 30) return 0.0;
  return Math.max(0, 1 - (daysSince / 30));
}

// Milestone thresholds for upgrade nudges
const MILESTONES = [25, 50, 100, 250, 500] as const;
const UPGRADE_URL = 'https://hifriendbot.com/developer/';

const MILESTONE_MESSAGES: Record<number, string> = {
  25: `You've saved 25 memories locally. With cloud mode, these would be searchable by meaning — not just keywords. "How does auth work?" would find your JWT and cookie memories even though those words never appear in the query. Free tier: ${UPGRADE_URL}`,
  50: `50 memories saved! At this scale, cloud mode's Intelligence Engine really shines: auto-linking discovers connections between your memories, contradiction detection flags conflicts, and memory decay keeps your knowledge fresh. Your 50 memories would become a living knowledge base. Free tier: ${UPGRADE_URL}`,
  100: `100 memories — impressive! You're a power user. Cloud mode would auto-generate behavioral skills from your patterns and corrections — the Ai learns HOW you work, not just what you know. Plus semantic search, auto-linking, and team collaboration. You'd love it. Free tier: ${UPGRADE_URL}`,
  250: `250 memories! You're clearly getting value from CogmemAi. At this scale, local keyword search is leaving a lot on the table. Cloud mode's semantic search, Ai-powered consolidation, and auto-skills would transform these 250 facts into an intelligent knowledge system. Hybrid mode gives you local speed + cloud brains. Free tier: ${UPGRADE_URL}`,
  500: `500 memories — you're a CogmemAi champion! Consider upgrading to cloud or hybrid mode for the full experience: semantic search across all 500 memories, auto-skills that learn your patterns, knowledge graph connections, and portability across all your devices and editors. Free tier: ${UPGRADE_URL}`,
};

export class LocalStorage implements StorageBackend {
  readonly mode: StorageMode = 'local';

  // ─── Core CRUD ─────────────────────────────────────────

  async saveMemory(body: Record<string, unknown>): Promise<unknown> {
    const db = getDb();
    const tags = Array.isArray(body.tags) ? body.tags : [];
    const ttl = typeof body.ttl === 'string' ? body.ttl : undefined;
    const expiresAt = ttl ? computeExpiresAt(ttl) : null;

    // Provenance: a timestamp only when the caller explicitly said it observed
    // the thing. NULL (the default) means nobody checked, which must never be
    // confused with "checked and found true". Mirrors last_verified on cloud.
    const lastVerified = body.verified === true ? new Date().toISOString() : null;

    const stmt = db.prepare(`
      INSERT INTO memories (content, memory_type, category, subject, importance, scope, project_id, tags, ttl, expires_at, last_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      encrypt(String(body.content || '')),
      String(body.memory_type || 'context'),
      String(body.category || 'general'),
      String(body.subject || ''),
      Number(body.importance) || 5,
      String(body.scope || 'project'),
      body.project_id ? String(body.project_id) : null,
      JSON.stringify(tags),
      ttl || null,
      expiresAt,
      lastVerified,
    );

    // Sync to FTS5 index for better search
    ftsUpsert(
      Number(result.lastInsertRowid),
      String(body.subject || ''),
      String(body.content || ''),
      String(body.category || 'general'),
      JSON.stringify(tags),
    );

    // Insert tags into junction table
    if (tags.length > 0) {
      const tagStmt = db.prepare('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)');
      for (const tag of tags) {
        tagStmt.run(result.lastInsertRowid, String(tag));
      }
    }

    // Check for milestone nudge
    const memoryCount = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
    const milestone = MILESTONES.find(m => memoryCount === m);

    const response: Record<string, unknown> = {
      memory_id: result.lastInsertRowid,
      stored: true,
      mode: 'local',
    };

    if (milestone && MILESTONE_MESSAGES[milestone]) {
      response._milestone = {
        count: milestone,
        message: MILESTONE_MESSAGES[milestone],
      };
    }

    return response;
  }

  async recallMemories(body: Record<string, unknown>): Promise<unknown> {
    const db = getDb();
    const query = String(body.query || '');
    const limit = Number(body.limit) || 10;
    const projectId = body.project_id ? String(body.project_id) : null;
    const scope = body.scope ? String(body.scope) : 'all';
    const memoryType = body.memory_type ? String(body.memory_type) : null;
    const category = body.category ? String(body.category) : null;
    const importanceMin = body.importance_min ? Number(body.importance_min) : null;
    const tag = body.tag ? String(body.tag) : null;

    // Remove expired memories first
    db.prepare("DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();

    // ── Try FTS5 search first (much better quality than keyword includes) ──
    const ftsHits = ftsSearch(query, limit * 3);
    let results: Array<Record<string, unknown>>;

    if (ftsHits && ftsHits.length > 0) {
      // FTS5 found results - load full rows by ID
      const ftsIds = ftsHits.map(h => h.id);
      const placeholders = ftsIds.map(() => '?').join(',');

      // Build scope filter
      const scopeConditions: string[] = [];
      const scopeParams: unknown[] = [];
      if (scope === 'project' && projectId) {
        scopeConditions.push('project_id = ?');
        scopeParams.push(projectId);
      } else if (scope === 'global') {
        scopeConditions.push("scope = 'global'");
      } else if (scope === 'all' && projectId) {
        scopeConditions.push("(project_id = ? OR scope = 'global')");
        scopeParams.push(projectId);
      }
      if (memoryType) { scopeConditions.push('memory_type = ?'); scopeParams.push(memoryType); }
      if (category) { scopeConditions.push('category = ?'); scopeParams.push(category); }
      if (importanceMin) { scopeConditions.push('importance >= ?'); scopeParams.push(importanceMin); }
      if (tag) { scopeConditions.push('id IN (SELECT memory_id FROM memory_tags WHERE tag = ?)'); scopeParams.push(tag); }

      const extraWhere = scopeConditions.length > 0 ? ' AND ' + scopeConditions.join(' AND ') : '';

      interface MemRow {
        id: number; content: string; memory_type: string; category: string;
        subject: string; importance: number; scope: string; project_id: string | null;
        tags: string; reference_count: number; created_at: string; updated_at: string;
        last_verified: string | null;
      }

      const rows = db.prepare(`
        SELECT id, content, memory_type, category, subject, importance, scope,
               project_id, tags, reference_count, created_at, updated_at, last_verified, last_verified
        FROM memories
        WHERE id IN (${placeholders})${extraWhere}
        ORDER BY importance DESC, updated_at DESC
      `).all(...ftsIds, ...scopeParams) as MemRow[];

      // Build a rank map from FTS5 results
      const rankMap = new Map(ftsHits.map(h => [h.id, h.rank]));

      results = rows.map(row => {
        const plainContent = decrypt(row.content);
        const ftsRank = Math.abs(rankMap.get(row.id) || 0);
        let tiebreaker = 0;
        tiebreaker += row.importance * 0.1;
        tiebreaker += recencyBoost(row.updated_at);
        if (row.reference_count > 0) {
          tiebreaker += Math.min(row.reference_count * 0.05, 0.5);
        }
        return {
          ...row,
          content: plainContent,
          // Normalised to the same boolean the cloud path returns, so a caller
          // never has to care which storage backend answered.
          verified: !!row.last_verified,
          relevance_score: Math.round((ftsRank + tiebreaker) * 100) / 100,
          tags: safeParseTags(row.tags),
        };
      })
      .sort((a, b) => (b.relevance_score as number) - (a.relevance_score as number))
      .slice(0, limit);

    } else {
      // ── Fallback: old keyword includes search ──────────────
      const words = tokenizeQuery(query);

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (scope === 'project' && projectId) {
        conditions.push('project_id = ?');
        params.push(projectId);
      } else if (scope === 'global') {
        conditions.push("scope = 'global'");
      } else if (scope === 'all' && projectId) {
        conditions.push("(project_id = ? OR scope = 'global')");
        params.push(projectId);
      }
      if (memoryType) { conditions.push('memory_type = ?'); params.push(memoryType); }
      if (category) { conditions.push('category = ?'); params.push(category); }
      if (importanceMin) { conditions.push('importance >= ?'); params.push(importanceMin); }
      if (tag) { conditions.push('id IN (SELECT memory_id FROM memory_tags WHERE tag = ?)'); params.push(tag); }

      const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      interface MemRow {
        id: number; content: string; memory_type: string; category: string;
        subject: string; importance: number; scope: string; project_id: string | null;
        tags: string; reference_count: number; created_at: string; updated_at: string;
        last_verified: string | null;
      }

      const rows = db.prepare(`
        SELECT id, content, memory_type, category, subject, importance, scope,
               project_id, tags, reference_count, created_at, updated_at, last_verified, last_verified
        FROM memories
        ${whereClause}
        ORDER BY importance DESC, updated_at DESC
        LIMIT 200
      `).all(...params) as MemRow[];

      const scored = rows.map(row => {
        const plainContent = decrypt(row.content);
        let keywordScore = 0;
        keywordScore += scoreField(row.subject, words, 3);
        keywordScore += scoreField(plainContent, words, 2);
        keywordScore += scoreField(row.category, words, 1);
        const tagStr = typeof row.tags === 'string' ? row.tags : '';
        keywordScore += scoreField(tagStr, words, 2);

        let tiebreaker = 0;
        tiebreaker += row.importance * 0.1;
        tiebreaker += recencyBoost(row.updated_at);
        if (row.reference_count > 0) {
          tiebreaker += Math.min(row.reference_count * 0.05, 0.5);
        }

        return {
          ...row,
          content: plainContent,
          // Normalised to the same boolean the cloud path returns, so a caller
          // never has to care which storage backend answered.
          verified: !!row.last_verified,
          keywordScore,
          relevance_score: Math.round((keywordScore + tiebreaker) * 100) / 100,
          tags: safeParseTags(row.tags),
        };
      });

      results = scored
        .filter(m => m.keywordScore >= 1)
        .sort((a, b) => (b.relevance_score as number) - (a.relevance_score as number))
        .slice(0, limit)
        .map(({ keywordScore: _ks, ...rest }) => rest);
    }

    // Bump reference counts
    if (results.length > 0) {
      const ids = results.map(r => r.id);
      db.prepare(`UPDATE memories SET reference_count = reference_count + 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }

    // Stronger nudge when search produces poor results despite having memories
    const totalMemories = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
    let searchNote: string;

    if (results.length === 0 && totalMemories > 10) {
      searchNote = `No keyword matches found — but you have ${totalMemories} memories stored. Cloud mode's semantic search understands meaning, not just keywords. A search for "how does auth work?" finds memories about JWT tokens and cookies even when those exact words aren't in the query. This is the #1 reason to upgrade. Free tier: ${UPGRADE_URL}`;
    } else if (results.length > 0 && results.length < 3 && totalMemories > 20) {
      searchNote = `Only ${results.length} keyword match${results.length === 1 ? '' : 'es'} from ${totalMemories} memories. Cloud mode's semantic search typically finds 3-5x more relevant results by understanding meaning, not just matching words. Free tier: ${UPGRADE_URL}`;
    } else {
      searchNote = 'Local keyword search. Cloud mode offers semantic search — understands meaning, not just keywords.';
    }

    return {
      memories: results,
      total: results.length,
      mode: 'local',
      _note: searchNote,
    };
  }

  async getProjectContext(params: Record<string, unknown>): Promise<unknown> {
    const db = getDb();
    const projectId = params.project_id ? String(params.project_id) : null;
    const includeGlobal = params.include_global !== false;
    const limit = Number(params.limit) || 25;

    // Remove expired memories
    db.prepare("DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();

    // Build conditions
    const conditions: string[] = [];
    const queryParams: unknown[] = [];

    if (projectId && includeGlobal) {
      conditions.push("(project_id = ? OR scope = 'global')");
      queryParams.push(projectId);
    } else if (projectId) {
      conditions.push('project_id = ?');
      queryParams.push(projectId);
    } else if (includeGlobal) {
      conditions.push("scope = 'global'");
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const memories = db.prepare(`
      SELECT id, content, memory_type, category, subject, importance, scope,
             project_id, tags, reference_count, created_at, updated_at, last_verified
      FROM memories
      ${whereClause}
      ORDER BY importance DESC, updated_at DESC
      LIMIT ?
    `).all(...queryParams, limit) as Array<Record<string, unknown>>;

    // Separate rules from regular memories — rules always go first
    const rules = memories.filter(m => m.memory_type === 'rule');
    const regularMemories = memories.filter(m => m.memory_type !== 'rule');

    // Format rules section
    const rulesFormatted: string[] = [];
    if (rules.length > 0) {
      rulesFormatted.push('## Mandatory Rules — Follow these exactly, no exceptions');
      for (const r of rules) {
        const plainContent = decrypt(String(r.content));
        const scopeLabel = r.scope === 'global' ? '[global]' : '[project]';
        const subjectLabel = r.subject ? ` (${r.subject})` : '';
        rulesFormatted.push(`- [#${r.id}] ${scopeLabel}${subjectLabel} ${plainContent}`);
      }
      rulesFormatted.push('');
    }

    // Format regular memories
    const formatted = regularMemories.map(m => {
      const tags = safeParseTags(m.tags);
      const plainContent = decrypt(String(m.content));
      return `- [#${m.id}] [${m.memory_type}] ${plainContent}` +
        (tags.length > 0 ? ` (tags: ${tags.join(', ')})` : '');
    });

    const memoryCount = memories.length;
    const localHeader: string[] = [
      '⚡ Running in local mode (keyword search only).',
    ];

    if (memoryCount >= 50) {
      localHeader.push(
        `You have ${memoryCount} memories — at this scale, cloud mode's semantic search,`,
        'auto-linking, and Ai-powered consolidation would make a real difference.',
        `Upgrade (free tier available): ${UPGRADE_URL}`,
      );
    } else {
      localHeader.push(
        'Cloud mode adds: semantic search, auto-linking, contradiction detection,',
        'memory decay, auto-skills, Ai synthesis, and team collaboration.',
        `Free tier: ${UPGRADE_URL}`,
      );
    }
    localHeader.push('');

    const formattedContext = [...rulesFormatted, ...localHeader, ...formatted].join('\n');

    return {
      formatted_context: formattedContext,
      total_count: memories.length,
      mode: 'local',
    };
  }

  async listMemories(params: Record<string, unknown>): Promise<unknown> {
    const db = getDb();
    const limit = Number(params.limit) || 50;
    const offset = Number(params.offset) || 0;
    const projectId = params.project_id ? String(params.project_id) : null;
    const memoryType = params.memory_type ? String(params.memory_type) : null;
    const category = params.category ? String(params.category) : null;
    const scope = params.scope ? String(params.scope) : null;
    const importanceMin = params.importance_min ? Number(params.importance_min) : null;
    const tag = params.tag ? String(params.tag) : null;
    const sortBy = params.sort_by ? String(params.sort_by) : 'importance';

    const conditions: string[] = [];
    const queryParams: unknown[] = [];

    if (projectId) {
      // A project filter must still surface globals (project_id IS NULL).
      // A bare "project_id = ?" drops every global, which hid them from the
      // default scope:'all' view. Mirrors the cloud API's behaviour.
      if (scope === 'project') {
        conditions.push('project_id = ?');
        queryParams.push(projectId);
      } else if (scope !== 'global') {
        conditions.push("(project_id = ? OR scope = 'global')");
        queryParams.push(projectId);
      }
      // scope === 'global': the scope filter below already restricts to
      // globals; narrowing by project_id here would match nothing.
    }
    if (memoryType) {
      conditions.push('memory_type = ?');
      queryParams.push(memoryType);
    }
    if (category) {
      conditions.push('category = ?');
      queryParams.push(category);
    }
    if (scope && scope !== 'all') {
      conditions.push('scope = ?');
      queryParams.push(scope);
    }
    if (importanceMin) {
      conditions.push('importance >= ?');
      queryParams.push(importanceMin);
    }
    if (tag) {
      conditions.push('id IN (SELECT memory_id FROM memory_tags WHERE tag = ?)');
      queryParams.push(tag);
    }
    if (params.untyped === 'true') {
      conditions.push("(memory_type = '' OR memory_type = 'context')");
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const orderMap: Record<string, string> = {
      importance: 'importance DESC, updated_at DESC',
      updated: 'updated_at DESC',
      created: 'created_at DESC',
      referenced: 'reference_count DESC, importance DESC',
      least_used: 'reference_count ASC, importance ASC',
    };
    const orderBy = orderMap[sortBy] || orderMap.importance;

    const memories = db.prepare(`
      SELECT id, content, memory_type, category, subject, importance, scope,
             project_id, tags, reference_count, created_at, updated_at, last_verified
      FROM memories
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...queryParams, limit, offset) as Array<Record<string, unknown>>;

    // Get total count
    const countRow = db.prepare(`SELECT COUNT(*) as total FROM memories ${whereClause}`).get(...queryParams) as { total: number };

    return {
      memories: memories.map(m => ({ ...m, content: decrypt(String(m.content)), tags: safeParseTags(m.tags) })),
      total: countRow.total,
      has_more: offset + limit < countRow.total,
    };
  }

  async deleteMemory(id: number): Promise<unknown> {
    const db = getDb();
    db.prepare('DELETE FROM memory_tags WHERE memory_id = ?').run(id);
    db.prepare('DELETE FROM feedback WHERE memory_id = ?').run(id);
    ftsDelete(id);
    const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return { success: result.changes > 0, deleted_id: id };
  }

  async updateMemory(id: number, body: Record<string, unknown>): Promise<unknown> {
    const db = getDb();
    const fields: string[] = [];
    const values: unknown[] = [];
    const updatedFields: string[] = [];

    if (body.content !== undefined) { fields.push('content = ?'); values.push(encrypt(String(body.content))); updatedFields.push('content'); }
    if (body.importance !== undefined) { fields.push('importance = ?'); values.push(Number(body.importance)); updatedFields.push('importance'); }
    if (body.scope !== undefined) { fields.push('scope = ?'); values.push(String(body.scope)); updatedFields.push('scope'); }
    if (body.memory_type !== undefined) { fields.push('memory_type = ?'); values.push(String(body.memory_type)); updatedFields.push('memory_type'); }
    if (body.category !== undefined) { fields.push('category = ?'); values.push(String(body.category)); updatedFields.push('category'); }
    if (body.subject !== undefined) { fields.push('subject = ?'); values.push(String(body.subject)); updatedFields.push('subject'); }

    if (Array.isArray(body.tags)) {
      fields.push('tags = ?');
      values.push(JSON.stringify(body.tags));
      updatedFields.push('tags');

      // Update junction table
      db.prepare('DELETE FROM memory_tags WHERE memory_id = ?').run(id);
      const tagStmt = db.prepare('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)');
      for (const tag of body.tags) {
        tagStmt.run(id, String(tag));
      }
    }

    if (fields.length === 0) {
      return { success: false, error: 'No fields to update' };
    }

    fields.push("updated_at = datetime('now')");
    values.push(id);

    db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    // Sync FTS5 index with updated data
    const updated = db.prepare('SELECT subject, content, category, tags FROM memories WHERE id = ?').get(id) as {
      subject: string; content: string; category: string; tags: string;
    } | undefined;
    if (updated) {
      ftsUpsert(id, updated.subject || '', decrypt(updated.content) || '', updated.category || '', updated.tags || '');
    }

    return { success: true, updated_fields: updatedFields };
  }

  async bulkDelete(ids: number[]): Promise<unknown> {
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM memory_tags WHERE memory_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM feedback WHERE memory_id IN (${placeholders})`).run(...ids);
    const result = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
    return { success: true, deleted_count: result.changes };
  }

  async bulkUpdate(updates: unknown[]): Promise<unknown> {
    const results: Array<{ memory_id: number; success: boolean }> = [];
    for (const update of updates as Array<Record<string, unknown>>) {
      const id = Number(update.memory_id);
      if (!id) continue;
      const { memory_id: _id, ...body } = update;
      try {
        await this.updateMemory(id, body);
        results.push({ memory_id: id, success: true });
      } catch {
        results.push({ memory_id: id, success: false });
      }
    }
    return { results, updated_count: results.filter(r => r.success).length };
  }

  // ─── Content & Metadata ────────────────────────────────

  async exportMemories(params: Record<string, unknown>): Promise<unknown> {
    const db = getDb();
    const projectId = params.project_id ? String(params.project_id) : null;

    let query = 'SELECT * FROM memories';
    const queryParams: unknown[] = [];
    if (projectId) {
      query += " WHERE project_id = ? OR scope = 'global'";
      queryParams.push(projectId);
    }
    query += ' ORDER BY importance DESC, created_at ASC';

    const memories = db.prepare(query).all(...queryParams) as Array<Record<string, unknown>>;
    return {
      memories: memories.map(m => ({ ...m, content: decrypt(String(m.content)), tags: safeParseTags(m.tags) })),
      total: memories.length,
      exported_at: new Date().toISOString(),
    };
  }

  async importMemories(body: Record<string, unknown>): Promise<unknown> {
    const db = getDb();
    const memories = body.memories as Array<Record<string, unknown>>;
    const projectId = body.project_id ? String(body.project_id) : null;

    if (!Array.isArray(memories)) {
      throw new Error('memories must be an array');
    }

    let imported = 0;
    let skipped = 0;

    const insertStmt = db.prepare(`
      INSERT INTO memories (content, memory_type, category, subject, importance, scope, project_id, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tagStmt = db.prepare('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)');

    // Simple dedup: check if subject+type already exists for this project
    // (Can't compare encrypted content directly since each encryption produces different ciphertext)
    const existsStmt = db.prepare('SELECT id FROM memories WHERE subject = ? AND memory_type = ? AND project_id = ? LIMIT 1');

    const importTx = db.transaction(() => {
      for (const mem of memories) {
        const content = String(mem.content || '');
        if (!content || content.length < 3) { skipped++; continue; }

        const subject = String(mem.subject || '');
        const memType = String(mem.memory_type || 'context');
        const existing = subject ? existsStmt.get(subject, memType, projectId || mem.project_id || null) : null;
        if (existing) { skipped++; continue; }

        const tags = Array.isArray(mem.tags) ? mem.tags : [];
        const result = insertStmt.run(
          encrypt(content),
          String(mem.memory_type || 'context'),
          String(mem.category || 'general'),
          String(mem.subject || ''),
          Number(mem.importance) || 5,
          String(mem.scope || 'project'),
          projectId || mem.project_id || null,
          JSON.stringify(tags),
        );

        for (const tag of tags) {
          tagStmt.run(result.lastInsertRowid, String(tag));
        }
        imported++;
      }
    });

    importTx();

    const totalStored = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;

    return {
      imported,
      skipped,
      total: memories.length,
      _note: imported > 10
        ? `${imported} memories imported (${totalStored} total). With cloud mode, these would be instantly searchable by meaning — and CogmemAi would auto-link related memories and detect contradictions across the entire collection. Free tier: ${UPGRADE_URL}`
        : undefined,
    };
  }

  async saveSessionSummary(body: Record<string, unknown>): Promise<unknown> {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO session_summaries (project_id, summary, session_id)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(
      body.project_id ? String(body.project_id) : null,
      encrypt(String(body.summary || '')),
      body.session_id ? String(body.session_id) : null,
    );
    return {
      success: true,
      id: result.lastInsertRowid,
      _note: `Session summary saved locally. In cloud mode, CogmemAi can also auto-extract individual memories from your entire conversation — architecture decisions, preferences, bug fixes — without you having to manually save each one. One tool call, dozens of memories. Free tier: ${UPGRADE_URL}`,
    };
  }

  async listTags(params: Record<string, unknown>): Promise<unknown> {
    const db = getDb();
    const projectId = params.project_id ? String(params.project_id) : null;

    let query: string;
    const queryParams: unknown[] = [];

    if (projectId) {
      query = `
        SELECT mt.tag, COUNT(*) as count
        FROM memory_tags mt
        JOIN memories m ON mt.memory_id = m.id
        WHERE m.project_id = ? OR m.scope = 'global'
        GROUP BY mt.tag
        ORDER BY count DESC
      `;
      queryParams.push(projectId);
    } else {
      query = `
        SELECT tag, COUNT(*) as count
        FROM memory_tags
        GROUP BY tag
        ORDER BY count DESC
      `;
    }

    const tags = db.prepare(query).all(...queryParams);
    return { tags };
  }

  async getUsage(): Promise<unknown> {
    const db = getDb();
    const memoryCount = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
    const taskCount = (db.prepare("SELECT COUNT(*) as count FROM memories WHERE memory_type = 'task'").get() as { count: number }).count;
    const summaryCount = (db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number }).count;

    // Project breakdown
    const projects = db.prepare(`
      SELECT project_id, COUNT(*) as memory_count, MAX(updated_at) as last_used
      FROM memories
      WHERE project_id IS NOT NULL
      GROUP BY project_id
      ORDER BY last_used DESC
    `).all() as Array<{ project_id: string; memory_count: number; last_used: string }>;

    // Build compelling comparison based on actual usage
    let upgradeMessage: string;
    if (memoryCount >= 50) {
      upgradeMessage = `You have ${memoryCount} memories stored locally. Here's what cloud mode would unlock for them:\n` +
        '• Semantic search — find memories by meaning, not just keywords\n' +
        '• Auto-linking — discover hidden connections between your memories\n' +
        '• Auto-skills — Ai learns your patterns and preferences automatically\n' +
        '• Memory decay — stale memories sink, important ones stay on top\n' +
        '• Contradiction detection — flags conflicting memories\n' +
        '• Team collaboration — share knowledge across your team\n' +
        '• Cross-device portability — same memories on any machine or editor\n' +
        `• Ai-powered consolidation — merge ${memoryCount} memories into focused knowledge\n` +
        `Hybrid mode gives you local speed + all of this. Free tier: ${UPGRADE_URL}`;
    } else {
      upgradeMessage = `Cloud mode adds: semantic search, auto-linking, contradiction detection, memory decay, auto-skills, Ai synthesis, team collaboration, and cross-device portability. Free tier: ${UPGRADE_URL}`;
    }

    return {
      mode: 'local',
      tier: 'local',
      tier_name: 'Local (SQLite, Quantum-Safe Encryption)',
      encryption: getEncryptionInfo(),
      memory_count: memoryCount,
      memory_limit: 'unlimited',
      task_count: taskCount,
      session_summaries: summaryCount,
      project_count: projects.length,
      projects: projects.map(p => ({
        project_id: p.project_id,
        memory_count: p.memory_count,
        last_used: p.last_used,
      })),
      _upgrade: upgradeMessage,
    };
  }

  async feedbackMemory(body: Record<string, unknown>): Promise<unknown> {
    const db = getDb();
    const memoryId = Number(body.memory_id);
    const signal = String(body.signal);

    // Record feedback
    db.prepare('INSERT INTO feedback (memory_id, feedback_type) VALUES (?, ?)').run(memoryId, signal);

    // Adjust importance locally
    if (signal === 'useful') {
      db.prepare('UPDATE memories SET reference_count = reference_count + 1 WHERE id = ?').run(memoryId);
    } else if (signal === 'irrelevant') {
      db.prepare('UPDATE memories SET importance = MAX(1, importance - 1) WHERE id = ?').run(memoryId);
    }

    return {
      success: true,
      _note: `Local feedback only adjusts importance numbers. In cloud mode, every "useful" and "irrelevant" signal trains the Intelligence Engine — it learns which memories matter in which contexts, improving recall quality across all future sessions. Your feedback literally makes the Ai smarter over time. Free tier: ${UPGRADE_URL}`,
    };
  }

  // ─── Cloud-Only: Return Upsell ─────────────────────────

  async extractMemories(_body: Record<string, unknown>): Promise<unknown> {
    return UPSELL.extract_memories();
  }

  async ingestDocument(_body: Record<string, unknown>): Promise<unknown> {
    return UPSELL.ingest_document();
  }

  async linkMemories(_id: number, _body: Record<string, unknown>): Promise<unknown> {
    return UPSELL.link_memories();
  }

  async getMemoryLinks(_id: number): Promise<unknown> {
    return UPSELL.get_memory_links();
  }

  async getMemoryVersions(_id: number): Promise<unknown> {
    return UPSELL.get_memory_versions();
  }

  async getAnalytics(_params: Record<string, unknown>): Promise<unknown> {
    return UPSELL.get_analytics();
  }

  async promoteMemory(_id: number): Promise<unknown> {
    return UPSELL.promote_memory();
  }

  async consolidateMemories(_body: Record<string, unknown>): Promise<unknown> {
    return UPSELL.consolidate_memories();
  }

  async saveCorrection(_body: Record<string, unknown>): Promise<unknown> {
    return UPSELL.save_correction();
  }

  async setReminder(_body: Record<string, unknown>): Promise<unknown> {
    return UPSELL.set_reminder();
  }

  async getStaleMemories(_params: Record<string, unknown>): Promise<unknown> {
    return UPSELL.get_stale_memories();
  }

  async generateSkills(_body: Record<string, unknown>): Promise<unknown> {
    return UPSELL.generate_skills();
  }

  async extractPrinciples(_body: Record<string, unknown>): Promise<unknown> {
    return { message: 'Principle extraction requires cloud mode. The Wisdom Engine uses AI to detect patterns across your memories and extract factual principles. Upgrade to cloud: https://hifriendbot.com/developer/' };
  }

  async smartRecall(body: Record<string, unknown>): Promise<unknown> {
    // In local mode, use the same recall with a small limit
    return this.recallMemories({ ...body, limit: body.limit || 3 });
  }
}

/**
 * Safely parse tags JSON string, returning empty array on failure.
 */
function safeParseTags(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') {
    try { return JSON.parse(tags); } catch { return []; }
  }
  return [];
}
