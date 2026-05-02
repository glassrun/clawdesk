'use strict';

const path = require('path');
const fs = require('fs');

// Use an in-memory SQLite database for tests
const TEST_DB_PATH = path.join(__dirname, '..', 'data', 'test.db');

let db;

// Lazily init the test DB
function getDb() {
  if (db) return db;
  // Destroy any existing test DB
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
  if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');

  const Database = require('better-sqlite3');
  db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS _changelog (
      id         INTEGER PRIMARY KEY,
      version    INTEGER NOT NULL,
      applied_at TEXT    DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS _audit_log (
      id         INTEGER PRIMARY KEY,
      ts         TEXT    DEFAULT (datetime('now')),
      table_name TEXT    NOT NULL,
      record_id  INTEGER NOT NULL,
      action     TEXT    NOT NULL,
      before     TEXT,
      after      TEXT
    );
    CREATE TABLE IF NOT EXISTS _fts_tasks (
      id    INTEGER PRIMARY KEY,
      title TEXT,
      description TEXT
    );
    CREATE TABLE IF NOT EXISTS agents (
      id                   INTEGER PRIMARY KEY,
      openclaw_agent_id    TEXT    NOT NULL,
      name                 TEXT    NOT NULL,
      status               TEXT    DEFAULT 'active',
      budget_limit         REAL    DEFAULT 0,
      budget_spent         REAL    DEFAULT 0,
      heartbeat_enabled    INTEGER DEFAULT 1,
      heartbeat_interval   INTEGER DEFAULT 60,
      last_heartbeat       TEXT,
      tasks_done           INTEGER DEFAULT 0,
      tasks_failed         INTEGER DEFAULT 0,
      created_at           TEXT    NOT NULL,
      model                TEXT    DEFAULT 'minimax/MiniMax-M2.7'
    );
    CREATE TABLE IF NOT EXISTS projects (
      id              INTEGER PRIMARY KEY,
      title           TEXT    NOT NULL,
      description     TEXT    DEFAULT '',
      workspace_path  TEXT,
      status          TEXT    DEFAULT 'active',
      task_total      INTEGER DEFAULT 0,
      task_done       INTEGER DEFAULT 0,
      completion_pct   REAL    DEFAULT 0,
      created_at      TEXT    NOT NULL,
      deleted_at      TEXT,
      updated_at      TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id                  INTEGER PRIMARY KEY,
      project_id          INTEGER,
      assigned_agent_id   INTEGER,
      title               TEXT    NOT NULL,
      description         TEXT    DEFAULT '',
      status              TEXT    DEFAULT 'pending',
      priority            TEXT    DEFAULT 'medium',
      dependency_id       INTEGER,
      dependency_ids      TEXT,
      creates_agent       TEXT,
      created_by_agent_id INTEGER,
      created_at          TEXT    NOT NULL,
      completed_at        TEXT,
      run_count           INTEGER DEFAULT 0,
      _retry_count        INTEGER DEFAULT 0,
      _status_changed_at  TEXT,
      deleted_at          TEXT,
      updated_at          TEXT
    );
    CREATE TABLE IF NOT EXISTS heartbeats (
      id                 INTEGER PRIMARY KEY,
      agent_id           INTEGER,
      agent_name         TEXT    DEFAULT '',
      openclaw_agent_id  TEXT    DEFAULT '',
      triggered_at       TEXT    NOT NULL,
      action_taken       TEXT    DEFAULT '',
      status             TEXT    DEFAULT 'ok'
    );
    CREATE TABLE IF NOT EXISTS task_results (
      id          INTEGER PRIMARY KEY,
      task_id     INTEGER,
      agent_id    INTEGER,
      output      TEXT,
      error       TEXT,
      status      TEXT,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
  `);

  return db;
}

function nextId(table) {
  const row = getDb().prepare(`SELECT MAX(id) as maxId FROM ${table}`).get();
  return (row.maxId || 0) + 1;
}

function loadAgents()    { return getDb().prepare("SELECT * FROM agents").all(); }
function saveAgents(data) {
  getDb().exec("DELETE FROM agents");
  const ins = getDb().prepare(`INSERT INTO agents (id,openclaw_agent_id,name,status,budget_limit,budget_spent,heartbeat_enabled,heartbeat_interval,last_heartbeat,tasks_done,tasks_failed,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const a of data) ins.run(a.id,a.openclaw_agent_id,a.name,a.status,a.budget_limit,a.budget_spent,a.heartbeat_enabled,a.heartbeat_interval,a.last_heartbeat,a.tasks_done,a.tasks_failed,a.created_at);
}
function saveAgentsIdempotent(data) {
  getDb().exec("DELETE FROM agents");
  const ins = getDb().prepare(`INSERT OR REPLACE INTO agents (id,openclaw_agent_id,name,status,budget_limit,budget_spent,heartbeat_enabled,heartbeat_interval,last_heartbeat,tasks_done,tasks_failed,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const a of data) ins.run(a.id,a.openclaw_agent_id,a.name,a.status,a.budget_limit,a.budget_spent,a.heartbeat_enabled,a.heartbeat_interval,a.last_heartbeat,a.tasks_done,a.tasks_failed,a.created_at);
}

function remove(table, query) {
  const keys = Object.keys(query);
  const where = keys.map(k => `${k} = ?`).join(' AND ');
  const vals = keys.map(k => query[k]);
  getDb().prepare(`UPDATE ${table} SET deleted_at = datetime('now') WHERE ${where}`).run(...vals);
}

function hardDelete(table, query) {
  const keys = Object.keys(query);
  const where = keys.map(k => `${k} = ?`).join(' AND ');
  getDb().prepare(`DELETE FROM ${table} WHERE ${where}`).run(...keys.map(k => query[k]));
}

function loadTasks()     { return getDb().prepare("SELECT * FROM tasks WHERE deleted_at IS NULL").all(); }

function closeDb() {
  if (db) { db.close(); db = null; }
}

module.exports = { getDb, closeDb, nextId, loadAgents, saveAgents, saveAgentsIdempotent, loadTasks, remove, hardDelete };
