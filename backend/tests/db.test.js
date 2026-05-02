'use strict';
/**
 * db.test.js — standalone
 * Run: node tests/db.test.js
 */

const { getDb, closeDb, nextId, makeAgent } = require('./helpers');

// ── db helpers (mirror production db.js) ─────────────────────────────────────

function loadAgents(db) { return db.prepare('SELECT * FROM agents').all(); }

function saveAgents(db, data) {
  db.exec('DELETE FROM agents');
  const ins = db.prepare(`INSERT INTO agents (id,openclaw_agent_id,name,status,budget_limit,budget_spent,heartbeat_enabled,heartbeat_interval,last_heartbeat,tasks_done,tasks_failed,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const a of data) {
    ins.run(a.id, a.openclaw_agent_id, a.name, a.status, a.budget_limit, a.budget_spent,
      a.heartbeat_enabled, a.heartbeat_interval, a.last_heartbeat, a.tasks_done, a.tasks_failed, a.created_at);
  }
}

function saveAgentsIdempotent(db, data) {
  db.exec('DELETE FROM agents');
  const ins = db.prepare(`INSERT OR REPLACE INTO agents (id,openclaw_agent_id,name,status,budget_limit,budget_spent,heartbeat_enabled,heartbeat_interval,last_heartbeat,tasks_done,tasks_failed,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const a of data) {
    ins.run(a.id, a.openclaw_agent_id, a.name, a.status, a.budget_limit, a.budget_spent,
      a.heartbeat_enabled, a.heartbeat_interval, a.last_heartbeat, a.tasks_done, a.tasks_failed, a.created_at);
  }
}

function hardDelete(db, table, query) {
  const keys = Object.keys(query);
  const where = keys.map(k => `${k} = ?`).join(' AND ');
  db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...keys.map(k => query[k]));
}

function remove(db, table, query) {
  const keys = Object.keys(query);
  const where = keys.map(k => `${k} = ?`).join(' AND ');
  const vals = keys.map(k => query[k]);
  db.prepare(`UPDATE ${table} SET deleted_at = datetime('now') WHERE ${where}`).run(...vals);
}

function loadTasks(db) { return db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all(); }

// ── test helpers ────────────────────────────────────────────────────────────────

function assertEqual(a, b) {
  if (a !== b) throw new Error(`Expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`);
}

// ── tests ──────────────────────────────────────────────────────────────────────

const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

// nextId
test('nextId returns 1 for empty table', (db) => {
  assertEqual(nextId(db, 'agents'), 1);
});

test('nextId increments from existing max id', (db) => {
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,created_at) VALUES (?,?,?,?)').run(42, 'x', 'x', new Date().toISOString());
  assertEqual(nextId(db, 'agents'), 43);
});

test('nextId counts only real rows', (db) => {
  db.prepare('INSERT INTO projects (id,title,created_at,deleted_at) VALUES (?,?,?,?)').run(5, 'p', '2025-01-01', '2025-01-01');
  assertEqual(nextId(db, 'projects'), 6);
});

// saveAgents / loadAgents
test('saveAgents and loadAgents roundtrip', (db) => {
  const agents = [makeAgent({ id: 1 }), makeAgent({ id: 2, openclaw_agent_id: 'bob', name: 'Bob' })];
  saveAgents(db, agents);
  const loaded = loadAgents(db);
  assertEqual(loaded.length, 2);
  assertEqual(loaded[0].openclaw_agent_id, 'test-1');
  assertEqual(loaded[1].openclaw_agent_id, 'bob');
});

test('saveAgents replaces all agents', (db) => {
  saveAgents(db, [makeAgent({ id: 1, openclaw_agent_id: 'x', name: 'X' })]);
  saveAgents(db, [makeAgent({ id: 2, openclaw_agent_id: 'y', name: 'Y' })]);
  const loaded = loadAgents(db);
  assertEqual(loaded.length, 1);
  assertEqual(loaded[0].openclaw_agent_id, 'y');
});

test('saveAgentsIdempotent replaces on id conflict', (db) => {
  saveAgents(db, [makeAgent({ id: 1, name: 'Original', budget_spent: 0 })]);
  saveAgentsIdempotent(db, [makeAgent({ id: 1, name: 'Updated', budget_spent: 99 })]);
  const loaded = loadAgents(db);
  assertEqual(loaded.length, 1);
  assertEqual(loaded[0].name, 'Updated');
  assertEqual(loaded[0].budget_spent, 99);
});

// hardDelete
test('hardDelete removes row by id', (db) => {
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,created_at) VALUES (?,?,?,?)').run(10, 'del', 'Del', new Date().toISOString());
  hardDelete(db, 'agents', { id: 10 });
  assertEqual(db.prepare('SELECT * FROM agents WHERE id = 10').get(), undefined);
});

test('hardDelete removes only matching rows', (db) => {
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,created_at) VALUES (?,?,?,?)').run(1, 'a', 'A', new Date().toISOString());
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,created_at) VALUES (?,?,?,?)').run(2, 'b', 'B', new Date().toISOString());
  hardDelete(db, 'agents', { id: 1 });
  const remaining = loadAgents(db);
  assertEqual(remaining.length, 1);
  assertEqual(remaining[0].openclaw_agent_id, 'b');
});

test('hardDelete cascade-removes tasks assigned to agent', (db) => {
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,created_at) VALUES (?,?,?,?)').run(1, 'c', 'C', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(1, 1, 1, 'T1', 'pending', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(2, 1, 1, 'T2', 'done', new Date().toISOString());
  hardDelete(db, 'tasks', { assigned_agent_id: 1 });
  assertEqual(loadTasks(db).length, 0);
});

// remove (soft delete — uses projects table since agents has no deleted_at col)
test('remove sets deleted_at on matching rows', (db) => {
  db.prepare('INSERT INTO projects (id,title,created_at) VALUES (?,?,?)').run(1, 'proj', new Date().toISOString());
  remove(db, 'projects', { id: 1 });
  const row = db.prepare('SELECT * FROM projects WHERE id = 1').get();
  assertEqual(!!row.deleted_at, true);
});

test('remove does NOT hard-delete — row remains in table', (db) => {
  db.prepare('INSERT INTO projects (id,title,created_at) VALUES (?,?,?)').run(1, 'proj', new Date().toISOString());
  remove(db, 'projects', { id: 1 });
  const row = db.prepare('SELECT * FROM projects WHERE id = 1').get();
  assertEqual(row.title, 'proj');
});

// ── runner ──────────────────────────────────────────────────────────────────────

async function run() {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    let db;
    try {
      db = getDb();
      await fn(db);
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
      failed++;
    } finally {
      closeDb(db);
    }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();