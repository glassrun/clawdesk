'use strict';
/**
 * api.agents.test.js — agent CRUD + task-count logic
 * Run via Jest: npx jest tests/api.agents.test.js
 */

const { getDb, closeDb } = require('./helpers');

// ── test Express app (mirrors routes/agents.js logic) ─────────────────────────

function createTestApp(db) {
  const express = require('express');
  const cors = require('cors');

  const agentsRouter = express.Router();

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
    res.json({ agents: result });
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
    db.prepare('DELETE FROM tasks WHERE assigned_agent_id = ? AND deleted_at IS NULL').run(agent.id);
    db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
    res.json({ ok: true, soft_deleted: true });
  });

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  app.use('/api/agents', agentsRouter);
  return app;
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const bodyStr = body ? JSON.stringify(body) : '';
      const opts = {
        hostname: 'localhost', port, path, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      };
      const req = http.request(opts, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', e => { server.close(); reject(e); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

const http = require('http');

afterEach(() => closeDb(getDb()));

// ── GET /api/agents ───────────────────────────────────────────────────────────

describe('GET /api/agents', () => {
  test('empty array when no agents', async () => {
    const db = getDb();
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/agents');
    expect(status).toBe(200);
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.length).toBe(0);
  });

  test('returns all active agents', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(1, 'alice', 'Alice', 'active', new Date().toISOString());
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(2, 'bob', 'Bob', 'active', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/agents');
    expect(status).toBe(200);
    expect(body.agents.length).toBe(2);
    expect(body.agents[0].openclaw_agent_id).toBe('alice');
    expect(body.agents[1].openclaw_agent_id).toBe('bob');
  });

  test('filters by status query param', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(1, 'alice', 'Alice', 'active', new Date().toISOString());
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(2, 'bob', 'Bob', 'paused', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/agents?status=paused');
    expect(status).toBe(200);
    expect(body.agents.length).toBe(1);
    expect(body.agents[0].openclaw_agent_id).toBe('bob');
  });

  test('filters by search (name)', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(1, 'alice', 'Alice Smith', 'active', new Date().toISOString());
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(2, 'bob', 'Bob Jones', 'active', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/agents?search=alice');
    expect(status).toBe(200);
    expect(body.agents.length).toBe(1);
    expect(body.agents[0].name).toBe('Alice Smith');
  });

  test('filters by search (openclaw_agent_id)', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(1, 'alice-bot', 'Alice', 'active', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/agents?search=alice-bot');
    expect(status).toBe(200);
    expect(body.agents.length).toBe(1);
    expect(body.agents[0].openclaw_agent_id).toBe('alice-bot');
  });

  test('includes task counts', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(1, 'x', 'X', 'active', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(1, 1, 1, 'T1', 'pending', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(2, 1, 1, 'T2', 'in_progress', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/agents');
    expect(status).toBe(200);
    expect(body.agents[0].tasks_pending).toBe(1);
    expect(body.agents[0].tasks_in_progress).toBe(1);
    expect(body.agents[0].tasks_done).toBe(0);
    expect(body.agents[0].tasks_failed).toBe(0);
  });
});

// ── GET /api/agents/:id ───────────────────────────────────────────────────────

describe('GET /api/agents/:id', () => {
  test('200 when found', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(5, 'charlie', 'Charlie', 'active', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/agents/5');
    expect(status).toBe(200);
    expect(body.openclaw_agent_id).toBe('charlie');
  });

  test('404 when not found', async () => {
    const db = getDb();
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/agents/99999');
    expect(status).toBe(404);
    expect(body.error).toBe('not found');
  });
});

// ── PUT /api/agents/:id ───────────────────────────────────────────────────────

describe('PUT /api/agents/:id', () => {
  test('updates name', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(7, 'dave', 'Dave', 'active', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'PUT', '/api/agents/7', { name: 'David' });
    expect(status).toBe(200);
    expect(body.name).toBe('David');
  });

  test('updates status', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(7, 'dave', 'Dave', 'active', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'PUT', '/api/agents/7', { status: 'paused' });
    expect(status).toBe(200);
    expect(body.status).toBe('paused');
  });

  test('updates budget fields', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(7, 'dave', 'Dave', 'active', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'PUT', '/api/agents/7', { budget_limit: 500, budget_spent: 123 });
    expect(status).toBe(200);
    expect(body.budget_limit).toBe(500);
    expect(body.budget_spent).toBe(123);
  });

  test('preserves fields not in request', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,budget_limit,heartbeat_interval,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(7, 'dave', 'Dave', 'active', 100, 60, new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'PUT', '/api/agents/7', { name: 'David' });
    expect(status).toBe(200);
    expect(body.name).toBe('David');
    expect(body.status).toBe('active');
    expect(body.budget_limit).toBe(100);
    expect(body.heartbeat_interval).toBe(60);
  });

  test('404 for non-existent agent', async () => {
    const db = getDb();
    const app = createTestApp(db);
    const { status, body } = await request(app, 'PUT', '/api/agents/99999', { name: 'Ghost' });
    expect(status).toBe(404);
    expect(body.error).toBe('not found');
  });

  test('clamps heartbeat_interval to minimum 1', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(7, 'dave', 'Dave', 'active', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'PUT', '/api/agents/7', { heartbeat_interval: 0 });
    expect(status).toBe(200);
    expect(body.heartbeat_interval).toBe(1);
  });
});

// ── DELETE /api/agents/:id ────────────────────────────────────────────────────

describe('DELETE /api/agents/:id', () => {
  test('404 for non-existent agent', async () => {
    const db = getDb();
    const app = createTestApp(db);
    const { status, body } = await request(app, 'DELETE', '/api/agents/99999');
    expect(status).toBe(404);
    expect(body.error).toBe('not found');
  });

  test('hard-deletes agent with force=1', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(10, 'del', 'DeleteMe', 'active', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'DELETE', '/api/agents/10?force=1');
    const agentStillExists = db.prepare('SELECT * FROM agents WHERE id = 10').get() !== undefined;
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(agentStillExists).toBe(false);
  });

  test('cascade-deletes tasks assigned to agent', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(10, 'del', 'DeleteMe', 'active', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(1, 1, 10, 'Task A', 'pending', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(2, 1, 10, 'Task B', 'done', new Date().toISOString());
    const app = createTestApp(db);
    const { status } = await request(app, 'DELETE', '/api/agents/10?force=1');
    const remainingTasks = db.prepare('SELECT * FROM tasks WHERE assigned_agent_id = 10').all().length;
    expect(status).toBe(200);
    expect(remainingTasks).toBe(0);
  });

  test('400 when agent has active pending tasks (no force)', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(10, 'del', 'DeleteMe', 'active', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(3, 1, 10, 'Active Task', 'in_progress', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'DELETE', '/api/agents/10');
    expect(status).toBe(400);
    expect(body.error.includes('active pending tasks')).toBe(true);
  });

  test('allows delete with force=1 when agent has active tasks', async () => {
    const db = getDb();
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)').run(10, 'del', 'DeleteMe', 'active', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,created_at) VALUES (?,?,?,?,?,?)').run(4, 1, 10, 'Active Task', 'in_progress', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'DELETE', '/api/agents/10?force=1');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
