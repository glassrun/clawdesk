'use strict';

// Self-contained test DB — no external dependencies beyond better-sqlite3
const Database = require('better-sqlite3');
const fs = require('fs');

const TEST_DB_PATH = `/tmp/clawdesk-test-${process.pid}.db`;

function getDb() {
  // Clean slate every time
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TEST_DB_PATH + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS _changelog (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, applied_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS _audit_log (id INTEGER PRIMARY KEY, ts TEXT DEFAULT (datetime('now')), table_name TEXT NOT NULL, record_id INTEGER NOT NULL, action TEXT NOT NULL, before TEXT, after TEXT);
    CREATE TABLE IF NOT EXISTS _fts_tasks (id INTEGER PRIMARY KEY, title TEXT, description TEXT);
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY, openclaw_agent_id TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT DEFAULT 'active', budget_limit REAL DEFAULT 0, budget_spent REAL DEFAULT 0,
      heartbeat_enabled INTEGER DEFAULT 1, heartbeat_interval INTEGER DEFAULT 60,
      last_heartbeat TEXT, tasks_done INTEGER DEFAULT 0, tasks_failed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, model TEXT DEFAULT 'minimax/MiniMax-M2.7'
    );
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
      workspace_path TEXT, status TEXT DEFAULT 'active', task_total INTEGER DEFAULT 0,
      task_done INTEGER DEFAULT 0, completion_pct REAL DEFAULT 0, created_at TEXT NOT NULL,
      deleted_at TEXT, updated_at TEXT,
      is_template INTEGER DEFAULT 0, template_source_id INTEGER,
      trigger_rules TEXT DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, project_id INTEGER, assigned_agent_id INTEGER, title TEXT NOT NULL,
      description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority TEXT DEFAULT 'medium',
      dependency_id INTEGER, dependency_ids TEXT, creates_agent TEXT, created_by_agent_id INTEGER,
      created_at TEXT NOT NULL, completed_at TEXT, run_count INTEGER DEFAULT 0,
      _retry_count INTEGER DEFAULT 0, _status_changed_at TEXT, deleted_at TEXT, updated_at TEXT,
      repeat INTEGER DEFAULT 0, scheduled_at TEXT, requires_approval INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, status TEXT DEFAULT 'pending',
      requested_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT, notes TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL,
      status TEXT DEFAULT 'running', created_at TEXT NOT NULL, completed_at TEXT,
      steps TEXT DEFAULT '[]', current_step INTEGER DEFAULT 0, context TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS heartbeats (
      id INTEGER PRIMARY KEY, agent_id INTEGER, agent_name TEXT DEFAULT '',
      openclaw_agent_id TEXT DEFAULT '', triggered_at TEXT NOT NULL,
      action_taken TEXT DEFAULT '', status TEXT DEFAULT 'ok'
    );
    CREATE TABLE IF NOT EXISTS task_results (
      id INTEGER PRIMARY KEY, task_id INTEGER, agent_id INTEGER,
      input TEXT DEFAULT '', output TEXT DEFAULT '', duration_ms INTEGER DEFAULT 0,
      executed_at TEXT, created_agent TEXT DEFAULT '',
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0, tools_used TEXT
    );
  `);

  return db;
}

function closeDb(db) {
  if (db) {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const p = TEST_DB_PATH + suffix;
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
    }
  }
}

function nextId(db, table) {
  const row = db.prepare(`SELECT MAX(id) as maxId FROM ${table}`).get();
  return (row.maxId || 0) + 1;
}

function makeAgent(overrides = {}) {
  const id = overrides.id || nextId(db, 'agents');
  return {
    id,
    openclaw_agent_id: 'test-' + id,
    name: 'Agent ' + id,
    status: 'active',
    budget_limit: 0,
    budget_spent: 0,
    heartbeat_enabled: 1,
    heartbeat_interval: 60,
    last_heartbeat: null,
    tasks_done: 0,
    tasks_failed: 0,
    created_at: new Date().toISOString(),
    model: 'minimax/MiniMax-M2.7',
    ...overrides,
  };
}

module.exports = { getDb, closeDb, nextId, makeAgent, TEST_DB_PATH };