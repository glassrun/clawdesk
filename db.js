const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'clawdesk.db');
const db = new Database(DB_PATH);

// WAL mode for better concurrency — readers don't block writers
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// ===================== Schema =====================

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY,
    openclaw_agent_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    status TEXT DEFAULT 'idle',
    budget_limit REAL DEFAULT 0,
    budget_spent REAL DEFAULT 0,
    heartbeat_enabled INTEGER DEFAULT 1,
    heartbeat_interval INTEGER DEFAULT 60,
    last_heartbeat TEXT,
    tasks_done INTEGER DEFAULT 0,
    tasks_failed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    description TEXT DEFAULT '',
    workspace_path TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    task_total INTEGER DEFAULT 0,
    task_done INTEGER DEFAULT 0,
    completion_pct INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    assigned_agent_id INTEGER,
    title TEXT NOT NULL DEFAULT '',
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    priority TEXT DEFAULT 'medium',
    dependency_id INTEGER,
    creates_agent TEXT,
    created_by_agent_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    run_count INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    _status_changed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS heartbeats (
    id INTEGER PRIMARY KEY,
    agent_id INTEGER,
    agent_name TEXT DEFAULT '',
    openclaw_agent_id TEXT,
    triggered_at TEXT DEFAULT (datetime('now')),
    action_taken TEXT DEFAULT '',
    status TEXT DEFAULT 'ok'
  );

  CREATE TABLE IF NOT EXISTS task_results (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL,
    agent_id INTEGER,
    input TEXT DEFAULT '',
    output TEXT DEFAULT '',
    duration_ms INTEGER DEFAULT 0,
    executed_at TEXT DEFAULT (datetime('now')),
    created_agent TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_agent_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_heartbeats_agent ON heartbeats(agent_id);
  CREATE INDEX IF NOT EXISTS idx_results_task ON task_results(task_id);
`);

// ===================== ID Generation =====================

function nextId(table) {
  const row = db.prepare(`SELECT MAX(id) as maxId FROM ${table}`).get();
  return (row.maxId || 0) + 1;
}

// ===================== Generic CRUD =====================

function getAll(table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
}

function findOne(table, query) {
  const keys = Object.keys(query);
  const where = keys.map(k => `${k} = ?`).join(' AND ');
  const vals = keys.map(k => query[k]);
  return db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...vals);
}

function insert(table, row) {
  const keys = Object.keys(row);
  const cols = keys.join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`);
  const info = stmt.run(...keys.map(k => row[k]));
  return { ...row, id: info.lastInsertRowid };
}

function update(table, query, changes) {
  const qKeys = Object.keys(query);
  const cKeys = Object.keys(changes);
  const where = qKeys.map(k => `${k} = ?`).join(' AND ');
  const set = cKeys.map(k => `${k} = ?`).join(', ');
  const vals = [...cKeys.map(k => changes[k]), ...qKeys.map(k => query[k])];
  db.prepare(`UPDATE ${table} SET ${set} WHERE ${where}`).run(...vals);
}

function remove(table, query) {
  const keys = Object.keys(query);
  const where = keys.map(k => `${k} = ?`).join(' AND ');
  db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...keys.map(k => query[k]));
}

// ===================== Table-specific wrappers =====================
// These match the loadYaml/saveYaml interface used throughout server.js

function loadAgents() {
  return db.prepare('SELECT * FROM agents').all();
}

function saveAgents(data) {
  db.exec('DELETE FROM agents');
  const ins = db.prepare(`INSERT INTO agents (id, openclaw_agent_id, name, status, budget_limit, budget_spent, heartbeat_enabled, heartbeat_interval, last_heartbeat, tasks_done, tasks_failed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const a of data) ins.run(a.id, a.openclaw_agent_id, a.name, a.status, a.budget_limit, a.budget_spent, a.heartbeat_enabled, a.heartbeat_interval, a.last_heartbeat, a.tasks_done, a.tasks_failed, a.created_at);
}

function loadProjects() {
  return db.prepare('SELECT * FROM projects').all();
}

function saveProjects(data) {
  db.exec('DELETE FROM projects');
  const ins = db.prepare(`INSERT INTO projects (id, title, description, workspace_path, status, task_total, task_done, completion_pct, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of data) ins.run(p.id, p.title, p.description, p.workspace_path, p.status, p.task_total, p.task_done, p.completion_pct, p.created_at);
}

function loadTasks() {
  return db.prepare('SELECT * FROM tasks').all();
}

function saveTasks(data) {
  db.exec('DELETE FROM tasks');
  const ins = db.prepare(`INSERT INTO tasks (id, project_id, assigned_agent_id, title, description, status, priority, dependency_id, creates_agent, created_by_agent_id, created_at, completed_at, run_count, retry_count, _status_changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const t of data) ins.run(t.id, t.project_id, t.assigned_agent_id, t.title, t.description, t.status, t.priority, t.dependency_id, t.creates_agent, t.created_by_agent_id, t.created_at, t.completed_at, t.run_count, t.retry_count, t._status_changed_at);
}

function loadHeartbeats() {
  return db.prepare('SELECT * FROM heartbeats ORDER BY id DESC').all();
}

function saveHeartbeats(data) {
  const MAX = 1000;
  const trimmed = data.slice(-MAX);
  db.exec('DELETE FROM heartbeats');
  const ins = db.prepare(`INSERT INTO heartbeats (id, agent_id, agent_name, openclaw_agent_id, triggered_at, action_taken, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const h of trimmed) ins.run(h.id, h.agent_id, h.agent_name, h.openclaw_agent_id, h.triggered_at, h.action_taken, h.status);
}

function loadTaskResults() {
  return db.prepare('SELECT * FROM task_results ORDER BY id DESC').all();
}

function saveTaskResults(data) {
  const MAX = 500;
  const trimmed = data.slice(-MAX);
  db.exec('DELETE FROM task_results');
  const ins = db.prepare(`INSERT INTO task_results (id, task_id, agent_id, input, output, duration_ms, executed_at, created_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of trimmed) ins.run(r.id, r.task_id, r.agent_id, r.input, r.output, r.duration_ms, r.executed_at, r.created_agent);
}

// Convenience wrappers used in server.js
function insertAgent(a) {
  const id = nextId('agents');
  db.prepare(`INSERT INTO agents (id, openclaw_agent_id, name, status, budget_limit, budget_spent, heartbeat_enabled, heartbeat_interval, last_heartbeat, tasks_done, tasks_failed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, a.openclaw_agent_id, a.name, a.status || 'idle', a.budget_limit || 0, a.budget_spent || 0, a.heartbeat_enabled == null ? 1 : a.heartbeat_enabled, a.heartbeat_interval || 60, a.last_heartbeat, a.tasks_done || 0, a.tasks_failed || 0, a.created_at || new Date().toISOString());
  return id;
}

function insertHeartbeat(h) {
  const id = nextId('heartbeats');
  db.prepare(`INSERT INTO heartbeats (id, agent_id, agent_name, openclaw_agent_id, triggered_at, action_taken, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, h.agent_id, h.agent_name || '', h.openclaw_agent_id || '', h.triggered_at, h.action_taken, h.status || 'ok');
  return id;
}

function insertTaskResult(r) {
  const id = nextId('task_results');
  db.prepare(`INSERT INTO task_results (id, task_id, agent_id, input, output, duration_ms, executed_at, created_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, r.task_id, r.agent_id, r.input, r.output, r.duration_ms, r.executed_at, r.created_agent);
  return id;
}

module.exports = {
  db,
  nextId,
  getAll,
  findOne,
  insert,
  update,
  remove,
  loadAgents,
  saveAgents,
  loadProjects,
  saveProjects,
  loadTasks,
  saveTasks,
  loadHeartbeats,
  saveHeartbeats,
  loadTaskResults,
  saveTaskResults,
  insertAgent,
  insertHeartbeat,
  insertTaskResult,
};
