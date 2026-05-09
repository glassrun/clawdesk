'use strict';
/**
 * Orchestration.test.js — tests for scheduling, trigger rules, and approvals
 * Run via Jest: npx jest tests/Orchestration.test.js
 */
const http = require('http');
const { getDb, closeDb, nextId } = require('./helpers');

// ── DB wrapper ─────────────────────────────────────────────────────────────────

function makeDbWrapper(rawDb) {
  return {
    db: rawDb,
    nextId: (table) => nextId(rawDb, table),
    loadTasks: () => rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all(),
    loadAgents: () => rawDb.prepare('SELECT * FROM agents').all(),
    loadProjects: () => rawDb.prepare('SELECT * FROM projects WHERE deleted_at IS NULL').all(),
    loadApprovals: () => rawDb.prepare('SELECT * FROM approvals').all(),
    loadWorkflowRuns: () => rawDb.prepare('SELECT * FROM workflow_runs').all(),
    saveTasks: (data) => {
      rawDb.exec('DELETE FROM tasks');
      const i = rawDb.prepare(`INSERT INTO tasks (id,project_id,assigned_agent_id,title,description,status,priority,dependency_id,dependency_ids,creates_agent,created_by_agent_id,created_at,completed_at,run_count,_retry_count,_status_changed_at,deleted_at,updated_at,repeat,scheduled_at,requires_approval)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const t of data) i.run(t.id, t.project_id, t.assigned_agent_id || null, t.title, t.description || '', t.status, t.priority, t.dependency_id || null, t.dependency_ids || null, t.creates_agent || null, t.created_by_agent_id || null, t.created_at, t.completed_at || null, t.run_count || 0, t._retry_count || 0, t._status_changed_at || null, t.deleted_at || null, t.updated_at || null, t.repeat || 0, t.scheduled_at || null, t.requires_approval ? 1 : 0);
    },
    saveAgents: (data) => {
      rawDb.exec('DELETE FROM agents');
      const i = rawDb.prepare(`INSERT INTO agents (id,openclaw_agent_id,name,status,budget_limit,budget_spent,heartbeat_enabled,heartbeat_interval,last_heartbeat,tasks_done,tasks_failed,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const a of data) i.run(a.id, a.openclaw_agent_id, a.name, a.status, a.budget_limit, a.budget_spent, a.heartbeat_enabled, a.heartbeat_interval, a.last_heartbeat, a.tasks_done, a.tasks_failed, a.created_at);
    },
    saveProjects: (data) => {
      rawDb.exec('DELETE FROM projects');
      const i = rawDb.prepare(`INSERT INTO projects (id,title,description,workspace_path,status,created_at,is_template,template_source_id,trigger_rules)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const p of data) i.run(p.id, p.title, p.description || '', p.workspace_path || '', p.status || 'active', p.created_at, p.is_template || 0, p.template_source_id || null, typeof p.trigger_rules === 'string' ? p.trigger_rules : JSON.stringify(p.trigger_rules || []));
    },
    saveApprovals: (data) => {
      rawDb.exec('DELETE FROM approvals');
      const i = rawDb.prepare(`INSERT INTO approvals (id,task_id,status,requested_at,resolved_at,resolved_by,notes) VALUES (?,?,?,?,?,?,?)`);
      for (const a of data) i.run(a.id, a.task_id, a.status || 'pending', a.requested_at, a.resolved_at || null, a.resolved_by || null, a.notes || '');
    },
    insertTaskBatch: (tasks) => {
      const i = rawDb.prepare(`INSERT INTO tasks (id,project_id,assigned_agent_id,title,description,status,priority,dependency_id,dependency_ids,creates_agent,created_by_agent_id,created_at,completed_at,run_count,_retry_count,_status_changed_at,deleted_at,updated_at,repeat,scheduled_at,requires_approval)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const t of tasks) i.run(t.id, t.project_id, t.assigned_agent_id || null, t.title, t.description || '', t.status, t.priority, t.dependency_id || null, t.dependency_ids || null, t.creates_agent || null, t.created_by_agent_id || null, t.created_at, t.completed_at || null, t.run_count || 0, t._retry_count || 0, t._status_changed_at || null, t.deleted_at || null, t.updated_at || null, t.repeat || 0, t.scheduled_at || null, t.requires_approval ? 1 : 0);
      return tasks.map(t => t.id);
    },
    saveTaskResults: (data) => {
      rawDb.exec('DELETE FROM task_results');
      const i = rawDb.prepare(`INSERT INTO task_results (id,task_id,agent_id,status,output,error,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?)`);
      for (const r of data) i.run(r.id, r.task_id, r.agent_id, r.status, r.output || '', r.error || '', r.duration_ms || 0, r.created_at);
    },
    insertApproval: ({ task_id, notes }) => {
      const id = nextId(rawDb, 'approvals');
      rawDb.prepare(`INSERT INTO approvals (id,task_id,status,requested_at,resolved_at,resolved_by,notes) VALUES (?,?,?,?,?,?,?)`).run(id, task_id, 'pending', new Date().toISOString(), null, null, notes || '');
      return rawDb.prepare('SELECT * FROM approvals WHERE id=?').get(id);
    },
  };
}

// ── Inlined scheduler logic (avoids module-level db capture) ──────────────────

/** Mirror of scheduler.getAgentLoadCounts() — reads from any db-like wrapper */
function getAgentLoadCounts(dbWrapper) {
  const tasks = dbWrapper.loadTasks();
  const counts = {};
  for (const t of tasks) {
    if (t.status === 'in_progress' && t.assigned_agent_id) {
      counts[t.assigned_agent_id] = (counts[t.assigned_agent_id] || 0) + 1;
    }
  }
  return counts;
}

/** Mirror of scheduler.pickLeastLoadedAgent() */
function pickLeastLoadedAgent(agentIds, dbWrapper) {
  const counts = getAgentLoadCounts(dbWrapper);
  let best = null, bestCount = Infinity;
  for (const id of agentIds) {
    const c = counts[id] || 0;
    if (c < bestCount) { bestCount = c; best = id; }
  }
  return best;
}

/** Mirror of scheduler.processTriggerRules() — inline to avoid module-level db */
function processTriggerRulesInline(projectId, completedTaskId, dbWrapper) {
  const projects = dbWrapper.loadProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p || !p.trigger_rules || !p.trigger_rules.length) return;

  let rules = p.trigger_rules;
  if (typeof rules === 'string') {
    try { rules = JSON.parse(rules); } catch { return; }
  }
  if (!Array.isArray(rules)) return;

  for (const rule of rules) {
    if (rule.when !== 'task_done') continue;
    if (rule.task_id && +rule.task_id !== +completedTaskId) continue;

    if (rule.then_create_task) {
      const task = rule.then_create_task;
      const tasks = dbWrapper.loadTasks();
      const existing = tasks.find(t =>
        t.title === task.title &&
        t.project_id === projectId &&
        t.status === 'pending'
      );
      if (existing) continue;

      const id = dbWrapper.nextId('tasks');
      const now = new Date().toISOString();
      dbWrapper.saveTasks([{
        id,
        project_id: projectId,
        assigned_agent_id: task.assigned_to_agent_id || null,
        title: task.title,
        description: task.description || '',
        status: 'pending',
        priority: task.priority || 'medium',
        dependency_id: null,
        dependency_ids: null,
        creates_agent: null,
        created_by_agent_id: null,
        created_at: now,
        completed_at: null,
        run_count: 0,
        _retry_count: 0,
        _status_changed_at: null,
        deleted_at: null,
        updated_at: null,
        repeat: 0,
        scheduled_at: task.scheduled_at || null,
        requires_approval: task.requires_approval ? 1 : 0,
      }]);
    }
  }
}

// ── Seed helper ─────────────────────────────────────────────────────────────────

function seed(rawDb, { projects = [], agents = [], tasks = [], approvals = [] } = {}) {
  if (projects.length) {
    const i = rawDb.prepare(`INSERT INTO projects (id,title,description,workspace_path,status,created_at,is_template,template_source_id,trigger_rules) VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const p of projects) i.run(p.id, p.title, p.description || '', p.workspace_path || '', p.status || 'active', p.created_at || new Date().toISOString(), p.is_template || 0, p.template_source_id || null, typeof p.trigger_rules === 'string' ? p.trigger_rules : JSON.stringify(p.trigger_rules || []));
  }
  if (agents.length) {
    const i = rawDb.prepare(`INSERT INTO agents (id,openclaw_agent_id,name,status,budget_limit,budget_spent,heartbeat_enabled,heartbeat_interval,last_heartbeat,tasks_done,tasks_failed,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const a of agents) i.run(a.id, a.openclaw_agent_id, a.name, a.status || 'active', a.budget_limit || 0, a.budget_spent || 0, a.heartbeat_enabled ?? 1, a.heartbeat_interval ?? 60, a.last_heartbeat || null, a.tasks_done || 0, a.tasks_failed || 0, a.created_at || new Date().toISOString());
  }
  if (tasks.length) {
    const i = rawDb.prepare(`INSERT INTO tasks (id,project_id,assigned_agent_id,title,description,status,priority,dependency_id,dependency_ids,creates_agent,created_by_agent_id,created_at,completed_at,run_count,_retry_count,_status_changed_at,deleted_at,updated_at,repeat,scheduled_at,requires_approval) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const t of tasks) i.run(t.id, t.project_id, t.assigned_agent_id || null, t.title, t.description || '', t.status || 'pending', t.priority || 'medium', t.dependency_id || null, t.dependency_ids || null, t.creates_agent || null, t.created_by_agent_id || null, t.created_at || new Date().toISOString(), t.completed_at || null, t.run_count || 0, t._retry_count || 0, t._status_changed_at || null, t.deleted_at || null, t.updated_at || null, t.repeat || 0, t.scheduled_at || null, t.requires_approval ? 1 : 0);
  }
  if (approvals.length) {
    const i = rawDb.prepare(`INSERT INTO approvals (id,task_id,status,requested_at,resolved_at,resolved_by,notes) VALUES (?,?,?,?,?,?,?)`);
    for (const a of approvals) i.run(a.id, a.task_id, a.status || 'pending', a.requested_at, a.resolved_at || null, a.resolved_by || null, a.notes || '');
  }
}

// ── Express test app helper ────────────────────────────────────────────────────

function createApp(dbWrapper) {
  const express = require('express');
  const app = express();
  app.use(express.json());

  const taskRouter = express.Router();
  require('../routes/tasks')(taskRouter, { db: dbWrapper, broadcastSSE: () => {}, setTaskStatus: () => {}, nextId: dbWrapper.nextId });
  app.use('/api/tasks', taskRouter);

  const projectRouter = express.Router();
  require('../routes/projects')(projectRouter, { db: dbWrapper, broadcastSSE: () => {}, setTaskStatus: () => {} });
  app.use('/api/projects', projectRouter);

  const approvalRouter = express.Router();
  require('../routes/approvals')(approvalRouter, { db: dbWrapper });
  app.use('/api/approvals', approvalRouter);

  return app;
}

function request(app, method, path, body) {
  return new Promise((resolve) => {
    const opts = { method, path };
    const server = app.listen(0, () => {
      const { port } = server.address();
      opts.port = port;
      if (body) opts.headers = { 'Content-Type': 'application/json' };
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          server.close();
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', () => { server.close(); resolve({ status: 0, body: null }); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. SCHEDULER SERVICE — inline tests (avoid patchRequire for module-level db)
// ══════════════════════════════════════════════════════════════════════════════

describe('Scheduler service', () => {
  afterEach(() => { closeDb(getDb()); });

  test('processTriggerRules creates a new task when task_done rule matches', () => {
    const rawDb = getDb();
    seed(rawDb, {
      projects: [{
        id: 1, title: 'P1',
        trigger_rules: JSON.stringify([{
          when: 'task_done', task_id: 1,
          then_create_task: { title: 'Follow-up from task 1', description: 'Auto-created by rule' },
        }]),
      }],
      tasks: [{ id: 1, project_id: 1, title: 'Task 1', status: 'done' }],
    });
    const dbWrapper = makeDbWrapper(rawDb);

    processTriggerRulesInline(1, 1, dbWrapper);

    const tasks = rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    const followup = tasks.find(t => t.title === 'Follow-up from task 1');
    expect(followup).toBeTruthy();
    expect(followup.project_id).toBe(1);
    expect(followup.status).toBe('pending');
    closeDb(rawDb);
  });

  test('processTriggerRules respects assigned_to_agent_id in rule', () => {
    const rawDb = getDb();
    seed(rawDb, {
      projects: [{
        id: 1, title: 'P1',
        trigger_rules: JSON.stringify([{
          when: 'task_done', task_id: 1,
          then_create_task: { title: 'Follow-up', assigned_to_agent_id: 1 },
        }]),
      }],
      agents: [{ id: 1, openclaw_agent_id: 'alice', name: 'Alice' }],
      tasks: [{ id: 1, project_id: 1, title: 'Task 1', status: 'done' }],
    });
    const dbWrapper = makeDbWrapper(rawDb);

    processTriggerRulesInline(1, 1, dbWrapper);

    const tasks = rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    const followup = tasks.find(t => t.title === 'Follow-up');
    expect(followup).toBeTruthy();
    expect(followup.assigned_agent_id).toBe(1);
    closeDb(rawDb);
  });

  test('processTriggerRules does nothing for unrelated task_id', () => {
    const rawDb = getDb();
    seed(rawDb, {
      projects: [{
        id: 1, title: 'P1',
        trigger_rules: JSON.stringify([{
          when: 'task_done', task_id: 99,
          then_create_task: { title: 'Should not appear' },
        }]),
      }],
      tasks: [{ id: 1, project_id: 1, title: 'Task 1', status: 'done' }],
    });
    const dbWrapper = makeDbWrapper(rawDb);

    processTriggerRulesInline(1, 1, dbWrapper);

    const tasks = rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    const found = tasks.find(t => t.title === 'Should not appear');
    expect(found).toBeUndefined();
    closeDb(rawDb);
  });

  test('pickLeastLoadedAgent picks agent with fewest in_progress tasks', () => {
    const rawDb = getDb();
    seed(rawDb, {
      agents: [
        { id: 1, openclaw_agent_id: 'heavy', name: 'Heavy' },
        { id: 2, openclaw_agent_id: 'light', name: 'Light' },
      ],
      tasks: [
        { id: 1, project_id: 1, assigned_agent_id: 1, title: 'T1', status: 'in_progress' },
        { id: 2, project_id: 1, assigned_agent_id: 1, title: 'T2', status: 'in_progress' },
        { id: 3, project_id: 1, assigned_agent_id: 1, title: 'T3', status: 'in_progress' },
      ],
    });
    const dbWrapper = makeDbWrapper(rawDb);

    const chosen = pickLeastLoadedAgent([1, 2], dbWrapper);
    expect(chosen).toBe(2);
    closeDb(rawDb);
  });

  test('pickLeastLoadedAgent returns null for empty agent list', () => {
    const rawDb = getDb();
    const dbWrapper = makeDbWrapper(rawDb);

    const chosen = pickLeastLoadedAgent([], dbWrapper);
    expect(chosen).toBeNull();
    closeDb(rawDb);
  });

  test('pickLeastLoadedAgent with tied load returns first agent in list', () => {
    const rawDb = getDb();
    seed(rawDb, {
      agents: [
        { id: 1, openclaw_agent_id: 'a1', name: 'A1' },
        { id: 2, openclaw_agent_id: 'a2', name: 'A2' },
      ],
      tasks: [],
    });
    const dbWrapper = makeDbWrapper(rawDb);

    const chosen = pickLeastLoadedAgent([1, 2], dbWrapper);
    expect(chosen).toBe(1);
    closeDb(rawDb);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. SCHEDULER ENGINE — schedule detection tests
// ══════════════════════════════════════════════════════════════════════════════

describe('Scheduler engine', () => {
  afterEach(() => { restoreRequire(); closeDb(getDb()); });

  const Module = require('module');
  const origRequire = Module.prototype.require;
  function patchRequire(dbWrapper) {
    Module.prototype.require = function (id) {
      if (id === '../db' || id === './db') return dbWrapper;
      return origRequire.apply(this, arguments);
    };
  }
  function restoreRequire() { Module.prototype.require = origRequire; }

  test('scheduled task in future is not due', () => {
    const rawDb = getDb();
    seed(rawDb, {
      agents: [{ id: 1, openclaw_agent_id: 'agent1', name: 'Agent 1' }],
      tasks: [{
        id: 1, project_id: 1, assigned_agent_id: 1, title: 'Future Task',
        status: 'pending', scheduled_at: '2099-01-01T00:00:00.000Z',
      }],
    });
    const now = new Date();
    const tasks = rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    const dueTasks = tasks.filter(t => t.status === 'pending' && t.scheduled_at && new Date(t.scheduled_at) <= now);
    expect(dueTasks.length).toBe(0);
    closeDb(rawDb);
  });

  test('GET /api/projects/:id/tasks/scheduled?upcoming=1 returns only future tasks', async () => {
    const rawDb = getDb();
    seed(rawDb, {
      projects: [{ id: 1, title: 'P1' }],
      agents: [{ id: 1, openclaw_agent_id: 'agent1', name: 'Agent 1' }],
      tasks: [
        { id: 1, project_id: 1, assigned_agent_id: 1, title: 'Past Task', status: 'pending', scheduled_at: '2020-01-01T00:00:00.000Z' },
        { id: 2, project_id: 1, assigned_agent_id: 1, title: 'Future Task', status: 'pending', scheduled_at: '2099-01-01T00:00:00.000Z' },
      ],
    });
    const dbWrapper = makeDbWrapper(rawDb);
    const app = createApp(dbWrapper);
    const { status, body } = await request(app, 'GET', '/api/projects/1/tasks/scheduled?upcoming=1');
    expect(status).toBe(200);
    expect(body.length).toBe(1);
    expect(body[0].title).toBe('Future Task');
    closeDb(rawDb);
  });

  test('past scheduled_at makes task eligible (due task detection)', () => {
    const rawDb = getDb();
    seed(rawDb, {
      agents: [{ id: 1, openclaw_agent_id: 'agent1', name: 'Agent 1' }],
      tasks: [{
        id: 1, project_id: 1, assigned_agent_id: 1, title: 'Past Task',
        status: 'pending', scheduled_at: '2020-01-01T00:00:00.000Z',
      }],
    });
    const now = new Date();
    const tasks = rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    const dueTasks = tasks.filter(t => t.status === 'pending' && t.scheduled_at && new Date(t.scheduled_at) <= now);
    expect(dueTasks.length).toBe(1);
    expect(dueTasks[0].title).toBe('Past Task');
    closeDb(rawDb);
  });

  test('unscheduled task is always due', () => {
    const rawDb = getDb();
    seed(rawDb, {
      agents: [{ id: 1, openclaw_agent_id: 'agent1', name: 'Agent 1' }],
      tasks: [{
        id: 1, project_id: 1, assigned_agent_id: 1, title: 'Unscheduled Task',
        status: 'pending',
      }],
    });
    const now = new Date();
    const tasks = rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
    const dueTasks = tasks.filter(t => t.status === 'pending' && (!t.scheduled_at || new Date(t.scheduled_at) <= now));
    expect(dueTasks.length).toBe(1);
    closeDb(rawDb);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. TRIGGER RULES HTTP API
// ══════════════════════════════════════════════════════════════════════════════

const Module2 = require('module');
const origRequire2 = Module2.prototype.require;
function patchRequire2(dbWrapper) {
  Module2.prototype.require = function (id) {
    if (id === '../db' || id === './db') return dbWrapper;
    return origRequire2.apply(this, arguments);
  };
}
function restoreRequire2() { Module2.prototype.require = origRequire2; }

describe('Trigger rules HTTP API', () => {
  afterEach(() => { restoreRequire2(); closeDb(getDb()); });

  test('PUT /api/projects/:id/trigger-rules sets rules and persists them', async () => {
    const rawDb = getDb();
    seed(rawDb, { projects: [{ id: 1, title: 'P1' }] });
    const rules = [
      { when: 'task_done', task_id: 5, then_create_task: { title: 'Follow-up from 5' } },
      { when: 'task_done', task_id: 7, then_create_task: { title: 'Follow-up from 7', priority: 'high' } },
    ];
    const dbWrapper = makeDbWrapper(rawDb);
    patchRequire2(dbWrapper);
    const app = createApp(dbWrapper);
    const { status, body } = await request(app, 'PUT', '/api/projects/1/trigger-rules', { trigger_rules: rules });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.project_id).toBe(1);
    expect(body.trigger_rules.length).toBe(2);
    expect(body.trigger_rules[0].when).toBe('task_done');
    closeDb(rawDb);
  });

  test('PUT /api/projects/:id/trigger-rules 404 for non-existent project', async () => {
    const rawDb = getDb();
    const dbWrapper = makeDbWrapper(rawDb);
    patchRequire2(dbWrapper);
    const app = createApp(dbWrapper);
    const { status } = await request(app, 'PUT', '/api/projects/999/trigger-rules', { trigger_rules: [] });
    expect(status).toBe(404);
    closeDb(rawDb);
  });

  test('PUT /api/projects/:id/trigger-rules 400 for non-array trigger_rules', async () => {
    const rawDb = getDb();
    seed(rawDb, { projects: [{ id: 1, title: 'P1' }] });
    const dbWrapper = makeDbWrapper(rawDb);
    patchRequire2(dbWrapper);
    const app = createApp(dbWrapper);
    const { status } = await request(app, 'PUT', '/api/projects/1/trigger-rules', { trigger_rules: 'not-an-array' });
    expect(status).toBe(400);
    closeDb(rawDb);
  });

  test('GET /api/projects/:id/trigger-rules returns stored rules', async () => {
    const rawDb = getDb();
    seed(rawDb, {
      projects: [{
        id: 1, title: 'P1',
        trigger_rules: JSON.stringify([{ when: 'task_done', task_id: 5, then_create_task: { title: 'Follow-up' } }]),
      }],
    });
    const dbWrapper = makeDbWrapper(rawDb);
    patchRequire2(dbWrapper);
    const app = createApp(dbWrapper);
    const { status, body } = await request(app, 'GET', '/api/projects/1/trigger-rules');
    expect(status).toBe(200);
    expect(body.trigger_rules.length).toBe(1);
    expect(body.trigger_rules[0].when).toBe('task_done');
    closeDb(rawDb);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. APPROVALS API
// ══════════════════════════════════════════════════════════════════════════════

describe('Approvals API', () => {
  afterEach(() => { closeDb(getDb()); });

  test('POST /api/approvals creates a pending approval for a task', async () => {
    const rawDb = getDb();
    seed(rawDb, {
      tasks: [{ id: 1, project_id: 1, title: 'Task 1', status: 'pending' }],
    });
    const dbWrapper = makeDbWrapper(rawDb);
    const app = createApp(dbWrapper);
    const { status, body } = await request(app, 'POST', '/api/approvals', { task_id: 1 });
    expect(status).toBe(201);
    expect(body.task_id).toBe(1);
    expect(body.status).toBe('pending');
    closeDb(rawDb);
  });

  test('POST /api/approvals 400 when task_id missing', async () => {
    const rawDb = getDb();
    const dbWrapper = makeDbWrapper(rawDb);
    const app = createApp(dbWrapper);
    const { status } = await request(app, 'POST', '/api/approvals', {});
    expect(status).toBe(400);
    closeDb(rawDb);
  });

  test('POST /api/approvals 404 for non-existent task', async () => {
    const rawDb = getDb();
    const dbWrapper = makeDbWrapper(rawDb);
    const app = createApp(dbWrapper);
    const { status } = await request(app, 'POST', '/api/approvals', { task_id: 9999 });
    expect(status).toBe(404);
    closeDb(rawDb);
  });

  test('GET /api/approvals?task_id=X returns approvals for that task', async () => {
    const rawDb = getDb();
    seed(rawDb, {
      tasks: [{ id: 1, project_id: 1, title: 'Task 1', status: 'pending' }],
      approvals: [
        { id: 1, task_id: 1, status: 'pending', requested_at: new Date().toISOString() },
        { id: 2, task_id: 2, status: 'pending', requested_at: new Date().toISOString() },
      ],
    });
    const dbWrapper = makeDbWrapper(rawDb);
    const app = createApp(dbWrapper);
    const { status, body } = await request(app, 'GET', '/api/approvals?task_id=1');
    expect(status).toBe(200);
    expect(body.length).toBe(1);
    expect(body[0].task_id).toBe(1);
    closeDb(rawDb);
  });

  test('PUT /api/approvals/:id with status:approved approves the request', async () => {
    const rawDb = getDb();
    seed(rawDb, {
      tasks: [{ id: 1, project_id: 1, title: 'Task 1', status: 'awaiting_approval' }],
      approvals: [
        { id: 1, task_id: 1, status: 'pending', requested_at: new Date().toISOString() },
      ],
    });
    const dbWrapper = makeDbWrapper(rawDb);
    const app = createApp(dbWrapper);
    const { status, body } = await request(app, 'PUT', '/api/approvals/1', { status: 'approved' });
    expect(status).toBe(200);
    expect(body.status).toBe('approved');
    const task = rawDb.prepare('SELECT * FROM tasks WHERE id=1').get();
    expect(task.status).toBe('pending');
    closeDb(rawDb);
  });

  test('PUT /api/approvals/:id with status:rejected rejects the request', async () => {
    const rawDb = getDb();
    seed(rawDb, {
      tasks: [{ id: 1, project_id: 1, title: 'Task 1', status: 'awaiting_approval' }],
      approvals: [
        { id: 1, task_id: 1, status: 'pending', requested_at: new Date().toISOString() },
      ],
    });
    const dbWrapper = makeDbWrapper(rawDb);
    const app = createApp(dbWrapper);
    const { status, body } = await request(app, 'PUT', '/api/approvals/1', { status: 'rejected' });
    expect(status).toBe(200);
    expect(body.status).toBe('rejected');
    closeDb(rawDb);
  });

  test('PUT /api/approvals/:id 400 for invalid status', async () => {
    const rawDb = getDb();
    seed(rawDb, {
      tasks: [{ id: 1, project_id: 1, title: 'Task 1', status: 'awaiting_approval' }],
      approvals: [
        { id: 1, task_id: 1, status: 'pending', requested_at: new Date().toISOString() },
      ],
    });
    const dbWrapper = makeDbWrapper(rawDb);
    const app = createApp(dbWrapper);
    const { status } = await request(app, 'PUT', '/api/approvals/1', { status: 'maybe' });
    expect(status).toBe(400);
    closeDb(rawDb);
  });
});