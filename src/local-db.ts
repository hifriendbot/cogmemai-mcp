/**
 * CogmemAi local SQLite database — schema, initialization, and query helpers.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { LOCAL_DB_PATH } from './config.js';

let db: Database.Database | null = null;

const SCHEMA_VERSION = 2;

/**
 * Get or create the SQLite database connection.
 */
export function getDb(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  mkdirSync(dirname(LOCAL_DB_PATH), { recursive: true });

  db = new Database(LOCAL_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initSchema(db);
  return db;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Initialize database schema and run migrations.
 */
function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );
  `);

  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;
  const currentVersion = row?.version ?? 0;

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'context',
        category TEXT NOT NULL DEFAULT 'general',
        subject TEXT DEFAULT '',
        importance INTEGER NOT NULL DEFAULT 5,
        scope TEXT NOT NULL DEFAULT 'project',
        project_id TEXT,
        tags TEXT DEFAULT '[]',
        ttl TEXT,
        expires_at TEXT,
        reference_count INTEGER DEFAULT 0,
        synced INTEGER DEFAULT 1,
        cloud_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject);
      CREATE INDEX IF NOT EXISTS idx_memories_synced ON memories(synced);

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'medium',
        project_id TEXT,
        synced INTEGER DEFAULT 1,
        cloud_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS memory_tags (
        memory_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
        UNIQUE(memory_id, tag)
      );

      CREATE INDEX IF NOT EXISTS idx_tags_tag ON memory_tags(tag);

      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL,
        feedback_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT,
        summary TEXT NOT NULL,
        session_id TEXT,
        synced INTEGER DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Set schema version after v1
    if (currentVersion === 0) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
    }
  }

  // ── Schema v2: FTS5 full-text search ─────────────────────
  if (currentVersion < 2) {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          subject,
          content,
          category,
          tags,
          content_rowid='id'
        );
      `);

      // Backfill existing memories into FTS5 table
      const existing = db.prepare('SELECT id, subject, content, category, tags FROM memories').all() as Array<{
        id: number; subject: string; content: string; category: string; tags: string;
      }>;

      if (existing.length > 0) {
        const insertFts = db.prepare(
          'INSERT OR REPLACE INTO memories_fts(rowid, subject, content, category, tags) VALUES (?, ?, ?, ?, ?)'
        );
        for (const row of existing) {
          insertFts.run(row.id, row.subject || '', row.content || '', row.category || '', row.tags || '');
        }
      }

      db.prepare('UPDATE schema_version SET version = ?').run(2);
    } catch {
      // FTS5 not available in this SQLite build - skip silently, fall back to keyword search
    }
  }
}

/**
 * Sync a memory row to the FTS5 index. Safe to call even if FTS5 is unavailable.
 */
export function ftsUpsert(id: number, subject: string, content: string, category: string, tags: string): void {
  try {
    const d = getDb();
    d.prepare(
      'INSERT OR REPLACE INTO memories_fts(rowid, subject, content, category, tags) VALUES (?, ?, ?, ?, ?)'
    ).run(id, subject, content, category, tags);
  } catch {
    // FTS5 not available - silently skip
  }
}

/**
 * Remove a memory from the FTS5 index. Safe to call even if FTS5 is unavailable.
 */
export function ftsDelete(id: number): void {
  try {
    const d = getDb();
    d.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(id);
  } catch {
    // FTS5 not available - silently skip
  }
}

/**
 * Search the FTS5 index. Returns row IDs ranked by relevance, or null if FTS5 unavailable.
 */
export function ftsSearch(query: string, limit: number): Array<{ id: number; rank: number }> | null {
  try {
    const d = getDb();
    // FTS5 match syntax: quote terms for safety, use OR between words for broader matching
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    if (words.length === 0) return null;

    // Build FTS5 query: each word as a separate OR term for broad matching
    const ftsQuery = words.map(w => `"${w.replace(/"/g, '')}"`)
      .join(' OR ');

    const rows = d.prepare(`
      SELECT rowid as id, rank
      FROM memories_fts
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{ id: number; rank: number }>;

    return rows.length > 0 ? rows : null;
  } catch {
    return null; // FTS5 not available
  }
}

/**
 * Compute expires_at from a TTL string like "7d", "24h", "30d".
 */
export function computeExpiresAt(ttl: string): string | null {
  const match = ttl.match(/^(\d+)(h|d)$/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();
  if (unit === 'h') now.setHours(now.getHours() + num);
  else if (unit === 'd') now.setDate(now.getDate() + num);
  return now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}
