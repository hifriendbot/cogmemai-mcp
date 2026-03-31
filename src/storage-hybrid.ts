/**
 * CogmemAi Hybrid Storage Backend — composes cloud + local.
 *
 * Writes: Local first (fast, guaranteed) → cloud in parallel.
 * Reads: Cloud first (semantic search) → local fallback on network error.
 * Sync: Lazy push of unsynced records at session start/end.
 */

import type { StorageBackend } from './storage.js';
import type { StorageMode } from './config.js';
import { CloudStorage } from './storage-cloud.js';
import { LocalStorage } from './storage-local.js';
import { getDb } from './local-db.js';

export class HybridStorage implements StorageBackend {
  readonly mode: StorageMode = 'hybrid';
  private cloud: CloudStorage;
  private local: LocalStorage;

  constructor() {
    this.cloud = new CloudStorage();
    this.local = new LocalStorage();
  }

  // ─── Core CRUD ─────────────────────────────────────────

  async saveMemory(body: Record<string, unknown>): Promise<unknown> {
    // Write local first (guaranteed), then cloud in parallel
    const localResult = await this.local.saveMemory(body);
    const localId = (localResult as Record<string, unknown>).memory_id;

    // Cloud in background — don't block on failure
    this.cloud.saveMemory(body).then(cloudResult => {
      // Link local record to cloud ID for sync tracking
      const cloudId = (cloudResult as Record<string, unknown>).memory_id;
      if (cloudId && localId) {
        try {
          const db = getDb();
          db.prepare('UPDATE memories SET cloud_id = ?, synced = 1 WHERE id = ?').run(cloudId, localId);
        } catch { /* non-critical */ }
      }
    }).catch(() => {
      // Mark as unsynced for later push
      try {
        const db = getDb();
        db.prepare('UPDATE memories SET synced = 0 WHERE id = ?').run(localId);
      } catch { /* non-critical */ }
    });

    return { ...(localResult as object), mode: 'hybrid' };
  }

  async recallMemories(body: Record<string, unknown>): Promise<unknown> {
    // Prefer cloud (semantic search), fall back to local
    try {
      const result = await this.cloud.recallMemories(body);
      return { ...(result as object), mode: 'hybrid', source: 'cloud' };
    } catch {
      const fallback = await this.local.recallMemories(body);
      return {
        ...(fallback as object),
        mode: 'hybrid',
        source: 'local_fallback',
        _note: 'Cloud unavailable. Showing local keyword results. Semantic search will resume when connection is restored.',
      };
    }
  }

  async getProjectContext(params: Record<string, unknown>): Promise<unknown> {
    // Push unsynced records before loading context
    this.syncUnsynced().catch(() => {});

    try {
      const result = await this.cloud.getProjectContext(params);
      return { ...(result as object), mode: 'hybrid', source: 'cloud' };
    } catch {
      const fallback = await this.local.getProjectContext(params);
      const formatted = (fallback as Record<string, unknown>).formatted_context || '';
      return {
        ...fallback as object,
        formatted_context: `⚡ Hybrid mode — cloud unavailable, showing local memories.\n${formatted}`,
        mode: 'hybrid',
        source: 'local_fallback',
      };
    }
  }

  async listMemories(params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.cloud.listMemories(params);
    } catch {
      return { ...(await this.local.listMemories(params) as object), _note: 'Cloud unavailable. Showing local results.' };
    }
  }

  async deleteMemory(id: number): Promise<unknown> {
    // Delete from both
    const results: Record<string, unknown> = {};
    try { results.cloud = await this.cloud.deleteMemory(id); } catch { results.cloud_error = 'Cloud unavailable — will sync later'; }
    try { results.local = await this.local.deleteMemory(id); } catch { /* may not exist locally */ }
    return { ...results, success: true };
  }

  async updateMemory(id: number, body: Record<string, unknown>): Promise<unknown> {
    // Update both
    const results: Record<string, unknown> = {};
    try { results.cloud = await this.cloud.updateMemory(id, body); } catch { results.cloud_error = 'Cloud unavailable'; }

    // Try to find local ID by cloud_id
    try {
      const db = getDb();
      const localRow = db.prepare('SELECT id FROM memories WHERE cloud_id = ? OR id = ?').get(id, id) as { id: number } | undefined;
      if (localRow) {
        results.local = await this.local.updateMemory(localRow.id, body);
      }
    } catch { /* non-critical */ }

    return { ...results, success: true };
  }

  async bulkDelete(ids: number[]): Promise<unknown> {
    const results: Record<string, unknown> = {};
    try { results.cloud = await this.cloud.bulkDelete(ids); } catch { results.cloud_error = 'Cloud unavailable'; }
    try { results.local = await this.local.bulkDelete(ids); } catch { /* non-critical */ }
    return results;
  }

  async bulkUpdate(updates: unknown[]): Promise<unknown> {
    const results: Record<string, unknown> = {};
    try { results.cloud = await this.cloud.bulkUpdate(updates); } catch { results.cloud_error = 'Cloud unavailable'; }
    try { results.local = await this.local.bulkUpdate(updates); } catch { /* non-critical */ }
    return results;
  }

  // ─── Content & Metadata ────────────────────────────────

  async exportMemories(params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.cloud.exportMemories(params);
    } catch {
      return await this.local.exportMemories(params);
    }
  }

  async importMemories(body: Record<string, unknown>): Promise<unknown> {
    // Import to both
    const results: Record<string, unknown> = {};
    try { results.cloud = await this.cloud.importMemories(body); } catch { results.cloud_error = 'Cloud unavailable'; }
    try { results.local = await this.local.importMemories(body); } catch { /* non-critical */ }
    return results;
  }

  async saveSessionSummary(body: Record<string, unknown>): Promise<unknown> {
    // Save to both, push unsynced
    const results: Record<string, unknown> = {};
    try { results.local = await this.local.saveSessionSummary(body); } catch { /* non-critical */ }
    try {
      results.cloud = await this.cloud.saveSessionSummary(body);
      // Sync unsynced records at session end
      this.syncUnsynced().catch(() => {});
    } catch { results.cloud_error = 'Cloud unavailable'; }
    return results;
  }

  async listTags(params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.cloud.listTags(params);
    } catch {
      return await this.local.listTags(params);
    }
  }

  async getUsage(): Promise<unknown> {
    try {
      const cloudUsage = await this.cloud.getUsage() as Record<string, unknown>;
      const localUsage = await this.local.getUsage() as Record<string, unknown>;
      return {
        ...cloudUsage,
        mode: 'hybrid',
        local_memory_count: localUsage.memory_count,
        unsynced_count: this.getUnsyncedCount(),
      };
    } catch {
      const localUsage = await this.local.getUsage();
      return { ...(localUsage as object), mode: 'hybrid', cloud_status: 'unavailable' };
    }
  }

  async feedbackMemory(body: Record<string, unknown>): Promise<unknown> {
    const results: Record<string, unknown> = {};
    try { results.cloud = await this.cloud.feedbackMemory(body); } catch { /* non-critical */ }
    try { results.local = await this.local.feedbackMemory(body); } catch { /* non-critical */ }
    return { success: true, ...results };
  }

  // ─── Cloud Intelligence (pass through to cloud) ────────

  async extractMemories(body: Record<string, unknown>): Promise<unknown> {
    return this.cloud.extractMemories(body);
  }

  async ingestDocument(body: Record<string, unknown>): Promise<unknown> {
    return this.cloud.ingestDocument(body);
  }

  async linkMemories(id: number, body: Record<string, unknown>): Promise<unknown> {
    return this.cloud.linkMemories(id, body);
  }

  async getMemoryLinks(id: number): Promise<unknown> {
    return this.cloud.getMemoryLinks(id);
  }

  async getMemoryVersions(id: number): Promise<unknown> {
    return this.cloud.getMemoryVersions(id);
  }

  async getAnalytics(params: Record<string, unknown>): Promise<unknown> {
    return this.cloud.getAnalytics(params);
  }

  async promoteMemory(id: number): Promise<unknown> {
    return this.cloud.promoteMemory(id);
  }

  async consolidateMemories(body: Record<string, unknown>): Promise<unknown> {
    return this.cloud.consolidateMemories(body);
  }

  async saveCorrection(body: Record<string, unknown>): Promise<unknown> {
    // Save locally too for offline access
    const results: Record<string, unknown> = {};
    try { results.cloud = await this.cloud.saveCorrection(body); } catch { results.cloud_error = 'Cloud unavailable'; }
    try { results.local = await this.local.saveMemory(body); } catch { /* non-critical */ }
    return results;
  }

  async setReminder(body: Record<string, unknown>): Promise<unknown> {
    const results: Record<string, unknown> = {};
    try { results.cloud = await this.cloud.setReminder(body); } catch { results.cloud_error = 'Cloud unavailable'; }
    try { results.local = await this.local.saveMemory(body); } catch { /* non-critical */ }
    return results;
  }

  async getStaleMemories(params: Record<string, unknown>): Promise<unknown> {
    return this.cloud.getStaleMemories(params);
  }

  async generateSkills(body: Record<string, unknown>): Promise<unknown> {
    return this.cloud.generateSkills(body);
  }

  async extractPrinciples(body: Record<string, unknown>): Promise<unknown> {
    return this.cloud.extractPrinciples(body);
  }

  // ─── Sync Helpers ──────────────────────────────────────

  /**
   * Push unsynced local records to cloud.
   * Called at session start (getProjectContext) and end (saveSessionSummary).
   */
  private async syncUnsynced(): Promise<void> {
    try {
      const db = getDb();
      const unsynced = db.prepare('SELECT * FROM memories WHERE synced = 0 LIMIT 50').all() as Array<Record<string, unknown>>;

      for (const mem of unsynced) {
        try {
          const result = await this.cloud.saveMemory({
            content: mem.content,
            memory_type: mem.memory_type,
            category: mem.category,
            subject: mem.subject,
            importance: mem.importance,
            scope: mem.scope,
            project_id: mem.project_id,
            tags: typeof mem.tags === 'string' ? JSON.parse(mem.tags) : mem.tags,
            ttl: mem.ttl || undefined,
          }) as Record<string, unknown>;

          const cloudId = result.memory_id;
          db.prepare('UPDATE memories SET synced = 1, cloud_id = ? WHERE id = ?').run(cloudId || null, mem.id);
        } catch {
          // Stop on first failure — cloud still down
          break;
        }
      }
    } catch { /* non-critical */ }
  }

  private getUnsyncedCount(): number {
    try {
      const db = getDb();
      const row = db.prepare('SELECT COUNT(*) as count FROM memories WHERE synced = 0').get() as { count: number };
      return row.count;
    } catch {
      return 0;
    }
  }
}
