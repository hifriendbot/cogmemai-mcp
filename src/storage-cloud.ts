/**
 * CogmemAi Cloud Storage Backend — wraps existing api() calls.
 * This is the default mode. All 29 tools work with full Intelligence Engine.
 */

import type { StorageBackend } from './storage.js';
import type { StorageMode } from './config.js';
import { api } from './api.js';

export class CloudStorage implements StorageBackend {
  readonly mode: StorageMode = 'cloud';

  // ─── Core CRUD ─────────────────────────────────────────

  async saveMemory(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/store', 'POST', body);
  }

  async recallMemories(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/recall', 'POST', body);
  }

  async getProjectContext(params: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/context', 'GET', params);
  }

  async listMemories(params: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/memories', 'GET', params);
  }

  async deleteMemory(id: number): Promise<unknown> {
    return api(`/cogmemai/memory/${id}`, 'DELETE');
  }

  async updateMemory(id: number, body: Record<string, unknown>): Promise<unknown> {
    return api(`/cogmemai/memory/${id}`, 'PATCH', body);
  }

  async bulkDelete(ids: number[]): Promise<unknown> {
    return api('/cogmemai/bulk-delete', 'POST', { ids });
  }

  async bulkUpdate(updates: unknown[]): Promise<unknown> {
    return api('/cogmemai/bulk-update', 'POST', { updates });
  }

  // ─── Content & Metadata ────────────────────────────────

  async exportMemories(params: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/export', 'GET', params);
  }

  async importMemories(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/import', 'POST', body);
  }

  async saveSessionSummary(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/session-summary', 'POST', body);
  }

  async listTags(params: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/tags', 'GET', params);
  }

  async getUsage(): Promise<unknown> {
    return api('/cogmemai/usage', 'GET');
  }

  async feedbackMemory(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/feedback', 'POST', body);
  }

  // ─── Cloud Intelligence ────────────────────────────────

  async extractMemories(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/extract', 'POST', body);
  }

  async ingestDocument(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/ingest', 'POST', body);
  }

  async linkMemories(id: number, body: Record<string, unknown>): Promise<unknown> {
    return api(`/cogmemai/memory/${id}/link`, 'POST', body);
  }

  async getMemoryLinks(id: number): Promise<unknown> {
    return api(`/cogmemai/memory/${id}/links`, 'GET');
  }

  async getMemoryVersions(id: number): Promise<unknown> {
    return api(`/cogmemai/memory/${id}/versions`, 'GET');
  }

  async getAnalytics(params: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/analytics', 'GET', params);
  }

  async promoteMemory(id: number): Promise<unknown> {
    return api(`/cogmemai/memory/${id}/promote`, 'POST');
  }

  async consolidateMemories(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/consolidate', 'POST', body, 30000);
  }

  async saveCorrection(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/store', 'POST', body);
  }

  async setReminder(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/store', 'POST', body);
  }

  async getStaleMemories(params: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/stale', 'GET', params);
  }

  async generateSkills(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/generate-skills', 'POST', body);
  }
}
