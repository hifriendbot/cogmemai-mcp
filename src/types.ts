/**
 * CogmemAi TypeScript types
 */

export interface ApiResponse<T = unknown> {
  error?: string;
  [key: string]: unknown;
}

export interface Memory {
  id: number;
  content: string;
  memory_type: string;
  category: string;
  subject: string;
  importance: number;
  scope: string;
  project_id: string | null;
  relevance_score?: number;
  created_at: string;
  updated_at?: string;
}

export interface StoreResult {
  memory_id: number;
  stored: boolean;
}

export interface RecallResult {
  memories: Memory[];
  total: number;
}

export interface ExtractResult {
  extracted: number;
  memories: Array<{
    subject: string;
    content: string;
    memory_type: string;
    scope: string;
  }>;
}

export interface ContextResult {
  project_memories: Memory[];
  global_memories: Memory[];
  formatted_context: string;
  total_count: number;
}

export interface ListResult {
  memories: Memory[];
  total: number;
  has_more: boolean;
}

export interface UpdateResult {
  success: boolean;
  updated_fields: string[];
}

export interface UsageStats {
  tier: string;
  tier_name: string;
  memory_count: number;
  memory_limit: number;
  extractions_used: number;
  extractions_limit: number;
  recalls_used: number;
  recalls_limit: number;
  stores_used: number;
  stores_limit: number;
  project_count: number;
  project_limit: number;
  projects: Array<{
    project_id: string;
    project_name: string;
    last_used: string;
  }>;
}

export interface MemoryLink {
  id: number;
  memory_id: number;
  related_memory_id: number;
  relationship: 'led_to' | 'contradicts' | 'extends' | 'related';
  created_at: string;
  related_memory?: Memory;
}

export interface MemoryVersion {
  id: number;
  memory_id: number;
  content: string;
  importance: number;
  scope: string;
  changed_at: string;
}

export interface AnalyticsResult {
  most_recalled: Memory[];
  never_recalled: Memory[];
  stale_memories: Memory[];
  growth_trend: Array<{
    date: string;
    count: number;
  }>;
  by_type: Record<string, number>;
  by_category: Record<string, number>;
  total_memories: number;
}

export interface LinkResult {
  success: boolean;
  link_id: number;
}

export interface PromoteResult {
  success: boolean;
  memory_id: number;
  new_scope: string;
}
