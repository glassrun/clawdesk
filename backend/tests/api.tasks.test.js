'use strict';
/**
 * api.tasks.test.js — standalone
 * Run: node tests/api.tasks.test.js
 */

const http = require('http');
const { getDb, closeDb, nextId } = require('./helpers');

// ── test Express app (inline, mirrors routes/tasks.js logic) ──────────────────

function createTestApp(db) {
  const express = require('express');
  const cors = require('cors');

  function normalizeTask(t, agents) {
    const a = agents?.find(x => x.id === t.assigned_agent_id);
    const creator = agents?.find(x => x.id === t.created_by_agent_id);
    return { ...t, priority: t.priority || 'medium', agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id, created_by_agent_slug: creator?.name || creator?.openclaw_agent_id || null };
  }

  const tasksRouter = require('express').Router();

  // GET /api/tasks/summary
  tasksRouter.get('/summary', (req, res) => {
    let tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    if (req.query.project_id) tasks = tasks.filter(t => String(t.project_id) === String(req.query.project_id));
    if (req.query.agent_id) tasks = tasks.filter(t => String(t.assigned_agent_id) === String(req.query.agent_id));
    const byStatus = {}; const byPriority = {}; const byProject = {}; const byAgent = {};
    let totalRetries = 0;
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      byPriority[t.priority || 'medium'] = (byPriority[t.priority || 'medium'] || 0) + 1;
      byProject[t.project_id] = (byProject[t.project_id] || 0) + 1;
      if (t.assigned_agent_id) byAgent[t.assigned_agent_id] = (byAgent[t.assigned_agent_id] || 0) + 1;
      if (t._retry_count) totalRetries += t._retry_count;
    }
    res.json({ total: tasks.length, by_status: byStatus, by_priority: byPriority, by_project: byProject, by_agent: byAgent, total_retries: totalRetries });
  });

  // POST /api/tasks/bulk
  tasksRouter.post('/bulk', (req, res) => {
    const { task_ids, status, priority, assigned_agent_id } = req.body;
    if (!Array.isArray(task_ids) || task_ids.length === 0) return res.status(400).json({ error: 'task_ids must be a non-empty array' });
    if (task_ids.length > 100) return res.status(400).json({ error: 'max 100 tasks per bulk update' });
    if (priority && !['low', 'medium', 'high'].includes(priority)) return res.status(400).json({ error: 'priority must be low, medium, or high' });
    const tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    const updated = [];
    for (const tid of task_ids) {
      const t = tasks.find(x => x.id === +tid);
      if (!t) continue;
      if (status) t.status = status;
      if (priority) t.priority = priority;
      if (assigned_agent_id !== undefined) t.assigned_agent_id = assigned_agent_id ? +assigned_agent_id : null;
      updated.push(t.id);
      // Persist
      const fields = [];
      const values = [];
      if (status) { fields.push('status = ?'); values.push(status); }
      if (priority) { fields.push('priority = ?'); values.push(priority); }
      if (assigned_agent_id !== undefined) { fields.push('assigned_agent_id = ?'); values.push(assigned_agent_id ? +assigned_agent_id : null); }
      if (fields.length > 0) {
        values.push(t.id);
        db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      }
    }
    res.json({ ok: true, updated: updated.length, task_ids: updated });
  });

  // GET /api/tasks
  tasksRouter.get('/', (req, res) => {
    const agents = db.prepare('SELECT * FROM agents').all();
    let tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    if (req.query.status) tasks = tasks.filter(t => t.status === req.query.status);
    if (req.query.agent_id) tasks = tasks.filter(t => String(t.assigned_agent_id) === String(req.query.agent_id));
    if (req.query.priority) tasks = tasks.filter(t => t.priority === req.query.priority);
    if (req.query.project_id) tasks = tasks.filter(t => String(t.project_id) === String(req.query.project_id));
    if (req.query.search) { const s = req.query.search.toLowerCase(); tasks = tasks.filter(t => t.title.toLowerCase().includes(s)); }
    const sortBy = req.query.sort_by || 'priority';
    const sortDir = req.query.sort_dir === 'desc' ? -1 : 1;
    const pri = { high: 0, medium: 1, low: 2 };
    const sortFns = {
      priority: (a, b) => ((pri[a.priority] ?? 1) - (pri[b.priority] ?? 1)) * sortDir,
      created_at: (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) * sortDir,
      title: (a, b) => a.title.localeCompare(b.title) * sortDir,
      status: (a, b) => a.status.localeCompare(b.status) * sortDir,
      id: (a, b) => (a.id - b.id) * sortDir
    };
    tasks.sort(sortFns[sortBy] || sortFns.priority);
    const page = Math.max(1, +(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, +(req.query.limit) || 50));
    const total = tasks.length;
    const offset = (page - 1) * limit;
    const paged = tasks.slice(offset, offset + limit);
    res.json({ data: paged.map(t => normalizeTask(t, agents)), total, page, limit, pages: Math.ceil(total / limit) });
  });

  // GET /api/tasks/:id
  tasksRouter.get('/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(+req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const agents = db.prepare('SELECT * FROM agents').all();
    res.json(normalizeTask(t, agents));
  });

  // POST /api/tasks/:id/notes
  tasksRouter.post('/:id/notes', (req, res) => {
    const { note, agent_id } = req.body;
    if (!note) return res.status(400).json({ error: 'note required' });
    const t = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(+req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const maxId = db.prepare('SELECT MAX(id) as m FROM task_results').get()?.m || 0;
    db.prepare('INSERT INTO task_results (id, task_id, agent_id, output, created_at) VALUES (?, ?, ?, ?, ?)').run(maxId + 1, t.id, agent_id || null, note, new Date().toISOString());
    res.json({ ok: true, task_id: t.id, note });
  });

  // GET /api/tasks/:id/dependents
  tasksRouter.get('/:id/dependents', (req, res) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(+req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    const agents = db.prepare('SELECT * FROM agents').all();
    const allTasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    const dependents = allTasks.filter(t => {
      if (String(t.dependency_id) === String(task.id)) return true;
      if (t.dependency_ids) {
        try { return JSON.parse(t.dependency_ids).includes(task.id); } catch {}
      }
      return false;
    }).map(t => {
      const a = agents.find(x => x.id === t.assigned_agent_id);
      return { id: t.id, title: t.title, status: t.status, priority: t.priority, agent_name: a?.name };
    });
    res.json({ task_id: task.id, task_title: task.title, blocked_by_this: dependents, count: dependents.length });
  });

  // GET /api/tasks/:id/chain
  tasksRouter.get('/:id/chain', (req, res) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(+req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    const allTasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    const chain = [];
    const visited = new Set();
    const collectChain = (depId) => {
      let current = depId;
      while (current && !visited.has(current)) {
        visited.add(current);
        const dep = allTasks.find(t => t.id === current);
        if (!dep) { chain.push({ id: current, title: '[deleted]', status: 'missing' }); return; }
        chain.push({ id: dep.id, title: dep.title, status: dep.status, priority: dep.priority });
        current = dep.dependency_id;
        if (dep.dependency_ids) {
          try {
            const multi = JSON.parse(dep.dependency_ids);
            for (const mid of multi) collectChain(mid);
          } catch {}
        }
      }
    };
    collectChain(task.dependency_id);
    res.json({ task_id: task.id, title: task.title, status: task.status, chain_length: chain.length, chain, blocked: chain.some(c => c.status !== 'done') });
  });

  const app = require('express')();
  app.use(cors({ origin: true, credentials: true }));
  app.use(require('express').json());
  app.use('/api/tasks', tasksRouter);
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

function assertEqual(a, b) {
  if (a !== b) throw new Error(`Expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`);
}

function assertTrue(a) {
  if (!a) throw new Error(`Expected truthy but got ${JSON.stringify(a)}`);
}

// ── tests ──────────────────────────────────────────────────────────────────────

const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

// GET /api/tasks
test('GET /api/tasks — empty array when no tasks', async () => {
  const db = getDb();
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(Array.isArray(body.data), true);
  assertEqual(body.data.length, 0);
});

test('GET /api/tasks — returns all tasks paginated', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'Test Project', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'Task One', 'pending', 'high', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'Task Two', 'done', 'low', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.data.length, 2);
  assertEqual(body.total, 2);
  assertEqual(body.page, 1);
});

test('GET /api/tasks — filters by status query param', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'T1', 'pending', 'medium', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'T2', 'done', 'medium', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks?status=done');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.data.length, 1);
  assertEqual(body.data[0].status, 'done');
});

test('GET /api/tasks — filters by priority', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'High', 'pending', 'high', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'Low', 'pending', 'low', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks?priority=high');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.data.length, 1);
  assertEqual(body.data[0].priority, 'high');
});

test('GET /api/tasks — filters by project_id', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P1', new Date().toISOString());
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(2, 'P2', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'In P1', 'pending', 'medium', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 2, 'In P2', 'pending', 'medium', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks?project_id=1');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.data.length, 1);
  assertEqual(body.data[0].title, 'In P1');
});

test('GET /api/tasks — filters by search', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'Fix login bug', 'pending', 'high', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'Add dashboard', 'pending', 'medium', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks?search=login');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.data.length, 1);
  assertEqual(body.data[0].title, 'Fix login bug');
});

test('GET /api/tasks — paginates correctly', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
  for (let i = 1; i <= 5; i++) {
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(i, 1, `Task ${i}`, 'pending', 'medium', new Date().toISOString());
  }
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks?page=1&limit=2');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.data.length, 2);
  assertEqual(body.total, 5);
  assertEqual(body.page, 1);
  assertEqual(body.pages, 3);
});

test('GET /api/tasks — sorts by priority (default)', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'Low', 'pending', 'low', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'High', 'pending', 'high', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.data[0].title, 'High'); // high priority comes first
  assertEqual(body.data[1].title, 'Low');
});

test('GET /api/tasks — sorts by created_at desc', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'Older', 'pending', 'medium', '2024-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'Newer', 'pending', 'medium', '2024-01-02T00:00:00.000Z');
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks?sort_by=created_at&sort_dir=desc');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.data[0].title, 'Newer');
});

// POST /api/tasks/bulk
test('POST /api/tasks/bulk — bulk status update', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'T1', 'pending', 'medium', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'T2', 'pending', 'medium', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'POST', '/api/tasks/bulk', { task_ids: [1, 2], status: 'done' });
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.ok, true);
  assertEqual(body.updated, 2);
  const t1 = db.prepare('SELECT status FROM tasks WHERE id = 1').get();
  assertEqual(t1.status, 'done');
});

test('POST /api/tasks/bulk — validates max 100', async () => {
  const db = getDb();
  const app = createTestApp(db);
  const { status, body } = await request(app, 'POST', '/api/tasks/bulk', { task_ids: Array.from({ length: 101 }, (_, i) => i + 1), status: 'done' });
  closeDb(db);
  assertEqual(status, 400);
  assertEqual(body.error, 'max 100 tasks per bulk update');
});

test('POST /api/tasks/bulk — validates priority', async () => {
  const db = getDb();
  const app = createTestApp(db);
  const { status, body } = await request(app, 'POST', '/api/tasks/bulk', { task_ids: [1], priority: 'invalid' });
  closeDb(db);
  assertEqual(status, 400);
  assertEqual(body.error, 'priority must be low, medium, or high');
});

test('POST /api/tasks/bulk — rejects empty task_ids', async () => {
  const db = getDb();
  const app = createTestApp(db);
  const { status, body } = await request(app, 'POST', '/api/tasks/bulk', { task_ids: [] });
  closeDb(db);
  assertEqual(status, 400);
  assertEqual(body.error, 'task_ids must be a non-empty array');
});

// GET /api/tasks/summary
test('GET /api/tasks/summary — returns aggregate counts', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'T1', 'pending', 'high', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'T2', 'done', 'medium', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(3, 1, 'T3', 'failed', 'low', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks/summary');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.total, 3);
  assertEqual(body.by_status.pending, 1);
  assertEqual(body.by_status.done, 1);
  assertEqual(body.by_status.failed, 1);
  assertEqual(body.by_priority.high, 1);
  assertEqual(body.by_priority.medium, 1);
  assertEqual(body.by_priority.low, 1);
});

// POST /api/tasks/:id/notes
test('POST /api/tasks/:id/notes — appends a note', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'T1', 'pending', 'medium', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'POST', '/api/tasks/1/notes', { note: 'This is a test note', agent_id: null });
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.ok, true);
  assertEqual(body.note, 'This is a test note');
});

test('POST /api/tasks/:id/notes — 400 when note missing', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'T1', 'pending', 'medium', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'POST', '/api/tasks/1/notes', {});
  closeDb(db);
  assertEqual(status, 400);
  assertEqual(body.error, 'note required');
});

test('POST /api/tasks/:id/notes — 404 for non-existent task', async () => {
  const db = getDb();
  const app = createTestApp(db);
  const { status, body } = await request(app, 'POST', '/api/tasks/99999/notes', { note: 'x' });
  closeDb(db);
  assertEqual(status, 404);
  assertEqual(body.error, 'not found');
});

// GET /api/tasks/:id/dependents
test('GET /api/tasks/:id/dependents — returns tasks blocked by this one', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'Parent', 'pending', 'high', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, dependency_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(2, 1, 'Child', 'pending', 'medium', 1, new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks/1/dependents');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.count, 1);
  assertEqual(body.blocked_by_this[0].title, 'Child');
});

test('GET /api/tasks/:id/dependents — 404 for non-existent task', async () => {
  const db = getDb();
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks/99999/dependents');
  closeDb(db);
  assertEqual(status, 404);
});

// GET /api/tasks/:id/chain
test('GET /api/tasks/:id/chain — returns dependency chain', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'Root', 'pending', 'high', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, dependency_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(2, 1, 'Dep1', 'pending', 'medium', 1, new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, dependency_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(3, 1, 'Dep2', 'done', 'low', 2, new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks/3/chain');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.chain_length, 2);
  // Chain walks from immediate dependency upward: task3(dep=2) -> Dep1(dep=1) -> Root(dep=null) = [Dep1, Root]
  assertEqual(body.chain[0].title, 'Dep1');
  assertEqual(body.chain[1].title, 'Root');
  assertTrue(body.blocked); // Root is not done
});

test('GET /api/tasks/:id/chain — empty chain when no dependency', async () => {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'No Dep', 'pending', 'medium', new Date().toISOString());
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks/1/chain');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.chain_length, 0);
  assertEqual(body.blocked, false);
});

test('GET /api/tasks/:id/chain — 404 for non-existent task', async () => {
  const db = getDb();
  const app = createTestApp(db);
  const { status, body } = await request(app, 'GET', '/api/tasks/99999/chain');
  closeDb(db);
  assertEqual(status, 404);
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