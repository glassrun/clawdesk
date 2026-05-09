'use strict';
/**
 * api.tasks.test.js
 * Run via Jest: npx jest tests/api.tasks.test.js
 * Or standalone: node tests/api.tasks.test.js
 */

const http = require('http');
const { getDb, closeDb } = require('./helpers');

// ── test app (mirrors routes/tasks.js logic inline) ────────────────────────────

function createTestApp(db) {
  const express = require('express');
  const app = express();
  app.use(express.json());

  const tasksRouter = express.Router();

  function normalizeTask(t, agents) {
    const a = agents?.find(x => x.id === t.assigned_agent_id);
    const creator = agents?.find(x => x.id === t.created_by_agent_id);
    return {
      ...t,
      priority: t.priority || 'medium',
      agent_name: a?.name,
      openclaw_agent_id: a?.openclaw_agent_id,
      created_by_agent_slug: creator?.name || creator?.openclaw_agent_id || null,
    };
  }

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
    const allTasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    const updated = [];
    for (const tid of task_ids) {
      const t = allTasks.find(x => x.id === +tid);
      if (!t) continue;
      if (status) t.status = status;
      if (priority) t.priority = priority;
      if (assigned_agent_id !== undefined) t.assigned_agent_id = assigned_agent_id ? +assigned_agent_id : null;
      updated.push(t.id);
      const fields = []; const values = [];
      if (status) { fields.push('status = ?'); values.push(status); }
      if (priority) { fields.push('priority = ?'); values.push(priority); }
      if (assigned_agent_id !== undefined) { fields.push('assigned_agent_id = ?'); values.push(assigned_agent_id ? +assigned_agent_id : null); }
      if (fields.length > 0) { values.push(t.id); db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values); }
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
      title: (a, b) => (a.title || '').localeCompare(b.title || '') * sortDir,
      status: (a, b) => (a.status || '').localeCompare(b.status || '') * sortDir,
      id: (a, b) => (a.id - b.id) * sortDir,
    };
    tasks.sort(sortFns[sortBy] || sortFns.priority);
    const page = Math.max(1, +(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, +(req.query.limit) || 50));
    const total = tasks.length;
    const offset = (page - 1) * limit;
    res.json({ data: tasks.slice(offset, offset + limit).map(t => normalizeTask(t, agents)), total, page, limit, pages: Math.ceil(total / limit) });
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
    const { note } = req.body;
    if (!note) return res.status(400).json({ error: 'note required' });
    const t = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(+req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const maxId = db.prepare('SELECT MAX(id) as m FROM task_results').get()?.m || 0;
    db.prepare('INSERT INTO task_results (id, task_id, output, executed_at) VALUES (?, ?, ?, ?)').run(maxId + 1, t.id, note, new Date().toISOString());
    res.json({ ok: true, task_id: t.id, note });
  });

  // GET /api/tasks/:id/dependents
  tasksRouter.get('/:id/dependents', (req, res) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL').get(+req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    const agents = db.prepare('SELECT * FROM agents').all();
    const allTasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    const dependents = allTasks.filter(t => {
      if (t.dependency_ids) {
        try { return JSON.parse(t.dependency_ids).includes(task.id); } catch { return false; }
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
      while (depId && !visited.has(depId)) {
        visited.add(depId);
        const dep = allTasks.find(t => t.id === depId);
        if (!dep) { chain.push({ id: depId, title: '[deleted]', status: 'missing' }); return; }
        chain.push({ id: dep.id, title: dep.title, status: dep.status, priority: dep.priority });
        const deps = dep.dependency_ids ? JSON.parse(dep.dependency_ids) : [];
        if (deps.length) { depId = deps[0]; deps.slice(1).forEach(mid => collectChain(mid)); }
        else return;
      }
    };
    const deps = task.dependency_ids ? JSON.parse(task.dependency_ids) : [];
    if (deps.length) { collectChain(deps[0]); deps.slice(1).forEach(mid => collectChain(mid)); }
    res.json({ task_id: task.id, title: task.title, status: task.status, chain_length: chain.length, chain, blocked: chain.some(c => c.status !== 'done') });
  });

  app.use('/api/tasks', tasksRouter);
  return app;
}

// ── HTTP client with proper server cleanup ─────────────────────────────────────

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
          server.close(() => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        });
      });
      req.on('error', e => { server.close(); reject(e); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

const assertEqual = (a, b) => { if (a !== b) throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const assertTrue = a => { if (!a) throw new Error(`Expected truthy, got ${JSON.stringify(a)}`); };

// ── tests ──────────────────────────────────────────────────────────────────────

describe('GET /api/tasks', () => {
  test('empty array when no tasks', async () => {
    const db = getDb();
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/tasks');
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(0);
    closeDb(db);
  });

  test('returns all tasks paginated', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'Test Project', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'Task One', 'pending', 'high', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'Task Two', 'done', 'low', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/tasks');
    expect(status).toBe(200);
    expect(body.data.length).toBe(2);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    closeDb(db);
  });

  test('filters by status query param', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'T1', 'pending', 'medium', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'T2', 'done', 'medium', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/tasks?status=done');
    expect(status).toBe(200);
    expect(body.data.length).toBe(1);
    expect(body.data[0].status).toBe('done');
    closeDb(db);
  });

  test('filters by priority', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'High', 'pending', 'high', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'Low', 'pending', 'low', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/tasks?priority=high');
    expect(status).toBe(200);
    expect(body.data.length).toBe(1);
    expect(body.data[0].priority).toBe('high');
    closeDb(db);
  });

  test('filters by project_id', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P1', new Date().toISOString());
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(2, 'P2', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'In P1', 'pending', 'medium', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 2, 'In P2', 'pending', 'medium', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/tasks?project_id=1');
    expect(status).toBe(200);
    expect(body.data.length).toBe(1);
    expect(body.data[0].title).toBe('In P1');
    closeDb(db);
  });

  test('filters by search', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'Fix login bug', 'pending', 'high', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'Add dashboard', 'pending', 'medium', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/tasks?search=login');
    expect(status).toBe(200);
    expect(body.data.length).toBe(1);
    expect(body.data[0].title).toBe('Fix login bug');
    closeDb(db);
  });

  test('paginates correctly', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
    for (let i = 1; i <= 5; i++) db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(i, 1, `Task ${i}`, 'pending', 'medium', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/tasks?page=1&limit=2');
    expect(status).toBe(200);
    expect(body.data.length).toBe(2);
    expect(body.total).toBe(5);
    expect(body.pages).toBe(3);
    closeDb(db);
  });

  test('sorts by priority (default)', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'Low', 'pending', 'low', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'High', 'pending', 'high', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/tasks');
    expect(status).toBe(200);
    expect(body.data[0].title).toBe('High');
    expect(body.data[1].title).toBe('Low');
    closeDb(db);
  });

  test('sorts by created_at desc', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'Older', 'pending', 'medium', '2024-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'Newer', 'pending', 'medium', '2024-01-02T00:00:00.000Z');
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/tasks?sort_by=created_at&sort_dir=desc');
    expect(status).toBe(200);
    expect(body.data[0].title).toBe('Newer');
    closeDb(db);
  });
});

describe('POST /api/tasks/bulk', () => {
  test('bulk status update', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'T1', 'pending', 'medium', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'T2', 'pending', 'medium', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'POST', '/api/tasks/bulk', { task_ids: [1, 2], status: 'done' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(2);
    expect(db.prepare('SELECT status FROM tasks WHERE id = 1').get().status).toBe('done');
    closeDb(db);
  });

  test('validates max 100', async () => {
    const db = getDb();
    const app = createTestApp(db);
    const { status, body } = await request(app, 'POST', '/api/tasks/bulk', { task_ids: Array.from({ length: 101 }, (_, i) => i + 1), status: 'done' });
    expect(status).toBe(400);
    expect(body.error).toBe('max 100 tasks per bulk update');
    closeDb(db);
  });

  test('validates priority', async () => {
    const db = getDb();
    const app = createTestApp(db);
    const { status, body } = await request(app, 'POST', '/api/tasks/bulk', { task_ids: [1], priority: 'invalid' });
    expect(status).toBe(400);
    expect(body.error).toBe('priority must be low, medium, or high');
    closeDb(db);
  });

  test('rejects empty task_ids', async () => {
    const db = getDb();
    const app = createTestApp(db);
    const { status, body } = await request(app, 'POST', '/api/tasks/bulk', { task_ids: [] });
    expect(status).toBe(400);
    expect(body.error).toBe('task_ids must be a non-empty array');
    closeDb(db);
  });
});

describe('GET /api/tasks/summary', () => {
  test('returns aggregate counts', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'T1', 'pending', 'high', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(2, 1, 'T2', 'done', 'medium', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(3, 1, 'T3', 'failed', 'low', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/tasks/summary');
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.by_status.pending).toBe(1);
    expect(body.by_status.done).toBe(1);
    expect(body.by_status.failed).toBe(1);
    expect(body.by_priority.high).toBe(1);
    closeDb(db);
  });
});

describe('POST /api/tasks/:id/notes', () => {
  test('appends a note', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'T1', 'pending', 'medium', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'POST', '/api/tasks/1/notes', { note: 'This is a test note' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.note).toBe('This is a test note');
    closeDb(db);
  });

  test('400 when note missing', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'T1', 'pending', 'medium', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'POST', '/api/tasks/1/notes', {});
    expect(status).toBe(400);
    expect(body.error).toBe('note required');
    closeDb(db);
  });

  test('404 for non-existent task', async () => {
    const db = getDb();
    const app = createTestApp(db);
    const { status, body } = await request(app, 'POST', '/api/tasks/99999/notes', { note: 'x' });
    expect(status).toBe(404);
    expect(body.error).toBe('not found');
    closeDb(db);
  });
});

describe('GET /api/tasks/:id/dependents', () => {
  test('returns tasks blocked by this one', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'Parent', 'pending', 'high', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, dependency_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(2, 1, 'Child', 'pending', 'medium', '[1]', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/tasks/1/dependents');
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.blocked_by_this[0].title).toBe('Child');
    closeDb(db);
  });

  test('404 for non-existent task', async () => {
    const db = getDb();
    const app = createTestApp(db);
    const { status } = await request(app, 'GET', '/api/tasks/99999/dependents');
    expect(status).toBe(404);
    closeDb(db);
  });
});

describe('GET /api/tasks/:id/chain', () => {
  test('returns dependency chain', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'Root', 'pending', 'high', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, dependency_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(2, 1, 'Dep1', 'pending', 'medium', '[1]', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, dependency_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(3, 1, 'Dep2', 'done', 'low', '[2]', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/tasks/3/chain');
    expect(status).toBe(200);
    expect(body.chain_length).toBe(2);
    expect(body.chain[0].title).toBe('Dep1');
    expect(body.chain[1].title).toBe('Root');
    expect(body.blocked).toBe(true);
    closeDb(db);
  });

  test('empty chain when no dependency', async () => {
    const db = getDb();
    db.prepare('INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)').run(1, 'P', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'No Dep', 'pending', 'medium', new Date().toISOString());
    const app = createTestApp(db);
    const { status, body } = await request(app, 'GET', '/api/tasks/1/chain');
    expect(status).toBe(200);
    expect(body.chain_length).toBe(0);
    expect(body.blocked).toBe(false);
    closeDb(db);
  });

  test('404 for non-existent task', async () => {
    const db = getDb();
    const app = createTestApp(db);
    const { status } = await request(app, 'GET', '/api/tasks/99999/chain');
    expect(status).toBe(404);
    closeDb(db);
  });
});
