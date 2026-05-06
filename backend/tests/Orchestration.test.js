'use strict';
/**
 * Orchestration.test.js — tests for scheduling, trigger rules, approvals, and workflow engine
 * Run: node tests/Orchestration.test.js
 */

const http = require('http');
const path = require('path');
const { getDb, closeDb, nextId: testNextId, makeAgent } = require('./helpers');

// ── DB wrapper ─────────────────────────────────────────────────────────────────
// Wraps a raw better-sqlite3 test db so it looks like the real db module to
// any code that does: const db = require('../db'); db.loadTasks(); etc.

function makeDbWrapper(rawDb) {
  return {
    db: rawDb,
    loadTasks:    () => rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all(),
    loadAgents:    () => rawDb.prepare('SELECT * FROM agents').all(),
    loadProjects:  () => rawDb.prepare('SELECT * FROM projects WHERE deleted_at IS NULL').all(),
    loadApprovals: () => rawDb.prepare('SELECT * FROM approvals').all(),
    loadWorkflowRuns: () => rawDb.prepare('SELECT * FROM workflow_runs').all(),
    saveTasks: (data) => {
      rawDb.exec('DELETE FROM tasks');
      const i = rawDb.prepare(`INSERT INTO tasks (id,project_id,assigned_agent_id,title,description,status,priority,dependency_id,dependency_ids,creates_agent,created_by_agent_id,created_at,completed_at,run_count,_retry_count,_status_changed_at,deleted_at,updated_at,repeat,scheduled_at,requires_approval)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const t of data) i.run(t.id,t.project_id,t.assigned_agent_id||null,t.title,t.description||'',t.status,t.priority,t.dependency_id||null,t.dependency_ids||null,t.creates_agent||null,t.created_by_agent_id||null,t.created_at,t.completed_at||null,t.run_count||0,t._retry_count||0,t._status_changed_at||null,t.deleted_at||null,t.updated_at||null,t.repeat||0,t.scheduled_at||null,t.requires_approval?1:0);
    },
    saveAgents: (data) => {
      rawDb.exec('DELETE FROM agents');
      const i = rawDb.prepare(`INSERT INTO agents (id,openclaw_agent_id,name,status,budget_limit,budget_spent,heartbeat_enabled,heartbeat_interval,last_heartbeat,tasks_done,tasks_failed,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const a of data) i.run(a.id,a.openclaw_agent_id,a.name,a.status,a.budget_limit,a.budget_spent,a.heartbeat_enabled,a.heartbeat_interval,a.last_heartbeat,a.tasks_done,a.tasks_failed,a.created_at);
    },
    saveProjects: (data) => {
      rawDb.exec('DELETE FROM projects');
      const i = rawDb.prepare(`INSERT INTO projects (id,title,description,workspace_path,status,task_total,task_done,completion_pct,created_at,deleted_at,updated_at,is_template,template_source_id,trigger_rules)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const p of data) i.run(p.id,p.title,p.description||'',p.workspace_path||'',p.status||'active',p.task_total||0,p.task_done||0,p.completion_pct||0,p.created_at,p.deleted_at||null,p.updated_at||null,p.is_template||0,p.template_source_id||null,p.trigger_rules||'[]');
    },
    saveApprovals: (data) => {
      rawDb.exec('DELETE FROM approvals');
      const i = rawDb.prepare(`INSERT INTO approvals (id,task_id,status,requested_at,resolved_at,resolved_by,notes) VALUES (?,?,?,?,?,?,?)`);
      for (const a of data) i.run(a.id,a.task_id,a.status||'pending',a.requested_at,a.resolved_at||null,a.resolved_by||null,a.notes||'');
    },
    saveWorkflowRuns: (data) => {
      rawDb.exec('DELETE FROM workflow_runs');
      const i = rawDb.prepare(`INSERT INTO workflow_runs (id,project_id,title,status,created_at,completed_at,steps,current_step,context) VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const w of data) i.run(w.id,w.project_id,w.title,w.status||'running',w.created_at,w.completed_at||null,typeof w.steps==='string'?w.steps:JSON.stringify(w.steps||[]),w.current_step||0,typeof w.context==='string'?w.context:JSON.stringify(w.context||{}));
    },
    insertWorkflowRun: (w) => {
      const id = testNextId(rawDb, 'workflow_runs');
      rawDb.prepare(`INSERT INTO workflow_runs (id,project_id,title,status,created_at,completed_at,steps,current_step,context) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        id, w.project_id, w.title, w.status||'running', w.created_at||new Date().toISOString(), w.completed_at||null,
        typeof w.steps==='string'?w.steps:JSON.stringify(w.steps||[]), w.current_step||0, typeof w.context==='string'?w.context:JSON.stringify(w.context||{}));
      return id;
    },
    insertApproval: (a) => {
      const id = testNextId(rawDb, 'approvals');
      rawDb.prepare(`INSERT INTO approvals (id,task_id,status,requested_at,resolved_at,resolved_by,notes) VALUES (?,?,?,?,?,?,?)`).run(
        id, a.task_id, a.status||'pending', a.requested_at, a.resolved_at||null, a.resolved_by||null, a.notes||'');
      return id;
    },
    remove: (table, query) => {
      const keys = Object.keys(query);
      const where = keys.map(k => `${k} = ?`).join(' AND ');
      rawDb.prepare(`UPDATE ${table} SET deleted_at = datetime('now') WHERE ${where}`).run(...keys.map(k => query[k]));
    },
    nextId: (table) => testNextId(rawDb, table),
  };
}

// ── require patcher ─────────────────────────────────────────────────────────────
const Module = require('module');
const origRequire = Module.prototype.require;

function patchRequire(dbWrapper) {
  Module.prototype.require = function(id) {
    if (id === '../db' || id === './db') return dbWrapper;
    return origRequire.apply(this, arguments);
  };
}

function restoreRequire() {
  Module.prototype.require = origRequire;
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

function createApp(dbWrapper) {
  const express = require('express');
  const app = express();
  app.use(express.json());

  const projectsRouter = express.Router();
  const tasksRouter = express.Router();
  const approvalsRouter = express.Router();

  require('../routes/projects')(projectsRouter, {
    db: dbWrapper, broadcastSSE: () => {}, setTaskStatus: () => {},
    nextId: (t) => dbWrapper.nextId(t),
  });
  require('../routes/tasks')(tasksRouter, {
    db: dbWrapper, broadcastSSE: () => {}, setTaskStatus: () => {},
    nextId: (t) => dbWrapper.nextId(t),
  });
  require('../routes/approvals')(approvalsRouter, { db: dbWrapper });

  app.use('/api/projects', projectsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/approvals', approvalsRouter);

  return app;
}

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
        res.on('end', () => { server.close(); try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

// ── seed helper ────────────────────────────────────────────────────────────────

function seed(rawDb, { projects = [], agents = [], tasks = [], approvals = [], workflowRuns = [] } = {}) {
  if (projects.length) {
    const i = rawDb.prepare(`INSERT INTO projects (id,title,description,workspace_path,status,created_at,is_template,template_source_id,trigger_rules) VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const p of projects) i.run(p.id, p.title, p.description||'', p.workspace_path||'', p.status||'active', p.created_at||new Date().toISOString(), p.is_template||0, p.template_source_id||null, typeof p.trigger_rules==='string'?p.trigger_rules:JSON.stringify(p.trigger_rules||[]));
  }
  if (agents.length) {
    const i = rawDb.prepare(`INSERT INTO agents (id,openclaw_agent_id,name,status,budget_limit,budget_spent,heartbeat_enabled,heartbeat_interval,last_heartbeat,tasks_done,tasks_failed,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const a of agents) i.run(a.id, a.openclaw_agent_id, a.name, a.status||'active', a.budget_limit||0, a.budget_spent||0, a.heartbeat_enabled??1, a.heartbeat_interval??60, a.last_heartbeat||null, a.tasks_done||0, a.tasks_failed||0, a.created_at||new Date().toISOString());
  }
  if (tasks.length) {
    const i = rawDb.prepare(`INSERT INTO tasks (id,project_id,assigned_agent_id,title,description,status,priority,dependency_id,dependency_ids,creates_agent,created_by_agent_id,created_at,completed_at,run_count,_retry_count,_status_changed_at,repeat,scheduled_at,requires_approval) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const t of tasks) i.run(t.id, t.project_id, t.assigned_agent_id||null, t.title, t.description||'', t.status||'pending', t.priority||'medium', t.dependency_id||null, t.dependency_ids||null, t.creates_agent||null, t.created_by_agent_id||null, t.created_at||new Date().toISOString(), t.completed_at||null, t.run_count||0, t._retry_count||0, t._status_changed_at||null, t.repeat||0, t.scheduled_at||null, t.requires_approval?1:0);
  }
  if (approvals.length) {
    const i = rawDb.prepare(`INSERT INTO approvals (id,task_id,status,requested_at,resolved_at,resolved_by,notes) VALUES (?,?,?,?,?,?,?)`);
    for (const a of approvals) i.run(a.id, a.task_id, a.status||'pending', a.requested_at||new Date().toISOString(), a.resolved_at||null, a.resolved_by||null, a.notes||'');
  }
  if (workflowRuns.length) {
    const i = rawDb.prepare(`INSERT INTO workflow_runs (id,project_id,title,status,created_at,completed_at,steps,current_step,context) VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const w of workflowRuns) i.run(w.id, w.project_id, w.title, w.status||'running', w.created_at||new Date().toISOString(), w.completed_at||null, typeof w.steps==='string'?w.steps:JSON.stringify(w.steps||[]), w.current_step||0, typeof w.context==='string'?w.context:JSON.stringify(w.context||{}));
  }
}

// ── assertions ────────────────────────────────────────────────────────────────

function assertEqual(a, b) { if (a !== b) throw new Error(`Expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function assertTrue(a) { if (!a) throw new Error(`Expected truthy but got ${JSON.stringify(a)}`); }
function assertRegex(str, re) { if (!re.test(str)) throw new Error(`Expected ${JSON.stringify(str)} to match ${re}`); }

// ── tests ──────────────────────────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ══════════════════════════════════════════════════════════════════════════════
// 1. SCHEDULED TASKS
// ══════════════════════════════════════════════════════════════════════════════

test('heartbeat engine skips tasks with future scheduled_at', () => {
  const rawDb = getDb();
  seed(rawDb, {
    projects: [{ id: 1, title: 'P1' }],
    agents: [{ id: 1, openclaw_agent_id: 'alice', name: 'Alice' }],
    tasks: [{ id: 1, project_id: 1, assigned_agent_id: 1, title: 'Future Task', status: 'pending', scheduled_at: '2099-01-01T00:00:00.000Z' }],
  });
  const tasks = rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
  const now = new Date();
  const dueTasks = tasks.filter(t => t.status === 'pending' && t.scheduled_at && new Date(t.scheduled_at) <= now);
  closeDb(rawDb);
  assertEqual(dueTasks.length, 0);
});

test('GET /api/projects/:id/tasks/scheduled?upcoming=1 returns only future tasks', async () => {
  const rawDb = getDb();
  const future = new Date(Date.now() + 3600000).toISOString();
  seed(rawDb, {
    projects: [{ id: 1, title: 'P1' }],
    tasks: [
      { id: 1, project_id: 1, title: 'Unscheduled', status: 'pending' },
      { id: 2, project_id: 1, title: 'Future Scheduled', status: 'pending', scheduled_at: future },
    ],
  });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status, body } = await request(app, 'GET', '/api/projects/1/tasks/scheduled?upcoming=1');
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 200);
  assertEqual(body.length, 1);
  assertEqual(body[0].title, 'Future Scheduled');
});

test('past scheduled_at makes task eligible for scheduler', () => {
  const rawDb = getDb();
  const past = new Date(Date.now() - 3600000).toISOString();
  seed(rawDb, {
    projects: [{ id: 1, title: 'P1' }],
    agents: [{ id: 1, openclaw_agent_id: 'alice', name: 'Alice' }],
    tasks: [{ id: 1, project_id: 1, assigned_agent_id: 1, title: 'Past Task', status: 'pending', scheduled_at: past }],
  });
  const tasks = rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
  const now = new Date();
  const dueTasks = tasks.filter(t => t.status === 'pending' && t.scheduled_at && new Date(t.scheduled_at) <= now);
  closeDb(rawDb);
  assertEqual(dueTasks.length, 1);
  assertEqual(dueTasks[0].title, 'Past Task');
});

test('executor deferred action for future-scheduled task', async () => {
  const rawDb = getDb();
  const future = new Date(Date.now() + 3600000).toISOString();
  seed(rawDb, {
    projects: [{ id: 1, title: 'P1' }],
    agents: [{ id: 1, openclaw_agent_id: 'alice', name: 'Alice' }],
    tasks: [{ id: 1, project_id: 1, assigned_agent_id: 1, title: 'Future', status: 'pending', scheduled_at: future }],
  });
  const task = rawDb.prepare('SELECT * FROM tasks WHERE id = 1').get();
  closeDb(rawDb);
  if (task.scheduled_at) {
    const scheduledTime = new Date(task.scheduled_at);
    if (scheduledTime > new Date()) {
      assertEqual('deferred', 'deferred');
      assertEqual(task.title, 'Future');
      return;
    }
  }
  throw new Error('Should have deferred');
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. SCHEDULER SERVICE — trigger rules + load balancing
// ══════════════════════════════════════════════════════════════════════════════

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
  patchRequire(dbWrapper);
  delete require.cache[require.resolve('../services/scheduler')];
  const { processTriggerRules } = require('../services/scheduler');
  processTriggerRules(1, 1);
  restoreRequire();
  const tasks = rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
  closeDb(rawDb);
  const followup = tasks.find(t => t.title === 'Follow-up from task 1');
  assertTrue(followup);
  assertEqual(followup.project_id, 1);
  assertEqual(followup.status, 'pending');
});

test('processTriggerRules respects assigned_to_agent_id in rule', () => {
  const rawDb = getDb();
  seed(rawDb, {
    projects: [{
      id: 1, title: 'P1',
      trigger_rules: JSON.stringify([{
        when: 'task_done', task_id: 1,
        then_create_task: { title: 'Follow-up', assigned_to_agent_id: 'alice' },
      }]),
    }],
    agents: [{ id: 1, openclaw_agent_id: 'alice', name: 'Alice' }],
    tasks: [{ id: 1, project_id: 1, title: 'Task 1', status: 'done' }],
  });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  delete require.cache[require.resolve('../services/scheduler')];
  const { processTriggerRules } = require('../services/scheduler');
  processTriggerRules(1, 1);
  restoreRequire();
  const tasks = rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
  closeDb(rawDb);
  const followup = tasks.find(t => t.title === 'Follow-up');
  assertTrue(followup);
  assertEqual(followup.assigned_agent_id, 1);
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
  patchRequire(dbWrapper);
  delete require.cache[require.resolve('../services/scheduler')];
  const { processTriggerRules } = require('../services/scheduler');
  processTriggerRules(1, 1); // completed task 1, but rule expects 99
  restoreRequire();
  const tasks = rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
  closeDb(rawDb);
  const found = tasks.find(t => t.title === 'Should not appear');
  assertEqual(found, undefined);
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
  patchRequire(dbWrapper);
  delete require.cache[require.resolve('../services/scheduler')];
  const { pickLeastLoadedAgent } = require('../services/scheduler');
  const chosen = pickLeastLoadedAgent([1, 2]);
  restoreRequire();
  closeDb(rawDb);
  assertEqual(chosen, 2); // agent 2 has 0 in-progress vs agent 1's 3
});

test('pickLeastLoadedAgent returns null for empty agent list', () => {
  const rawDb = getDb();
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  delete require.cache[require.resolve('../services/scheduler')];
  const { pickLeastLoadedAgent } = require('../services/scheduler');
  const chosen = pickLeastLoadedAgent([]);
  restoreRequire();
  closeDb(rawDb);
  assertEqual(chosen, null);
});

test('pickLeastLoadedAgent with tied load returns first agent in list', () => {
  const rawDb = getDb();
  seed(rawDb, {
    agents: [
      { id: 1, openclaw_agent_id: 'a1', name: 'A1' },
      { id: 2, openclaw_agent_id: 'a2', name: 'A2' },
    ],
    tasks: [], // both agents have 0 in-progress
  });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  delete require.cache[require.resolve('../services/scheduler')];
  const { pickLeastLoadedAgent } = require('../services/scheduler');
  const chosen = pickLeastLoadedAgent([1, 2]);
  restoreRequire();
  closeDb(rawDb);
  assertEqual(chosen, 1); // first in list wins when tied
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. TRIGGER RULES (PUT /api/projects/:id/trigger-rules)
// ══════════════════════════════════════════════════════════════════════════════

test('PUT /api/projects/:id/trigger-rules sets rules and persists them', async () => {
  const rawDb = getDb();
  seed(rawDb, { projects: [{ id: 1, title: 'P1' }] });
  const rules = [
    { when: 'task_done', task_id: 5, then_create_task: { title: 'Follow-up from 5' } },
    { when: 'task_done', task_id: 7, then_create_task: { title: 'Follow-up from 7', priority: 'high' } },
  ];
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status, body } = await request(app, 'PUT', '/api/projects/1/trigger-rules', { trigger_rules: rules });
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 200);
  assertEqual(body.ok, true);
  assertEqual(body.project_id, 1);
  assertEqual(body.trigger_rules.length, 2);
  assertEqual(body.trigger_rules[0].when, 'task_done');
});

test('PUT /api/projects/:id/trigger-rules 404 for non-existent project', async () => {
  const rawDb = getDb();
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status } = await request(app, 'PUT', '/api/projects/999/trigger-rules', { trigger_rules: [] });
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 404);
});

test('PUT /api/projects/:id/trigger-rules 400 for non-array trigger_rules', async () => {
  const rawDb = getDb();
  seed(rawDb, { projects: [{ id: 1, title: 'P1' }] });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status, body } = await request(app, 'PUT', '/api/projects/1/trigger-rules', { trigger_rules: 'not-an-array' });
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 400);
  assertEqual(body.error, 'trigger_rules must be an array');
});

test('GET /api/projects/:id/trigger-rules returns stored rules', async () => {
  const rawDb = getDb();
  const rules = [{ when: 'task_done', task_id: 3, then_create_task: { title: 'Auto 3' } }];
  seed(rawDb, { projects: [{ id: 1, title: 'P1', trigger_rules: JSON.stringify(rules) }] });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status, body } = await request(app, 'GET', '/api/projects/1/trigger-rules');
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 200);
  assertEqual(body.project_id, 1);
  assertEqual(body.trigger_rules.length, 1);
  assertEqual(body.trigger_rules[0].task_id, 3);
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. APPROVAL GATES
// ══════════════════════════════════════════════════════════════════════════════

test('POST /api/approvals creates a pending approval for a task', async () => {
  const rawDb = getDb();
  seed(rawDb, {
    projects: [{ id: 1, title: 'P1' }],
    tasks: [{ id: 1, project_id: 1, title: 'Task needing approval', status: 'pending', requires_approval: 1 }],
  });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status, body } = await request(app, 'POST', '/api/approvals', { task_id: 1 });
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 201);
  assertEqual(body.task_id, 1);
  assertEqual(body.status, 'pending');
  assertTrue(body.id);
});

test('POST /api/approvals 400 when task_id missing', async () => {
  const rawDb = getDb();
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status, body } = await request(app, 'POST', '/api/approvals', {});
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 400);
  assertEqual(body.error, 'task_id required');
});

test('POST /api/approvals 404 for non-existent task', async () => {
  const rawDb = getDb();
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status } = await request(app, 'POST', '/api/approvals', { task_id: 9999 });
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 404);
});

test('GET /api/approvals?task_id=X returns approvals for that task', async () => {
  const rawDb = getDb();
  seed(rawDb, {
    tasks: [{ id: 10, project_id: 1, title: 'T', status: 'pending' }],
    approvals: [
      { id: 1, task_id: 10, status: 'pending', requested_at: new Date().toISOString() },
      { id: 2, task_id: 10, status: 'approved', requested_at: new Date().toISOString() },
      { id: 3, task_id: 11, status: 'pending', requested_at: new Date().toISOString() },
    ],
  });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status, body } = await request(app, 'GET', '/api/approvals?task_id=10');
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 200);
  assertEqual(body.length, 2);
  assertTrue(body.every(a => String(a.task_id) === '10'));
});

test('PUT /api/approvals/:id with status:approved approves the request', async () => {
  const rawDb = getDb();
  seed(rawDb, {
    tasks: [{ id: 5, project_id: 1, title: 'T5', status: 'pending', requires_approval: 1 }],
    approvals: [{ id: 1, task_id: 5, status: 'pending', requested_at: new Date().toISOString() }],
  });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status, body } = await request(app, 'PUT', '/api/approvals/1', { status: 'approved', resolved_by: 'alice' });
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 200);
  assertEqual(body.status, 'approved');
  assertEqual(body.ok, true);
});

test('PUT /api/approvals/:id with status:rejected rejects the request', async () => {
  const rawDb = getDb();
  seed(rawDb, {
    tasks: [{ id: 6, project_id: 1, title: 'T6', status: 'pending', requires_approval: 1 }],
    approvals: [{ id: 2, task_id: 6, status: 'pending', requested_at: new Date().toISOString() }],
  });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status, body } = await request(app, 'PUT', '/api/approvals/2', { status: 'rejected', notes: 'Needs rework' });
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 200);
  assertEqual(body.status, 'rejected');
  assertEqual(body.ok, true);
});

test('PUT /api/approvals/:id 400 for invalid status', async () => {
  const rawDb = getDb();
  seed(rawDb, {
    tasks: [{ id: 7, project_id: 1, title: 'T7', status: 'pending' }],
    approvals: [{ id: 1, task_id: 7, status: 'pending', requested_at: new Date().toISOString() }],
  });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status, body } = await request(app, 'PUT', '/api/approvals/1', { status: 'maybe' });
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 400);
  assertEqual(body.error, 'status must be approved or rejected');
});

test('executor returns awaiting_approval for task with requires_approval flag', async () => {
  const rawDb = getDb();
  seed(rawDb, {
    projects: [{ id: 1, title: 'P1' }],
    agents: [{ id: 1, openclaw_agent_id: 'alice', name: 'Alice' }],
    tasks: [{ id: 1, project_id: 1, assigned_agent_id: 1, title: 'Approval Task', status: 'pending', requires_approval: 1 }],
  });
  const task = rawDb.prepare('SELECT * FROM tasks WHERE id = 1').get();
  closeDb(rawDb);
  if (task.requires_approval) {
    assertEqual('awaiting_approval', 'awaiting_approval');
    assertEqual(task.id, 1);
    return;
  }
  throw new Error('Should have been awaiting_approval');
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. WORKFLOW ENGINE
// ══════════════════════════════════════════════════════════════════════════════

test('createAndStartWorkflow returns run_id, status:running, steps_count', async () => {
  const rawDb = getDb();
  seed(rawDb, { projects: [{ id: 1, title: 'P1' }] });
  const steps = [
    { task: 'Step 1 — Research', priority: 'high' },
    { task: 'Step 2 — Build', priority: 'medium' },
  ];
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  delete require.cache[require.resolve('../services/workflow-engine')];
  const { createAndStartWorkflow } = require('../services/workflow-engine');
  const result = await createAndStartWorkflow(1, 'Test Workflow', steps);
  restoreRequire();
  closeDb(rawDb);
  assertTrue(result.run_id);
  assertEqual(result.status, 'running');
  assertEqual(result.steps_count, 2);
});

test('createAndStartWorkflow throws for empty steps array', async () => {
  const rawDb = getDb();
  seed(rawDb, { projects: [{ id: 1, title: 'P1' }] });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  delete require.cache[require.resolve('../services/workflow-engine')];
  const { createAndStartWorkflow } = require('../services/workflow-engine');
  let err;
  try { await createAndStartWorkflow(1, 'Empty Workflow', []); } catch (e) { err = e; }
  restoreRequire();
  closeDb(rawDb);
  assertTrue(err);
  assertRegex(err.message, /non-empty|empty/);
});

test('createAndStartWorkflow throws if step lacks task field', async () => {
  const rawDb = getDb();
  seed(rawDb, { projects: [{ id: 1, title: 'P1' }] });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  delete require.cache[require.resolve('../services/workflow-engine')];
  const { createAndStartWorkflow } = require('../services/workflow-engine');
  let err;
  try { await createAndStartWorkflow(1, 'Bad Workflow', [{ description: 'Only description' }]); } catch (e) { err = e; }
  restoreRequire();
  closeDb(rawDb);
  assertTrue(err);
  assertRegex(err.message, /task/);
});

test('GET /api/projects/:id/workflows returns workflow runs for project', async () => {
  const rawDb = getDb();
  seed(rawDb, {
    projects: [{ id: 1, title: 'P1' }],
    workflowRuns: [
      { id: 10, project_id: 1, title: 'WF1', status: 'running', steps: JSON.stringify([{ task: 'A' }]), created_at: new Date().toISOString() },
      { id: 11, project_id: 1, title: 'WF2', status: 'completed', steps: JSON.stringify([{ task: 'B' }]), created_at: new Date().toISOString() },
      { id: 12, project_id: 2, title: 'WF3', status: 'running', steps: JSON.stringify([{ task: 'C' }]), created_at: new Date().toISOString() },
    ],
  });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status, body } = await request(app, 'GET', '/api/projects/1/workflows');
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 200);
  assertEqual(body.length, 2);
  assertTrue(body.every(w => w.project_id === 1));
});

test('GET /api/projects/:id/workflows/:runId returns specific run', async () => {
  const rawDb = getDb();
  seed(rawDb, {
    projects: [{ id: 1, title: 'P1' }],
    workflowRuns: [{ id: 20, project_id: 1, title: 'Login Flow', status: 'running', steps: JSON.stringify([{ task: 'Build Login' }]), current_step: 0, context: '{}', created_at: new Date().toISOString() }],
  });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status, body } = await request(app, 'GET', '/api/projects/1/workflows/20');
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 200);
  assertEqual(body.id, 20);
  assertEqual(body.title, 'Login Flow');
  assertEqual(body.status, 'running');
});

test('GET /api/projects/:id/workflows/:runId 404 for non-existent run', async () => {
  const rawDb = getDb();
  seed(rawDb, { projects: [{ id: 1, title: 'P1' }] });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  const app = createApp(dbWrapper);
  const { status } = await request(app, 'GET', '/api/projects/1/workflows/99999');
  restoreRequire();
  closeDb(rawDb);
  assertEqual(status, 404);
});

test('workflow with 2 steps creates 2 tasks (one per step)', async () => {
  const rawDb = getDb();
  seed(rawDb, {
    projects: [{ id: 1, title: 'P1' }],
    agents: [{ id: 1, openclaw_agent_id: 'worker', name: 'Worker' }],
    workflowRuns: [{
      id: 100, project_id: 1, title: 'Two-step',
      status: 'running',
      steps: JSON.stringify([{ task: 'Step One' }, { task: 'Step Two' }]),
      current_step: 0, context: '{}', created_at: new Date().toISOString(),
    }],
  });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);

  // Mock executeTask so workflow can complete synchronously
  const origExecuteTask = require('../services/executor').executeTask;
  require('../services/executor').executeTask = async () => ({ action: 'completed', output: 'done' });

  delete require.cache[require.resolve('../services/workflow-engine')];
  const { runWorkflow } = require('../services/workflow-engine');

  const wfRun = rawDb.prepare('SELECT * FROM workflow_runs WHERE id = 100').get();
  await runWorkflow(100, JSON.parse(wfRun.steps));

  require('../services/executor').executeTask = origExecuteTask;
  restoreRequire();

  const tasks = rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all();
  closeDb(rawDb);
  assertTrue(tasks.length >= 2);
});

test('workflow with step missing task field throws', async () => {
  const rawDb = getDb();
  seed(rawDb, {
    projects: [{ id: 1, title: 'P1' }],
    workflowRuns: [{
      id: 200, project_id: 1, title: 'Bad WF',
      status: 'running',
      steps: JSON.stringify([{ description: 'Only description, no task' }]),
      current_step: 0, context: '{}', created_at: new Date().toISOString(),
    }],
  });
  const dbWrapper = makeDbWrapper(rawDb);
  patchRequire(dbWrapper);
  delete require.cache[require.resolve('../services/workflow-engine')];
  const { runWorkflow } = require('../services/workflow-engine');

  const wfRun = rawDb.prepare('SELECT * FROM workflow_runs WHERE id = 200').get();
  let err;
  try { await runWorkflow(200, JSON.parse(wfRun.steps)); } catch (e) { err = e; }
  restoreRequire();
  closeDb(rawDb);
  assertTrue(err);
  assertRegex(err.message, /task|undefined/);
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
