/**
 * CogmemAi Storage Abstraction Layer — interface + factory.
 *
 * Tools call storage methods instead of api() directly.
 * The factory picks the right backend based on STORAGE_MODE.
 */

import { STORAGE_MODE, type StorageMode } from './config.js';

/**
 * StorageBackend — every tool operation maps to a method here.
 * Cloud backend wraps api(), local backend uses SQLite, hybrid composes both.
 */
export interface StorageBackend {
  readonly mode: StorageMode;

  // ─── Core CRUD ─────────────────────────────────────────
  saveMemory(body: Record<string, unknown>): Promise<unknown>;
  recallMemories(body: Record<string, unknown>): Promise<unknown>;
  getProjectContext(params: Record<string, unknown>): Promise<unknown>;
  listMemories(params: Record<string, unknown>): Promise<unknown>;
  deleteMemory(id: number): Promise<unknown>;
  updateMemory(id: number, body: Record<string, unknown>): Promise<unknown>;
  bulkDelete(ids: number[]): Promise<unknown>;
  bulkUpdate(updates: unknown[]): Promise<unknown>;

  // ─── Content & Metadata ────────────────────────────────
  exportMemories(params: Record<string, unknown>): Promise<unknown>;
  importMemories(body: Record<string, unknown>): Promise<unknown>;
  saveSessionSummary(body: Record<string, unknown>): Promise<unknown>;
  listTags(params: Record<string, unknown>): Promise<unknown>;
  getUsage(): Promise<unknown>;
  feedbackMemory(body: Record<string, unknown>): Promise<unknown>;

  // ─── Cloud Intelligence (upsell in local mode) ─────────
  extractMemories(body: Record<string, unknown>): Promise<unknown>;
  ingestDocument(body: Record<string, unknown>): Promise<unknown>;
  linkMemories(id: number, body: Record<string, unknown>): Promise<unknown>;
  getMemoryLinks(id: number): Promise<unknown>;
  getMemoryVersions(id: number): Promise<unknown>;
  getAnalytics(params: Record<string, unknown>): Promise<unknown>;
  promoteMemory(id: number): Promise<unknown>;
  consolidateMemories(body: Record<string, unknown>): Promise<unknown>;
  saveCorrection(body: Record<string, unknown>): Promise<unknown>;
  setReminder(body: Record<string, unknown>): Promise<unknown>;
  getStaleMemories(params: Record<string, unknown>): Promise<unknown>;
  generateSkills(body: Record<string, unknown>): Promise<unknown>;
  extractPrinciples(body: Record<string, unknown>): Promise<unknown>;

  // ─── Proactive recall ────────────────────────────
  smartRecall(body: Record<string, unknown>): Promise<unknown>;
}

/**
 * Create the storage backend for the current mode.
 * Lazy-imports to avoid loading SQLite deps in cloud-only mode.
 */
export async function createStorage(): Promise<StorageBackend> {
  switch (STORAGE_MODE) {
    case 'local': {
      const { LocalStorage } = await import('./storage-local.js');
      return new LocalStorage();
    }
    case 'hybrid': {
      const { HybridStorage } = await import('./storage-hybrid.js');
      return new HybridStorage();
    }
    case 'cloud':
    default: {
      const { CloudStorage } = await import('./storage-cloud.js');
      return new CloudStorage();
    }
  }
}
