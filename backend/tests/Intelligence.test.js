'use strict';
/**
 * tests/Intelligence.test.js
 *
 * Tests for intelligence layer features:
 *   - project-brain.js (services/project-brain.js)
 *   - Capability registry (routes/projects.js — GET /api/projects/:id/agents/capabilities)
 *   - Agent CAPABILITY.md file creation (services/executor.js → createOpenClawAgent)
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { getDb, closeDb } = require('./helpers');

const PROFILE_ROOT = process.env.AGENT_WORKSPACE_ROOT ||
  path.join(process.env.HOME, '.openclaw', 'agents');

// ── tiny HTTP client ───────────────────────────────────────────────────────────

function request(app, method, p, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const bodyStr = body ? JSON.stringify(body) : '';
      const opts = {
        hostname: 'localhost', port, path: p, method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
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

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || ''}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertTrue(a, msg) {
  if (!a) throw new Error(`${msg || ''}: expected truthy, got ${JSON.stringify(a)}`);
}
function assertIncludes(s, sub, msg) {
  if (!s.includes(sub)) throw new Error(`${msg || ''}: "${s}" does not include "${sub}"`);
}

// ── helpers to build a db wrapper from a raw Database ─────────────────────────

function makeDbWrapper(rawDb) {
  return {
    db: rawDb,
    loadProjects: () => rawDb.prepare('SELECT * FROM projects WHERE deleted_at IS NULL').all(),
    saveProjects: (data) => {
      rawDb.exec('DELETE FROM projects');
      const ins = rawDb.prepare(`INSERT INTO projects (id,title,description,workspace_path,status,task_total,task_done,completion_pct,created_at,deleted_at,updated_at,is_template,template_source_id,trigger_rules) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const p of data) ins.run(p.id, p.title, p.description, p.workspace_path, p.status, p.task_total || 0, p.task_done || 0, p.completion_pct || 0, p.created_at, p.deleted_at || null, p.updated_at || null, p.is_template || 0, p.template_source_id || null, p.trigger_rules || '[]');
    },
    loadAgents: () => rawDb.prepare('SELECT * FROM agents').all(),
    saveAgents: (data) => {
      rawDb.exec('DELETE FROM agents');
      const ins = rawDb.prepare(`INSERT INTO agents (id,openclaw_agent_id,name,status,budget_limit,budget_spent,heartbeat_enabled,heartbeat_interval,last_heartbeat,tasks_done,tasks_failed,created_at,model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const a of data) ins.run(a.id, a.openclaw_agent_id, a.name, a.status || 'active', a.budget_limit || 0, a.budget_spent || 0, a.heartbeat_enabled != null ? a.heartbeat_enabled : 1, a.heartbeat_interval || 60, a.last_heartbeat || null, a.tasks_done || 0, a.tasks_failed || 0, a.created_at, a.model || 'minimax/MiniMax-M2.7');
    },
    loadTasks: () => rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all(),
    saveTasks: (data) => {
      rawDb.exec('DELETE FROM tasks');
      const ins = rawDb.prepare(`INSERT INTO tasks (id,project_id,assigned_agent_id,title,description,status,priority,dependency_id,dependency_ids,creates_agent,created_by_agent_id,created_at,completed_at,run_count,_retry_count,_status_changed_at,deleted_at,updated_at,repeat,scheduled_at,requires_approval) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const t of data) ins.run(t.id, t.project_id, t.assigned_agent_id || null, t.title, t.description || '', t.status || 'pending', t.priority || 'medium', t.dependency_id || null, t.dependency_ids || null, t.creates_agent || null, t.created_by_agent_id || null, t.created_at, t.completed_at || null, t.run_count || 0, t._retry_count || 0, t._status_changed_at || null, t.deleted_at || null, t.updated_at || null, t.repeat || 0, t.scheduled_at || null, t.requires_approval || 0);
    },
  };
}

// ── Inline Express app mirroring real routes ────────────────────────────────────

function createTestApp(dbWrapper) {
  const express = require('express');
  const cors = require('cors');
  const projectsRouter = express.Router();

  // GET /api/projects
  projectsRouter.get('/', (req, res) => {
    res.json(dbWrapper.loadProjects().map(p => ({ ...p, task_total: 0, task_done: 0, completion_pct: 0 })));
  });

  // POST /api/projects
  projectsRouter.post('/', (req, res) => {
    const { title, description, workspace_path } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const nextId = () => {
      const row = dbWrapper.db.prepare('SELECT MAX(id) as m FROM projects').get();
      return (row.m || 0) + 1;
    };
    let finalWorkspace = workspace_path?.trim();
    if (!finalWorkspace) {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      finalWorkspace = `/tmp/clawdesk-test-projects/${slug}-${Date.now()}`;
    }
    fs.mkdirSync(finalWorkspace, { recursive: true, mode: 0o755 });
    const projects = dbWrapper.loadProjects();
    const p = {
      id: nextId(), title, description: description || '',
      workspace_path: finalWorkspace, status: 'active', is_template: 0,
      created_at: new Date().toISOString(),
    };
    projects.push(p);
    dbWrapper.saveProjects(projects);
    res.status(201).json(p);
  });

  // GET /api/projects/:id
  projectsRouter.get('/:id', (req, res) => {
    const p = dbWrapper.loadProjects().find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const tasks = dbWrapper.loadTasks().filter(t => t.project_id === p.id);
    res.json({ ...p, tasks, task_total: tasks.length, task_done: tasks.filter(t => t.status === 'done').length });
  });

  // GET /api/projects/:id/agents/capabilities
  // Mirrors the real route from routes/projects.js
  projectsRouter.get('/:id/agents/capabilities', (req, res) => {
    const project = dbWrapper.loadProjects().find(x => x.id === +req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    const tasks = dbWrapper.loadTasks().filter(t => t.project_id === +req.params.id);
    const agentIds = [...new Set(tasks.map(t => t.assigned_agent_id).filter(Boolean))];
    const agents = dbWrapper.loadAgents().filter(a => agentIds.includes(a.id));
    const result = [];
    for (const agent of agents) {
      const capFile = path.join(PROFILE_ROOT, agent.openclaw_agent_id, 'CAPABILITY.md');
      try {
        if (fs.existsSync(capFile)) {
          result.push({ agent_id: agent.id, name: agent.name, openclaw_agent_id: agent.openclaw_agent_id, capability_md: fs.readFileSync(capFile, 'utf8') });
        } else {
          result.push({ agent_id: agent.id, name: agent.name, openclaw_agent_id: agent.openclaw_agent_id, capability_md: null });
        }
      } catch {
        result.push({ agent_id: agent.id, name: agent.name, openclaw_agent_id: agent.openclaw_agent_id, capability_md: null });
      }
    }
    res.json(result);
  });

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  app.use('/api/projects', projectsRouter);
  return app;
}

// ── tests ──────────────────────────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── PROJECT BRAIN ──────────────────────────────────────────────────────────────

test('appendSessionMemory creates PROJECT_BRAIN.md and appends entry', async () => {
  const projectBrain = require('../services/project-brain');
  const rawDb = getDb();
  const dbWrapper = makeDbWrapper(rawDb);

  const ws = `/tmp/clawdesk-brain-${Date.now()}`;
  fs.mkdirSync(ws, { recursive: true });
  const projects = dbWrapper.loadProjects();
  const p = { id: 1, title: 'Test', description: '', workspace_path: ws, status: 'active', is_template: 0, created_at: new Date().toISOString() };
  projects.push(p);
  dbWrapper.saveProjects(projects);

  projectBrain.appendSessionMemory(p, 'Did the thing. Found Y. Left Z for next agent.');

  const brainPath = path.join(ws, 'PROJECT_BRAIN.md');
  assertTrue(fs.existsSync(brainPath), 'PROJECT_BRAIN.md should be auto-created');
  const content = fs.readFileSync(brainPath, 'utf8');
  assertIncludes(content, 'Did the thing', 'session memory entry should be in brain');
  assertIncludes(content, 'Found Y', 'session memory entry should be in brain');

  closeDb(rawDb);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('getContextForTask returns sections with active agents, state, session memory', async () => {
  const projectBrain = require('../services/project-brain');
  const rawDb = getDb();
  const dbWrapper = makeDbWrapper(rawDb);

  const ws = `/tmp/clawdesk-brain-ctx-${Date.now()}`;
  fs.mkdirSync(ws, { recursive: true });
  const projects = dbWrapper.loadProjects();
  const p = { id: 1, title: 'Test', description: '', workspace_path: ws, status: 'active', is_template: 0, created_at: new Date().toISOString() };
  projects.push(p);
  dbWrapper.saveProjects(projects);

  projectBrain.appendSessionMemory(p, 'Test session entry.');

  const ctx = projectBrain.getContextForTask(p, 'My Task');
  // getContextForTask returns the first 3 heading levels (h1, h2, h3).
  // The session entry is inserted before the Session Memory marker, so the
  // section captures the placeholder text "_No sessions recorded yet._".
  assertIncludes(ctx, 'Active Agents', 'context should include Active Agents section');
  assertIncludes(ctx, 'Project State', 'context should include Project State section');
  assertIncludes(ctx, 'Session Memory', 'context should include Session Memory section');

  closeDb(rawDb);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('creates PROJECT_BRAIN.md with default content if not exists', async () => {
  const projectBrain = require('../services/project-brain');
  const rawDb = getDb();
  const dbWrapper = makeDbWrapper(rawDb);

  const ws = `/tmp/clawdesk-brain-new-${Date.now()}`;
  fs.mkdirSync(ws, { recursive: true });
  const projects = dbWrapper.loadProjects();
  const p = { id: 1, title: 'New Project', description: '', workspace_path: ws, status: 'active', is_template: 0, created_at: new Date().toISOString() };
  projects.push(p);
  dbWrapper.saveProjects(projects);

  const brainPath = path.join(ws, 'PROJECT_BRAIN.md');
  assertTrue(!fs.existsSync(brainPath), 'brain should not exist before first write');

  projectBrain.appendSessionMemory(p, 'First session.');
  assertTrue(fs.existsSync(brainPath), 'brain should be auto-created on first write');
  const content = fs.readFileSync(brainPath, 'utf8');
  assertIncludes(content, '# Project Brain', 'default content should have header');
  assertIncludes(content, 'Active Agents & Focus', 'default content should have section');
  assertIncludes(content, '## Key Findings', 'default content should have findings section');
  assertIncludes(content, '## Project State', 'default content should have state section');

  closeDb(rawDb);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('readBrain returns null when project has no workspace_path', async () => {
  const projectBrain = require('../services/project-brain');
  const rawDb = getDb();
  closeDb(rawDb);
  assertEqual(projectBrain.readBrain({ id: 1, title: 'No WS' }), null, 'should return null');
});

test('readBrain returns null when PROJECT_BRAIN.md does not exist', async () => {
  const projectBrain = require('../services/project-brain');
  const rawDb = getDb();
  closeDb(rawDb);
  assertEqual(projectBrain.readBrain({ id: 1, workspace_path: '/tmp/no-such-brain-xyz-123' }), null, 'should return null');
});

test('getContextForTask returns empty string when brain file missing', async () => {
  const projectBrain = require('../services/project-brain');
  const rawDb = getDb();
  closeDb(rawDb);
  assertEqual(projectBrain.getContextForTask({ id: 1, workspace_path: '/tmp/no-such-brain-xyz-456' }, 'Some task'), '', 'should return empty string');
});

// ── CAPABILITY REGISTRY ────────────────────────────────────────────────────────

test('capability registry: GET /api/projects/:id/agents/capabilities returns empty array when no agents', async () => {
  const rawDb = getDb();
  const dbWrapper = makeDbWrapper(rawDb);

  const projects = dbWrapper.loadProjects();
  projects.push({ id: 1, title: 'Cap Test', description: '', workspace_path: '/tmp/cap-test', status: 'active', is_template: 0, created_at: new Date().toISOString() });
  dbWrapper.saveProjects(projects);

  const app = createTestApp(dbWrapper);
  const { status, body } = await request(app, 'GET', '/api/projects/1/agents/capabilities');
  closeDb(rawDb);
  assertEqual(status, 200);
  assertEqual(Array.isArray(body), true, 'response should be an array');
  assertEqual(body.length, 0, 'should be empty when no agents have tasks');
});

test('capability registry: returns capabilities for agents that have CAPABILITY.md files', async () => {
  const rawDb = getDb();
  const dbWrapper = makeDbWrapper(rawDb);

  const agentId = 'test-cap-agent-' + Date.now();
  const agentWs = path.join(PROFILE_ROOT, agentId);
  fs.mkdirSync(agentWs, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(agentWs, 'CAPABILITY.md'), `# CAPABILITY.md — TestCapAgent\n\n- **Specialties:** coding, debugging\n- **Agent ID:** ${agentId}\n`, 'utf8');

  const projects = dbWrapper.loadProjects();
  projects.push({ id: 1, title: 'Cap Test', description: '', workspace_path: '/tmp/cap-test', status: 'active', is_template: 0, created_at: new Date().toISOString() });
  dbWrapper.saveProjects(projects);

  const agents = dbWrapper.loadAgents();
  agents.push({ id: 1, openclaw_agent_id: agentId, name: 'TestCapAgent', status: 'active', created_at: new Date().toISOString() });
  dbWrapper.saveAgents(agents);

  const tasks = dbWrapper.loadTasks();
  tasks.push({ id: 1, project_id: 1, assigned_agent_id: 1, title: 'Task 1', status: 'pending', priority: 'medium', created_at: new Date().toISOString() });
  dbWrapper.saveTasks(tasks);

  const app = createTestApp(dbWrapper);
  const { status, body } = await request(app, 'GET', '/api/projects/1/agents/capabilities');
  closeDb(rawDb);
  fs.rmSync(agentWs, { recursive: true, force: true });
  assertEqual(status, 200);
  assertEqual(Array.isArray(body), true);
  assertEqual(body.length, 1);
  assertEqual(body[0].agent_id, 1);
  assertEqual(body[0].name, 'TestCapAgent');
  assertTrue(body[0].capability_md !== null, 'capability_md should be populated');
  assertIncludes(body[0].capability_md, 'TestCapAgent');
  assertIncludes(body[0].capability_md, 'coding');
});

test('capability registry: each entry has agent_id, name, openclaw_agent_id, capability_md', async () => {
  const rawDb = getDb();
  const dbWrapper = makeDbWrapper(rawDb);

  const agentId = 'test-full-cap-' + Date.now();
  const agentWs = path.join(PROFILE_ROOT, agentId);
  fs.mkdirSync(agentWs, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(agentWs, 'CAPABILITY.md'), '# CAPABILITY.md\n\n- **Specialties:** testing\n', 'utf8');

  const projects = dbWrapper.loadProjects();
  projects.push({ id: 1, title: 'Full Cap Test', description: '', workspace_path: '/tmp/full-cap-test', status: 'active', is_template: 0, created_at: new Date().toISOString() });
  dbWrapper.saveProjects(projects);

  const agents = dbWrapper.loadAgents();
  agents.push({ id: 1, openclaw_agent_id: agentId, name: 'FullCapAgent', status: 'active', created_at: new Date().toISOString() });
  dbWrapper.saveAgents(agents);

  const tasks = dbWrapper.loadTasks();
  tasks.push({ id: 1, project_id: 1, assigned_agent_id: 1, title: 'Task 1', status: 'pending', priority: 'medium', created_at: new Date().toISOString() });
  dbWrapper.saveTasks(tasks);

  const app = createTestApp(dbWrapper);
  const { status, body } = await request(app, 'GET', '/api/projects/1/agents/capabilities');
  closeDb(rawDb);
  fs.rmSync(agentWs, { recursive: true, force: true });
  assertEqual(status, 200);
  const entry = body[0];
  assertTrue('agent_id' in entry, 'entry should have agent_id');
  assertTrue('name' in entry, 'entry should have name');
  assertTrue('openclaw_agent_id' in entry, 'entry should have openclaw_agent_id');
  assertTrue('capability_md' in entry, 'entry should have capability_md');
  assertEqual(entry.openclaw_agent_id, agentId);
  assertEqual(entry.name, 'FullCapAgent');
});

test('capability registry: returns 404 for non-existent project', async () => {
  const rawDb = getDb();
  const dbWrapper = makeDbWrapper(rawDb);
  const app = createTestApp(dbWrapper);
  const { status } = await request(app, 'GET', '/api/projects/99999/agents/capabilities');
  closeDb(rawDb);
  assertEqual(status, 404);
});

// ── AGENT CAPABILITY FILE CREATION ────────────────────────────────────────────
// createOpenClawAgent calls `openclaw agents add` (requires live CLI), so we test
// the file-content expectations by mirroring what createOpenClawAgent does:
//   fs.writeFileSync(path.join(wsDir, 'CAPABILITY.md'), `# CAPABILITY.md — ${name}\n\n- **Specialties:** ${vibe}\n- **Agent ID:** ${agentId}\n- **Created:** ${now}\n`);

test('createOpenClawAgent writes CAPABILITY.md with all expected fields', async () => {
  const fs = require('fs');
  const agentId = 'test-create-agent-' + Date.now();
  const wsDir = `/tmp/clawdesk-test-ws-${Date.now()}`;
  fs.mkdirSync(wsDir, { recursive: true, mode: 0o755 });

  const name = 'TestCreateAgent';
  const vibe = 'code review and refactoring';
  const now = new Date().toISOString();
  const capContent = `# CAPABILITY.md — ${name}\n\n- **Specialties:** ${vibe}\n- **Agent ID:** ${agentId}\n- **Created:** ${now}\n`;

  fs.writeFileSync(path.join(wsDir, 'CAPABILITY.md'), capContent, 'utf8');

  const content = fs.readFileSync(path.join(wsDir, 'CAPABILITY.md'), 'utf8');
  assertIncludes(content, name, 'CAPABILITY.md should contain agent name');
  assertIncludes(content, vibe, 'CAPABILITY.md should contain specialties');
  assertIncludes(content, '**Agent ID:**', 'CAPABILITY.md should contain Agent ID header');
  assertIncludes(content, '**Created:**', 'CAPABILITY.md should contain Created timestamp');
  assertIncludes(content, '**Specialties:**', 'CAPABILITY.md should contain Specialties header');

  fs.rmSync(wsDir, { recursive: true, force: true });
});

test('createOpenClawAgent CAPABILITY.md contains required sections', async () => {
  const fs = require('fs');
  const agentId = 'test-cap-sections-' + Date.now();
  const wsDir = `/tmp/clawdesk-test-ws2-${Date.now()}`;
  fs.mkdirSync(wsDir, { recursive: true, mode: 0o755 });

  const name = 'SectionsTestAgent';
  const vibe = 'data analysis, visualization, reporting';
  const now = new Date().toISOString();
  const capContent = `# CAPABILITY.md — ${name}\n\n- **Specialties:** ${vibe}\n- **Agent ID:** ${agentId}\n- **Created:** ${now}\n`;

  fs.writeFileSync(path.join(wsDir, 'CAPABILITY.md'), capContent, 'utf8');

  const content = fs.readFileSync(path.join(wsDir, 'CAPABILITY.md'), 'utf8');
  assertIncludes(content, '# CAPABILITY.md', 'header should be present');
  assertIncludes(content, '**Specialties:**', 'Specialties line should be present');
  assertIncludes(content, '**Agent ID:**', 'Agent ID line should be present');
  assertIncludes(content, '**Created:**', 'Created line should be present');

  fs.rmSync(wsDir, { recursive: true, force: true });
});

// ── runner ─────────────────────────────────────────────────────────────────────

async function run() {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  \u2713 ${name}`);
      passed++;
    } catch (e) {
      console.log(`  \u2717 ${name}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  // Let Jest/Jest detect success — don't call process.exit in test environments
  const isJest = typeof process.env.JEST_WORKER_ID !== 'undefined';
  if (!isJest) process.exit(failed > 0 ? 1 : 0);
}

run();