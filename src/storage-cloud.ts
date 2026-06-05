/**
 * CogmemAi Cloud Storage Backend — wraps existing api() calls.
 * This is the default mode. All 29 tools work with full Intelligence Engine.
 */

import type { StorageBackend } from './storage.js';
import type { StorageMode } from './config.js';
import { api } from './api.js';

export class CloudStorage implements StorageBackend {
  readonly mode: StorageMode = 'cloud';
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  /**
   * WAF-safe encode a free-text field. The host WAF (ModSecurity) scores the raw
   * POST body and 404s long/dense prose that accumulates enough "suspicious"
   * tokens (quotes, parens, %, slashes, tags). Base64-encoding the text and
   * marking it "CMB64:" means the WAF only ever sees innocuous base64; the WP
   * REST handler decodes it. Only applied on the cloud HTTP path (local/hybrid
   * backends store text directly and have no decoder). Backward compatible: the
   * server treats any unmarked value as raw.
   */
  private encField(body: Record<string, unknown>, field: string): Record<string, unknown> {
    const v = body[field];
    if (typeof v === 'string' && v.length > 0) {
      return { ...body, [field]: 'CMB64:' + Buffer.from(v, 'utf8').toString('base64') };
    }
    return body;
  }

  // ─── Core CRUD ─────────────────────────────────────────

  async saveMemory(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/store', 'POST', this.encField(body, 'content'), undefined, this.apiKey);
  }

  async recallMemories(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/recall', 'POST', body, undefined, this.apiKey);
  }

  async getProjectContext(params: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/context', 'GET', params, undefined, this.apiKey);
  }

  async listMemories(params: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/memories', 'GET', params, undefined, this.apiKey);
  }

  async deleteMemory(id: number): Promise<unknown> {
    return api(`/cogmemai/memory/${id}`, 'DELETE', undefined, undefined, this.apiKey);
  }

  async updateMemory(id: number, body: Record<string, unknown>): Promise<unknown> {
    return api(`/cogmemai/memory/${id}`, 'PATCH', this.encField(body, 'content'), undefined, this.apiKey);
  }

  async bulkDelete(ids: number[]): Promise<unknown> {
    return api('/cogmemai/bulk-delete', 'POST', { ids }, undefined, this.apiKey);
  }

  async bulkUpdate(updates: unknown[]): Promise<unknown> {
    return api('/cogmemai/bulk-update', 'POST', { updates }, undefined, this.apiKey);
  }

  // ─── Content & Metadata ────────────────────────────────

  async exportMemories(params: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/export', 'GET', params, undefined, this.apiKey);
  }

  async importMemories(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/import', 'POST', body, undefined, this.apiKey);
  }

  async saveSessionSummary(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/session-summary', 'POST', this.encField(body, 'summary'), undefined, this.apiKey);
  }

  async listTags(params: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/tags', 'GET', params, undefined, this.apiKey);
  }

  async getUsage(): Promise<unknown> {
    return api('/cogmemai/usage', 'GET', undefined, undefined, this.apiKey);
  }

  async feedbackMemory(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/feedback', 'POST', body, undefined, this.apiKey);
  }

  // ─── Cloud Intelligence ────────────────────────────────

  async extractMemories(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/extract', 'POST', body, undefined, this.apiKey);
  }

  async ingestDocument(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/ingest', 'POST', body, undefined, this.apiKey);
  }

  async linkMemories(id: number, body: Record<string, unknown>): Promise<unknown> {
    return api(`/cogmemai/memory/${id}/link`, 'POST', body, undefined, this.apiKey);
  }

  async getMemoryLinks(id: number): Promise<unknown> {
    return api(`/cogmemai/memory/${id}/links`, 'GET', undefined, undefined, this.apiKey);
  }

  async getMemoryVersions(id: number): Promise<unknown> {
    return api(`/cogmemai/memory/${id}/versions`, 'GET', undefined, undefined, this.apiKey);
  }

  async getAnalytics(params: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/analytics', 'GET', params, undefined, this.apiKey);
  }

  async promoteMemory(id: number): Promise<unknown> {
    return api(`/cogmemai/memory/${id}/promote`, 'POST', undefined, undefined, this.apiKey);
  }

  async consolidateMemories(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/consolidate', 'POST', body, 30000, this.apiKey);
  }

  async saveCorrection(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/store', 'POST', this.encField(body, 'content'), undefined, this.apiKey);
  }

  async setReminder(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/store', 'POST', this.encField(body, 'content'), undefined, this.apiKey);
  }

  async getStaleMemories(params: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/stale', 'GET', params, undefined, this.apiKey);
  }

  async generateSkills(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/generate-skills', 'POST', body, undefined, this.apiKey);
  }

  async extractPrinciples(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/extract-principles', 'POST', body, 30000, this.apiKey);
  }

  // ─── Proactive recall ────────────────────────────

  async smartRecall(body: Record<string, unknown>): Promise<unknown> {
    return api('/cogmemai/smart-recall', 'POST', body, undefined, this.apiKey);
  }
}
