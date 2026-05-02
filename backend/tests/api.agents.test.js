'use strict';
/**
 * api.agents.test.js — standalone
 * Run: node tests/api.agents.test.js
 */

const http = require('http');
const { getDb, closeDb, makeAgent } = require('./helpers');

// ── test Express app (inline, mirrors routes/agents.js logic) ──────────────────

function createTestApp(db) {
  const express = require('express');
  const cors = require('cors');

  // Require fresh instances so each test gets a clean module state
  const agentsRouter = require('express').Router();

  agentsRouter.get('/', (req, res) => {
    let agents = db.prepare('SELECT * FROM agents').all();
    const tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    if (req.query.status) agents = agents.filter(a => a.status === req.query.status);
    if (req.query.search) {
      const s = req.query.search.toLowerCase();
      agents = agents.filter(a => a.name.toLowerCase().includes(s) || a.openclaw_agent_id.toLowerCase().includes(s));
    }
    if (!req.query.status) agents = agents.filter(x => x.status === 'active');
    const taskCounts = {};
    for (const t of tasks) {
      if (!taskCounts[t.assigned_agent_id]) taskCounts[t.assigned_agent_id] = { pending: 0, in_progress: 0, done: 0, failed: 0 };
      if (t.status === 'pending') taskCounts[t.assigned_agent_id].pending++;
      else if (t.status === 'in_progress') taskCounts[t.assigned_agent_id].in_progress++;
      else if (t.status === 'done') taskCounts[t.assigned_agent_id].done++;
      else if (t.status === 'failed') taskCounts[t.assigned_agent_id].failed++;
    }
    const result = agents.map(a => ({
      ...a,
      tasks_pending: taskCounts[a.id]?.pending || 0,
      tasks_in_progress: taskCounts[a.id]?.in_progress || 0,
      tasks_done: taskCounts[a.id]?.done || 0,
      tasks_failed: taskCounts[a.id]?.failed || 0,
    }));
    res.json(result);
  });

  agentsRouter.get('/:id', (req, res) => {
    const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(+req.params.id);
    a ? res.json(a) : res.status(404).json({ error: 'not found' });
  });

  agentsRouter.put('/:id', (req, res) => {
    const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(+req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    const { name, status, budget_limit, budget_spent, heartbeat_enabled, heartbeat_interval } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (status !== undefined) updates.status = status;
    if (budget_limit !== undefined) updates.budget_limit = budget_limit;
    if (budget_spent !== undefined) updates.budget_spent = budget_spent;
    if (heartbeat_enabled !== undefined) updates.heartbeat_enabled = heartbeat_enabled ? 1 : 0;
    if (heartbeat_interval !== undefined) updates.heartbeat_interval = Math.max(1, +heartbeat_interval);
    const keys = Object.keys(updates);
    if (keys.length > 0) {
      const set = keys.map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE agents SET ${set} WHERE id = ?`).run(...keys.map(k => updates[k]), +req.params.id);
    }
    const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(+req.params.id);
    res.json(updated);
  });

  agentsRouter.delete('/:id', (req, res) => {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(+req.params.id);
    if (!agent) return res.status(404).json({ error: 'not found' });
    const tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    const agentTasks = tasks.filter(t => t.assigned_agent_id === agent.id && t.status !== 'done');
    if (agentTasks.length > 0 && req.query.force !== '1') {
      return res.status(400).json({ error: 'agent has active pending tasks', pending_tasks: agentTasks.length, hint: 'add ?force=1 to delete anyway' });
    }
    db.prepare('DELETE FROM tasks WHERE assigned_agent_id = ?').run(agent.id);
    db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
    res.json({ ok: true, soft_deleted: true });
  });

  const app = require('express')();
  app.use(cors({ origin: true, credentials: true }));
  app.use(require('express').json());
  app.use('/api/agents', agentsRouter);
  return app;
}

// ── tiny HTTP client ──────────────────────────────────────────────────────────

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const bodyStr = body ? JSON.stringify(body) : '';
      const opts = {
        hostname: 'localhost', port, path, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      };
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

// ── test helpers ────────────────────────────────────────────────────────────────

function assertEqual(a, b) {
  if (a !== b) throw new Error(`Expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`);
}

// ── tests ──────────────────────────────────────────────────────────────────────

const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

// GET /api/agents
test('GET /api/agents — empty array when no agents', async () => {
  const db = getDb();
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/agents');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(Array.isArray(body), true);
  assertEqual(body.length, 0);
});

test('GET /api/agents — returns all agents', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(1, 'alice', 'Alice', 'active', new Date().toISOString());
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(2, 'bob', 'Bob', 'active', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/agents');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.length, 2);
  assertEqual(body[0].openclaw_agent_id, 'alice');
  assertEqual(body[1].openclaw_agent_id, 'bob');
});

test('GET /api/agents — filters by status query param', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(1, 'alice', 'Alice', 'active', new Date().toISOString());
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(2, 'bob', 'Bob', 'paused', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/agents?status=paused');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.length, 1);
  assertEqual(body[0].openclaw_agent_id, 'bob');
});

test('GET /api/agents — filters by search (name)', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(1, 'alice', 'Alice Smith', 'active', new Date().toISOString());
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(2, 'bob', 'Bob Jones', 'active', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/agents?search=alice');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.length, 1);
  assertEqual(body[0].name, 'Alice Smith');
});

test('GET /api/agents — filters by search (openclaw_agent_id)', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(1, 'alice-bot', 'Alice', 'active', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/agents?search=alice-bot');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.length, 1);
  assertEqual(body[0].openclaw_agent_id, 'alice-bot');
});

test('GET /api/agents — includes task counts', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(1, 'x', 'X', 'active', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(1, 1, 1, 'T1', 'pending', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(2, 1, 1, 'T2', 'in_progress', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/agents');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body[0].tasks_pending, 1);
  assertEqual(body[0].tasks_in_progress, 1);
  assertEqual(body[0].tasks_done, 0);
  assertEqual(body[0].tasks_failed, 0);
});

// GET /api/agents/:id
test('GET /api/agents/:id — 200 when found', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(5, 'charlie', 'Charlie', 'active', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/agents/5');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.openclaw_agent_id, 'charlie');
});

test('GET /api/agents/:id — 404 when not found', async () => {
  const db = getDb();
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/agents/99999');
  closeDb(db);
  assertEqual(status, 404);
  assertEqual(body.error, 'not found');
});

// PUT /api/agents/:id
test('PUT /api/agents/:id — updates name', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(7, 'dave', 'Dave', 'active', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'PUT', '/api/agents/7', { name: 'David' });
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.name, 'David');
});

test('PUT /api/agents/:id — updates status', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(7, 'dave', 'Dave', 'active', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'PUT', '/api/agents/7', { status: 'paused' });
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.status, 'paused');
});

test('PUT /api/agents/:id — updates budget fields', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(7, 'dave', 'Dave', 'active', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'PUT', '/api/agents/7', { budget_limit: 500, budget_spent: 123 });
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.budget_limit, 500);
  assertEqual(body.budget_spent, 123);
});

test('PUT /api/agents/:id — preserves fields not in request', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,budget_limit,heartbeat_interval,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(7, 'dave', 'Dave', 'active', 100, 60, new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'PUT', '/api/agents/7', { name: 'David' });
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.name, 'David');
  assertEqual(body.status, 'active');
  assertEqual(body.budget_limit, 100);
  assertEqual(body.heartbeat_interval, 60);
});

test('PUT /api/agents/:id — 404 for non-existent agent', async () => {
  const db = getDb();
  const app = createTestApp(db);
  const { status, body } = await request(app, 'PUT', '/api/agents/99999', { name: 'Ghost' });
  closeDb(db);
  assertEqual(status, 404);
  assertEqual(body.error, 'not found');
});

test('PUT /api/agents/:id — clamps heartbeat_interval to minimum 1', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(7, 'dave', 'Dave', 'active', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'PUT', '/api/agents/7', { heartbeat_interval: 0 });
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.heartbeat_interval, 1);
});

// DELETE /api/agents/:id
test('DELETE /api/agents/:id — 404 for non-existent agent', async () => {
  const db = getDb();
  const app = createTestApp(db);
  const { status, body } = await request(app, 'DELETE', '/api/agents/99999');
  closeDb(db);
  assertEqual(status, 404);
  assertEqual(body.error, 'not found');
});

test('DELETE /api/agents/:id — hard-deletes agent with force=1', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(10, 'del', 'DeleteMe', 'active', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'DELETE', '/api/agents/10?force=1');
  const agentStillExists = db.prepare('SELECT * FROM agents WHERE id = 10').get() !== undefined;
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.ok, true);
  assertEqual(agentStillExists, false);
});

test('DELETE /api/agents/:id — cascade-deletes tasks assigned to agent', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(10, 'del', 'DeleteMe', 'active', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(1, 1, 10, 'Task A', 'pending', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(2, 1, 10, 'Task B', 'done', new Date().toISOString());
  const app = createTestApp(db);
  const { status } = await request(app, 'DELETE', '/api/agents/10?force=1');
  const remainingTasks = db.prepare('SELECT * FROM tasks WHERE assigned_agent_id = 10').all().length;
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(remainingTasks, 0);
});

test('DELETE /api/agents/:id — 400 when agent has active pending tasks (no force)', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(10, 'del', 'DeleteMe', 'active', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(3, 1, 10, 'Active Task', 'in_progress', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'DELETE', '/api/agents/10');
  closeDb(db);
  assertEqual(status, 400);
  assertEqual(body.error.includes('active pending tasks'), true);
});

test('DELETE /api/agents/:id — allows delete with force=1 when agent has active tasks', async () => {
  const db = getDb();
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(10, 'del', 'DeleteMe', 'active', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(4, 1, 10, 'Active Task', 'in_progress', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'DELETE', '/api/agents/10?force=1');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.ok, true);
});

// ── runner ──────────────────────────────────────────────────────────────────────

async function run() {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();