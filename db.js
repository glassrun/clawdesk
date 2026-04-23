const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'clawdesk.db');
const db = new Database(DB_PATH);

// WAL mode + foreign keys + busy timeout
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// ===================== Schema version / Migrations =====================

const CURRENT_VERSION = 2;

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
`);

function getVersion() {
  const row = db.prepare("SELECT MAX(version) as v FROM _changelog").get();
  return row?.v || 0;
}

// Run migrations up to CURRENT_VERSION
function runMigrations() {
  const from = getVersion();

  const migrations = [
    // v1: initial schema (already applied if _changelog has records)
    // v2: add deleted_at + FTS5
    () => {
      db.exec(`ALTER TABLE tasks  ADD COLUMN deleted_at TEXT`);
      db.exec(`ALTER TABLE projects ADD COLUMN deleted_at TEXT`);
      db.exec(`ALTER TABLE tasks  ADD COLUMN updated_at TEXT`);
      db.exec(`ALTER TABLE projects ADD COLUMN updated_at TEXT`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_priority   ON tasks(priority)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_created    ON tasks(created_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)`);
      // Rebuild FTS after schema change
      rebuildFts();
    },
  ];

  for (let v = from + 1; v <= CURRENT_VERSION; v++) {
    if (migrations[v - 1]) migrations[v - 1]();
    db.prepare("INSERT INTO _changelog (version) VALUES (?)").run(v);
    console.log(`[DB] Migration v${v} applied`);
  }

  if (from === 0 && getVersion() === 0) {
    // Fresh DB — record v1 schema init
    db.prepare("INSERT INTO _changelog (version) VALUES (1)").run();
    console.log('[DB] Initial schema v1 recorded');
  }
}

// ===================== FTS5 =====================

function rebuildFts() {
  db.exec("DELETE FROM _fts_tasks");
  const tasks = db.prepare("SELECT id, title, description FROM tasks WHERE deleted_at IS NULL").all();
  const ins = db.prepare("INSERT INTO _fts_tasks (id, title, description) VALUES (?, ?, ?)");
  for (const t of tasks) ins.run(t.id, t.title || "", t.description || "");
}

function searchTasks(query) {
  if (!query || !query.trim()) return [];
  const q = query.replace(/['"]/g, '').trim();
  const rows = db.prepare(
    "SELECT t.* FROM _fts_tasks f " +
    "JOIN tasks t ON t.id = f.id " +
    "WHERE _fts_tasks MATCH ? AND t.deleted_at IS NULL " +
    "ORDER BY rank LIMIT 50"
  ).all(q + "*");
  return rows;
}

// ===================== Audit log =====================

function audit(tableName, recordId, action, before, after) {
  db.prepare(
    "INSERT INTO _audit_log (table_name, record_id, action, before, after) VALUES (?, ?, ?, ?, ?)"
  ).run(tableName, recordId, action,
    before ? JSON.stringify(before) : null,
    after  ? JSON.stringify(after)  : null);
}

// ===================== Generic CRUD =====================

function getAll(table) {
  return db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY id`).all();
}

function getAllRaw(table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
}

function findOne(table, query) {
  const keys = Object.keys(query);
  const where = keys.map(k => `${k} = ?`).join(' AND ');
  const vals = keys.map(k => query[k]);
  return db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...vals);
}

function insert(table, row) {
  const keys = Object.keys(row).filter(k => k !== 'deleted_at' && k !== 'updated_at');
  const cols = keys.join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`);
  const info = stmt.run(...keys.map(k => row[k]));
  return { ...row, id: info.lastInsertRowid };
}

function update(table, query, changes) {
  const qKeys = Object.keys(query);
  const cKeys = Object.keys(changes).filter(k => k !== 'deleted_at');
  const where = qKeys.map(k => `${k} = ?`).join(' AND ');
  const set = cKeys.map(k => `${k} = ?`).join(', ');
  const vals = [...cKeys.map(k => changes[k]), ...qKeys.map(k => query[k])];
  db.prepare(`UPDATE ${table} SET ${set} WHERE ${where}`).run(...vals);
}

function remove(table, query) {
  // soft delete — set deleted_at instead of hard delete
  const keys = Object.keys(query);
  const where = keys.map(k => `${k} = ?`).join(' AND ');
  const vals = keys.map(k => query[k]);
  db.prepare(`UPDATE ${table} SET deleted_at = datetime('now') WHERE ${where}`).run(...vals);
}

function hardDelete(table, query) {
  const keys = Object.keys(query);
  const where = keys.map(k => `${k} = ?`).join(' AND ');
  db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...keys.map(k => query[k]));
}

// ===================== Agents =====================

function loadAgents()    { return db.prepare("SELECT * FROM agents").all(); }
function saveAgents(data) {
  db.exec("DELETE FROM agents");
  const ins = db.prepare(`INSERT INTO agents (id,openclaw_agent_id,name,status,budget_limit,budget_spent,heartbeat_enabled,heartbeat_interval,last_heartbeat,tasks_done,tasks_failed,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const a of data) ins.run(a.id,a.openclaw_agent_id,a.name,a.status,a.budget_limit,a.budget_spent,a.heartbeat_enabled,a.heartbeat_interval,a.last_heartbeat,a.tasks_done,a.tasks_failed,a.created_at);
}
function insertAgent(a) {
  const id = nextId('agents');
  db.prepare(`INSERT INTO agents (id,openclaw_agent_id,name,status,budget_limit,budget_spent,heartbeat_enabled,heartbeat_interval,last_heartbeat,tasks_done,tasks_failed,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, a.openclaw_agent_id, a.name||'idle', a.budget_limit||0, a.budget_spent||0,
         a.heartbeat_enabled==null?1:a.heartbeat_enabled, a.heartbeat_interval||60,
         a.last_heartbeat, a.tasks_done||0, a.tasks_failed||0, a.created_at||new Date().toISOString());
  return id;
}

// ===================== Projects =====================

function loadProjects()    { return db.prepare("SELECT * FROM projects WHERE deleted_at IS NULL").all(); }
function saveProjects(data) {
  db.exec("DELETE FROM projects");
  const ins = db.prepare(`INSERT INTO projects (id,title,description,workspace_path,status,task_total,task_done,completion_pct,created_at,deleted_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const p of data) ins.run(p.id,p.title,p.description,p.workspace_path,p.status,p.task_total,p.task_done,p.completion_pct,p.created_at,p.deleted_at||null,p.updated_at||null);
}
function insertProject(p) {
  const id = nextId('projects');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id,title,description,workspace_path,status,task_total,task_done,completion_pct,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, p.title||'', p.description||'', p.workspace_path||'', p.status||'active', 0, 0, 0, now);
  return id;
}

// ===================== Tasks =====================

function loadTasks()    { return db.prepare("SELECT * FROM tasks WHERE deleted_at IS NULL").all(); }
function saveTasks(data) {
  db.exec("DELETE FROM tasks");
  const ins = db.prepare(`INSERT INTO tasks (id,project_id,assigned_agent_id,title,description,status,priority,dependency_id,creates_agent,created_by_agent_id,created_at,completed_at,run_count,retry_count,_status_changed_at,deleted_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const t of data) ins.run(t.id,t.project_id,t.assigned_agent_id||null,t.title,t.description,t.status,t.priority,t.dependency_id||null,t.creates_agent||null,t.created_by_agent_id||null,t.created_at,t.completed_at||null,t.run_count||0,t.retry_count||0,t._status_changed_at||null,t.deleted_at||null,t.updated_at||null);
}
function insertTask(t) {
  const id = nextId('tasks');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tasks (id,project_id,assigned_agent_id,title,description,status,priority,dependency_id,creates_agent,created_by_agent_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, t.project_id, t.assigned_agent_id||null, t.title, t.description||'',
         t.status||'pending', t.priority||'medium', t.dependency_id||null,
         t.creates_agent||null, t.created_by_agent_id||null, now);
  return id;
}
function insertTaskBatch(batch) {
  // batch: array of task objects, returns array of inserted ids
  const results = [];
  const now = new Date().toISOString();
  for (const t of batch) {
    const id = nextId('tasks');
    db.prepare(`INSERT INTO tasks (id,project_id,assigned_agent_id,title,description,status,priority,dependency_id,creates_agent,created_by_agent_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, t.project_id, t.assigned_agent_id||null, t.title, t.description||'',
           t.status||'pending', t.priority||'medium', t.dependency_id||null,
           t.creates_agent||null, t.created_by_agent_id||null, now);
    results.push(id);
  }
  return results;
}
function updateTask(id, changes) {
  changes.updated_at = new Date().toISOString();
  const keys = Object.keys(changes).filter(k => k !== 'deleted_at');
  const set = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE tasks SET ${set} WHERE id = ?`).run(...keys.map(k => changes[k]), id);
}

// ===================== Heartbeats =====================

function loadHeartbeats()    { return db.prepare("SELECT * FROM heartbeats ORDER BY id DESC").all(); }
function saveHeartbeats(data) {
  const MAX = 1000;
  const trimmed = data.slice(-MAX);
  db.exec("DELETE FROM heartbeats");
  const ins = db.prepare(`INSERT INTO heartbeats (id,agent_id,agent_name,openclaw_agent_id,triggered_at,action_taken,status)
    VALUES (?,?,?,?,?,?,?)`);
  for (const h of trimmed) ins.run(h.id,h.agent_id||null,h.agent_name||'',h.openclaw_agent_id||'',h.triggered_at,h.action_taken||'',h.status||'ok');
}
function insertHeartbeat(h) {
  const id = nextId('heartbeats');
  db.prepare(`INSERT INTO heartbeats (id,agent_id,agent_name,openclaw_agent_id,triggered_at,action_taken,status)
    VALUES (?,?,?,?,?,?,?)`)
    .run(id, h.agent_id||null, h.agent_name||'', h.openclaw_agent_id||'', h.triggered_at, h.action_taken||'', h.status||'ok');
  return id;
}

// ===================== Task Results =====================

function loadTaskResults()    { return db.prepare("SELECT * FROM task_results ORDER BY id DESC").all(); }
function saveTaskResults(data) {
  const MAX = 500;
  const trimmed = data.slice(-MAX);
  db.exec("DELETE FROM task_results");
  const ins = db.prepare(`INSERT INTO task_results (id,task_id,agent_id,input,output,duration_ms,executed_at,created_agent)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const r of trimmed) ins.run(r.id,r.task_id,r.agent_id||null,r.input||'',r.output||'',r.duration_ms||0,r.executed_at,r.created_agent||'');
}
function insertTaskResult(r) {
  const id = nextId('task_results');
  db.prepare(`INSERT INTO task_results (id,task_id,agent_id,input,output,duration_ms,executed_at,created_agent)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, r.task_id, r.agent_id||null, r.input||'', r.output||'', r.duration_ms||0, r.executed_at||new Date().toISOString(), r.created_agent||'');
  return id;
}

// ===================== System =====================

function nextId(table) {
  const row = db.prepare(`SELECT MAX(id) as maxId FROM ${table}`).get();
  return (row.maxId || 0) + 1;
}

function vacuumDb() {
  db.exec("VACUUM");
  console.log('[DB] VACUUM complete');
}

function getDbStats() {
  const tasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE deleted_at IS NULL").get().c;
  const projects = db.prepare("SELECT COUNT(*) as c FROM projects WHERE deleted_at IS NULL").get().c;
  const agents = db.prepare("SELECT COUNT(*) as c FROM agents").get().c;
  const heartbeats = db.prepare("SELECT COUNT(*) as c FROM heartbeats").get().c;
  const results = db.prepare("SELECT COUNT(*) as c FROM task_results").get().c;
  const audit = db.prepare("SELECT COUNT(*) as c FROM _audit_log").get().c;
  const deletedTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE deleted_at IS NOT NULL").get().c;
  let dbSize = 0;
  try { dbSize = fs.statSync(DB_PATH).size; } catch {}
  return { tasks, projects, agents, heartbeats, task_results: results, audit_entries: audit, deleted_tasks: deletedTasks, db_size_bytes: dbSize, schema_version: getVersion() };
}

function clearDeleted(table) {
  // Permanently remove soft-deleted records
  db.prepare(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL`).run();
}

// Run migrations on startup
runMigrations();

module.exports = {
  db,
  nextId,
  getAll,
  getAllRaw,
  findOne,
  insert,
  update,
  remove,
  hardDelete,
  audit,
  loadAgents,
  saveAgents,
  insertAgent,
  loadProjects,
  saveProjects,
  insertProject,
  loadTasks,
  saveTasks,
  insertTask,
  insertTaskBatch,
  updateTask,
  searchTasks,
  loadHeartbeats,
  saveHeartbeats,
  insertHeartbeat,
  loadTaskResults,
  saveTaskResults,
  insertTaskResult,
  vacuumDb,
  getDbStats,
  clearDeleted,
  rebuildFts,
};