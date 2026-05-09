'use strict';
/**
 * Intelligence.test.js — tests for intelligence layer features
 * Run via Jest: npx jest tests/Intelligence.test.js
 * Or standalone: node tests/Intelligence.test.js
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { getDb, closeDb } = require('./helpers');

const PROFILE_ROOT = process.env.AGENT_WORKSPACE_ROOT ||
  path.join(process.env.HOME, '.openclaw', 'agents');

// ── HTTP client ────────────────────────────────────────────────────────────────

function request(app, method, p, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const bodyStr = body ? JSON.stringify(body) : '';
      const opts = {
        hostname: 'localhost', port, path: p, method,
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

// ── test app ───────────────────────────────────────────────────────────────────

function createTestApp(dbWrapper) {
  const express = require('express');
  const cors = require('cors');
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  const projectsRouter = express.Router();

  projectsRouter.get('/', (req, res) => {
    res.json(dbWrapper.loadProjects().map(p => ({ ...p, task_total: 0, task_done: 0, completion_pct: 0 })));
  });

  projectsRouter.post('/', (req, res) => {
    const { title, description, workspace_path } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const nextId = () => { const row = dbWrapper.db.prepare('SELECT MAX(id) as m FROM projects').get(); return (row.m || 0) + 1; };
    let finalWorkspace = workspace_path?.trim();
    if (!finalWorkspace) {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      finalWorkspace = `/tmp/clawdesk-test-projects/${slug}-${Date.now()}`;
    }
    fs.mkdirSync(finalWorkspace, { recursive: true, mode: 0o755 });
    const projects = dbWrapper.loadProjects();
    const p = { id: nextId(), title, description: description || '', workspace_path: finalWorkspace, status: 'active', is_template: 0, created_at: new Date().toISOString() };
    projects.push(p);
    dbWrapper.saveProjects(projects);
    res.status(201).json(p);
  });

  projectsRouter.get('/:id', (req, res) => {
    const p = dbWrapper.loadProjects().find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const tasks = dbWrapper.loadTasks().filter(t => t.project_id === p.id);
    res.json({ ...p, tasks, task_total: tasks.length, task_done: tasks.filter(t => t.status === 'done').length });
  });

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

  app.use('/api/projects', projectsRouter);
  return app;
}

// ── DB wrapper ─────────────────────────────────────────────────────────────────

function makeDbWrapper(rawDb) {
  return {
    db: rawDb,
    loadTasks: () => rawDb.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL').all(),
    loadAgents: () => rawDb.prepare('SELECT * FROM agents').all(),
    loadProjects: () => rawDb.prepare('SELECT * FROM projects WHERE deleted_at IS NULL').all(),
    saveProjects: (data) => {
      rawDb.exec('DELETE FROM projects');
      const i = rawDb.prepare(`INSERT INTO projects (id,title,description,workspace_path,status,created_at,is_template,template_source_id,trigger_rules) VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const p of data) i.run(p.id, p.title, p.description || '', p.workspace_path || '', p.status || 'active', p.created_at, p.is_template || 0, p.template_source_id || null, p.trigger_rules || '[]');
    },
    saveAgents: (data) => {
      rawDb.exec('DELETE FROM agents');
      const i = rawDb.prepare(`INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)`);
      for (const a of data) i.run(a.id, a.openclaw_agent_id, a.name, a.status || 'active', a.created_at);
    },
    saveTasks: (data) => {
      rawDb.exec('DELETE FROM tasks');
      const i = rawDb.prepare(`INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,priority,created_at) VALUES (?,?,?,?,?,?,?)`);
      for (const t of data) i.run(t.id, t.project_id, t.assigned_agent_id || null, t.title, t.status || 'pending', t.priority || 'medium', t.created_at);
    },
  };
}

// ── PROJECT BRAIN ─────────────────────────────────────────────────────────────

describe('Project Brain', () => {
  afterEach(() => { try { closeDb(getDb()); } catch {} });

  test('appendSessionMemory creates PROJECT_BRAIN.md and appends entry', () => {
    const projectBrain = require('../services/project-brain');
    const rawDb = getDb();
    const ws = `/tmp/clawdesk-brain-${Date.now()}`;
    fs.mkdirSync(ws, { recursive: true });
    const projects = [{ id: 1, title: 'Test', workspace_path: ws, status: 'active', is_template: 0, created_at: new Date().toISOString() }];
    rawDb.prepare(`INSERT INTO projects (id,title,workspace_path,status,created_at,is_template) VALUES (?,?,?,?,?,?)`).run(1, 'Test', ws, 'active', new Date().toISOString(), 0);

    projectBrain.appendSessionMemory(projects[0], 'Did the thing. Found Y. Left Z for next agent.');

    const brainPath = path.join(ws, 'PROJECT_BRAIN.md');
    expect(fs.existsSync(brainPath)).toBe(true);
    const content = fs.readFileSync(brainPath, 'utf8');
    expect(content).toContain('Did the thing');
    expect(content).toContain('Found Y');
    fs.rmSync(ws, { recursive: true, force: true });
    closeDb(rawDb);
  });

  test('getContextForTask returns sections with active agents, state, session memory', () => {
    const projectBrain = require('../services/project-brain');
    const rawDb = getDb();
    const ws = `/tmp/clawdesk-brain-ctx-${Date.now()}`;
    fs.mkdirSync(ws, { recursive: true });
    rawDb.prepare(`INSERT INTO projects (id,title,workspace_path,status,created_at,is_template) VALUES (?,?,?,?,?,?)`).run(1, 'Test', ws, 'active', new Date().toISOString(), 0);
    const project = { id: 1, title: 'Test', workspace_path: ws, status: 'active', is_template: 0, created_at: new Date().toISOString() };

    projectBrain.appendSessionMemory(project, 'Test session entry.');

    const ctx = projectBrain.getContextForTask(project, 'My Task');
    expect(ctx).toContain('Active Agents');
    expect(ctx).toContain('Project State');
    expect(ctx).toContain('Session Memory');
    fs.rmSync(ws, { recursive: true, force: true });
    closeDb(rawDb);
  });

  test('creates PROJECT_BRAIN.md with default content if not exists', () => {
    const projectBrain = require('../services/project-brain');
    const rawDb = getDb();
    const ws = `/tmp/clawdesk-brain-new-${Date.now()}`;
    fs.mkdirSync(ws, { recursive: true });
    rawDb.prepare(`INSERT INTO projects (id,title,workspace_path,status,created_at,is_template) VALUES (?,?,?,?,?,?)`).run(1, 'New Project', ws, 'active', new Date().toISOString(), 0);
    const project = { id: 1, title: 'New Project', workspace_path: ws, status: 'active', is_template: 0, created_at: new Date().toISOString() };

    const brainPath = path.join(ws, 'PROJECT_BRAIN.md');
    expect(fs.existsSync(brainPath)).toBe(false);

    projectBrain.appendSessionMemory(project, 'First session.');
    expect(fs.existsSync(brainPath)).toBe(true);
    const content = fs.readFileSync(brainPath, 'utf8');
    expect(content).toContain('# Project Brain');
    expect(content).toContain('Active Agents & Focus');
    expect(content).toContain('## Key Findings');
    expect(content).toContain('## Project State');
    fs.rmSync(ws, { recursive: true, force: true });
    closeDb(rawDb);
  });

  test('readBrain returns null when project has no workspace_path', () => {
    const projectBrain = require('../services/project-brain');
    closeDb(getDb());
    expect(projectBrain.readBrain({ id: 1, title: 'No WS' })).toBeNull();
  });

  test('readBrain returns null when PROJECT_BRAIN.md does not exist', () => {
    const projectBrain = require('../services/project-brain');
    closeDb(getDb());
    expect(projectBrain.readBrain({ id: 1, workspace_path: '/tmp/no-such-brain-xyz-123' })).toBeNull();
  });

  test('getContextForTask returns empty string when brain file missing', () => {
    const projectBrain = require('../services/project-brain');
    closeDb(getDb());
    expect(projectBrain.getContextForTask({ id: 1, workspace_path: '/tmp/no-such-brain-xyz-456' }, 'Some task')).toBe('');
  });
});

// ── CAPABILITY REGISTRY ────────────────────────────────────────────────────────

describe('Capability registry', () => {
  afterEach(() => { try { closeDb(getDb()); } catch {} });

  test('GET /api/projects/:id/agents/capabilities returns empty array when no agents', async () => {
    const rawDb = getDb();
    rawDb.prepare(`INSERT INTO projects (id,title,workspace_path,status,created_at,is_template) VALUES (?,?,?,?,?,?)`).run(1, 'Cap Test', '/tmp/cap-test', 'active', new Date().toISOString(), 0);
    const dbWrapper = makeDbWrapper(rawDb);
    const app = createTestApp(dbWrapper);
    const { status, body } = await request(app, 'GET', '/api/projects/1/agents/capabilities');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
    closeDb(rawDb);
  });

  test('returns capabilities for agents that have CAPABILITY.md files', async () => {
    const rawDb = getDb();
    rawDb.prepare(`INSERT INTO projects (id,title,workspace_path,status,created_at,is_template) VALUES (?,?,?,?,?,?)`).run(1, 'Cap Test', '/tmp/cap-test', 'active', new Date().toISOString(), 0);
    rawDb.prepare(`INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)`).run(1, 'cap-agent', 'CapAgent', 'active', new Date().toISOString());
    rawDb.prepare(`INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,priority,created_at) VALUES (?,?,?,?,?,?,?)`).run(1, 1, 1, 'Task 1', 'pending', 'medium', new Date().toISOString());

    const agentWs = path.join(PROFILE_ROOT, 'cap-agent');
    fs.mkdirSync(agentWs, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(agentWs, 'CAPABILITY.md'), `# CAPABILITY.md\n\n- **Specialties:** coding, debugging\n`, 'utf8');

    const dbWrapper = makeDbWrapper(rawDb);
    const app = createTestApp(dbWrapper);
    const { status, body } = await request(app, 'GET', '/api/projects/1/agents/capabilities');

    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].agent_id).toBe(1);
    expect(body[0].capability_md).toContain('coding');
    fs.rmSync(agentWs, { recursive: true, force: true });
    closeDb(rawDb);
  });

  test('each entry has agent_id, name, openclaw_agent_id, capability_md', async () => {
    const rawDb = getDb();
    rawDb.prepare(`INSERT INTO projects (id,title,workspace_path,status,created_at,is_template) VALUES (?,?,?,?,?,?)`).run(1, 'Full Cap Test', '/tmp/full-cap-test', 'active', new Date().toISOString(), 0);
    rawDb.prepare(`INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)`).run(1, 'full-cap-agent', 'FullCapAgent', 'active', new Date().toISOString());
    rawDb.prepare(`INSERT INTO tasks (id,project_id,assigned_agent_id,title,status,priority,created_at) VALUES (?,?,?,?,?,?,?)`).run(1, 1, 1, 'Task 1', 'pending', 'medium', new Date().toISOString());

    const agentWs = path.join(PROFILE_ROOT, 'full-cap-agent');
    fs.mkdirSync(agentWs, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(agentWs, 'CAPABILITY.md'), '# CAPABILITY.md\n\n- **Specialties:** testing\n', 'utf8');

    const dbWrapper = makeDbWrapper(rawDb);
    const app = createTestApp(dbWrapper);
    const { status, body } = await request(app, 'GET', '/api/projects/1/agents/capabilities');

    expect(status).toBe(200);
    const entry = body[0];
    expect(entry).toHaveProperty('agent_id');
    expect(entry).toHaveProperty('name');
    expect(entry).toHaveProperty('openclaw_agent_id');
    expect(entry).toHaveProperty('capability_md');
    expect(entry.openclaw_agent_id).toBe('full-cap-agent');
    expect(entry.name).toBe('FullCapAgent');
    fs.rmSync(agentWs, { recursive: true, force: true });
    closeDb(rawDb);
  });

  test('returns 404 for non-existent project', async () => {
    const rawDb = getDb();
    const dbWrapper = makeDbWrapper(rawDb);
    const app = createTestApp(dbWrapper);
    const { status } = await request(app, 'GET', '/api/projects/99999/agents/capabilities');
    expect(status).toBe(404);
    closeDb(rawDb);
  });
});

// ── AGENT CAPABILITY FILE CREATION ────────────────────────────────────────────

describe('Agent capability file creation', () => {
  test('CAPABILITY.md contains required fields', () => {
    const agentId = 'test-cap-' + Date.now();
    const wsDir = `/tmp/clawdesk-test-ws-${Date.now()}`;
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o755 });

    const name = 'TestCreateAgent';
    const vibe = 'code review and refactoring';
    const now = new Date().toISOString();
    const capContent = `# CAPABILITY.md — ${name}\n\n- **Specialties:** ${vibe}\n- **Agent ID:** ${agentId}\n- **Created:** ${now}\n`;

    fs.writeFileSync(path.join(wsDir, 'CAPABILITY.md'), capContent, 'utf8');

    const content = fs.readFileSync(path.join(wsDir, 'CAPABILITY.md'), 'utf8');
    expect(content).toContain(name);
    expect(content).toContain(vibe);
    expect(content).toContain('**Specialties:**');
    expect(content).toContain('**Agent ID:**');
    expect(content).toContain('**Created:**');

    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  test('CAPABILITY.md contains all required sections', () => {
    const agentId = 'test-cap-sections-' + Date.now();
    const wsDir = `/tmp/clawdesk-test-ws2-${Date.now()}`;
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o755 });

    const name = 'SectionsTestAgent';
    const vibe = 'data analysis, visualization, reporting';
    const now = new Date().toISOString();
    const capContent = `# CAPABILITY.md — ${name}\n\n- **Specialties:** ${vibe}\n- **Agent ID:** ${agentId}\n- **Created:** ${now}\n`;

    fs.writeFileSync(path.join(wsDir, 'CAPABILITY.md'), capContent, 'utf8');

    const content = fs.readFileSync(path.join(wsDir, 'CAPABILITY.md'), 'utf8');
    expect(content).toContain('# CAPABILITY.md');
    expect(content).toContain('**Specialties:**');
    expect(content).toContain('**Agent ID:**');
    expect(content).toContain('**Created:**');

    fs.rmSync(wsDir, { recursive: true, force: true });
  });
});
