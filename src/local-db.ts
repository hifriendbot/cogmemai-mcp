/**
 * CogmemAi local SQLite database — schema, initialization, and query helpers.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { LOCAL_DB_PATH } from './config.js';

let db: Database.Database | null = null;

const SCHEMA_VERSION = 1;

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

    // Set schema version
    if (currentVersion === 0) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else {
      db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
    }
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
