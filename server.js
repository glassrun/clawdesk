const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const yaml = require('js-yaml');

const app = express();
const PORT = process.env.PORT || 3777;
const OPENCLAW_CLI = '/home/openclaw/.npm-global/bin/openclaw';
const DATA_DIR = path.join(__dirname, 'data');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===================== YAML STORAGE =====================

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadYaml(file) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return [];
  try { return yaml.load(fs.readFileSync(fp, 'utf8')) || []; } catch { return []; }
}

function saveYaml(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), yaml.dump(data, { lineWidth: -1, noRefs: true }));
}

function nextId(arr) { return arr.length > 0 ? Math.max(...arr.map(x => x.id)) + 1 : 1; }

// ===================== OPENCLAW HELPERS =====================

function runOpenClawAgent(agentId, message, timeout = 120000, cwd) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(DATA_DIR, `.task-msg-${Date.now()}.tmp`);
    fs.writeFileSync(tmpFile, message);
    const cdPrefix = cwd ? `cd '${cwd}' && ` : '';
    const cmd = `${cdPrefix}${OPENCLAW_CLI} agent --agent "${agentId}" --message "$(cat '${tmpFile}')" --json --timeout ${Math.floor(timeout / 1000)}`;
    exec(cmd, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // Clean up temp file
      try { fs.unlinkSync(tmpFile); } catch {}
      let result = null;
      if (stdout && stdout.trim()) { try { result = JSON.parse(stdout.trim()); } catch {} }
      if (result && result.status === 'ok') return resolve(result);
      if (result && !err) return resolve(result);
      if (err && result) return resolve(result);
      const errMsg = err ? err.message : 'openclaw agent returned no output';
      const stderrSnippet = stderr ? stderr.trim().substring(0, 500) : '';
      reject(new Error(`${errMsg}${stderrSnippet ? '\n' + stderrSnippet : ''}`));
    });
  });
}

function createOpenClawAgent(agentId, name, workspace, opts = {}) {
  return new Promise((resolve, reject) => {
    const wsDir = workspace || path.join(process.env.HOME, `.openclaw/workspace-${agentId}`);
    fs.mkdirSync(wsDir, { recursive: true });

    // Write identity files
    const emoji = opts.emoji || '🤖';
    const vibe = opts.vibe || 'helpful and focused';
    fs.writeFileSync(path.join(wsDir, 'IDENTITY.md'), `# IDENTITY.md\n\n- **Name:** ${name}\n- **Role:** ${opts.role || 'Ops'}\n- **Creature:** AI agent\n- **Vibe:** ${vibe}\n- **Emoji:** ${emoji}\n`);
    fs.writeFileSync(path.join(wsDir, 'SOUL.md'), `# SOUL.md\n\nYou are ${name}. ${vibe}. Be resourceful, direct, and actually do the work — don't just say you did.\n`);
    fs.writeFileSync(path.join(wsDir, 'USER.md'), `# USER.md\n\nS is your operator. Listen carefully. Execute precisely. No filler.\n`);

    const cmd = `${OPENCLAW_CLI} agents add "${agentId}" --non-interactive --workspace "${wsDir}" --json`;
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      if (err && !output.includes('already exists')) return reject(new Error(`Failed: ${err.message}\n${output.substring(0, 500)}`));
      const identityCmd = `${OPENCLAW_CLI} agents set-identity --agent "${agentId}" --name "${name.replace(/"/g, '\\"')}" --json`;
      exec(identityCmd, { timeout: 15000 }, () => resolve({ agentId, workspace: wsDir, output: output.substring(0, 500) }));
    });
  });
}

function syncFromOpenClaw() {
  return new Promise((resolve, reject) => {
    exec(`${OPENCLAW_CLI} agents list`, { timeout: 15000 }, (err, stdout, stderr) => {
      const output = (stderr || '') + (stdout || '');
      const agentIds = [...new Set(output.split('\n').map(l => l.trim()).filter(l => l.match(/^-\s+(\S+)/)).map(l => l.match(/^-\s+(\S+)/)[1]))];
      if (agentIds.length === 0 && err) return reject(new Error(`Failed: ${err.message}`));
      const agents = loadYaml('agents.yaml');
      const known = { 'main': { name: 'Zava', role: 'CEO', heartbeat_enabled: true, heartbeat_interval: 60 }, 'project-manager': { name: 'Orion', role: 'Strategy', heartbeat_enabled: true, heartbeat_interval: 30 }, 'content-studio': { name: 'Content Studio', role: 'Creative', heartbeat_enabled: true, heartbeat_interval: 30 } };
      for (const id of agentIds) {
        const existing = agents.find(a => a.openclaw_agent_id === id);
        const k = known[id];
        if (existing) {
          existing.status = 'active';
          if (k) { existing.heartbeat_enabled = k.heartbeat_enabled; existing.heartbeat_interval = k.heartbeat_interval; }
        } else {
          agents.push({
            id: nextId(agents), openclaw_agent_id: id,
            name: k ? k.name : id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
            role: k ? k.role : 'Ops', status: 'active',
            budget_limit: 0, budget_spent: 0,
            heartbeat_enabled: k ? k.heartbeat_enabled : false,
            heartbeat_interval: k ? k.heartbeat_interval : 30,
            last_heartbeat: null, created_at: new Date().toISOString()
          });
        }
      }
      saveYaml('agents.yaml', agents);
      resolve({ synced: agentIds });
    });
  });
}

// ===================== SEED =====================

function seed() {
  const projects = loadYaml('projects.yaml');
  if (projects.length > 0) return;
  const agents = loadYaml('agents.yaml');
  const agentMap = {}; agents.forEach(a => { agentMap[a.openclaw_agent_id] = a.id; });

  const now = new Date().toISOString();
  saveYaml('projects.yaml', [
    { id: 1, title: 'Launch Q2 Campaign', description: 'Prepare and execute the Q2 marketing campaign across all channels.', workspace_path: '', status: 'active', created_at: now },
    { id: 2, title: 'Internal Tooling Upgrade', description: 'Modernize internal dashboards and automation scripts.', workspace_path: '', status: 'active', created_at: now }
  ]);

  let tid = 0;
  const t = (pid, agent, title, desc, status, dep) => ({ id: ++tid, project_id: pid, assigned_agent_id: agentMap[agent] || null, title, description: desc, status, dependency_id: dep, creates_agent: null, created_by_agent_id: null, created_at: now, completed_at: status === 'done' ? now : null });
  saveYaml('tasks.yaml', [
    t(1, 'content-studio', 'Design campaign visuals', 'Create banner ads, social media graphics, and email templates', 'in_progress', null),
    t(1, 'main', 'Review campaign strategy', 'Review and approve Q2 strategy and budget', 'pending', null),
    t(1, 'project-manager', 'Set up tracking', 'Install analytics tracking on landing pages', 'pending', null),
    t(1, 'content-studio', 'Write ad copy', 'Draft copy for all Q2 ad placements', 'pending', 1),
    t(1, 'main', 'Final launch approval', 'Final review and sign-off', 'pending', 4),
    t(2, 'project-manager', 'Audit current dashboards', 'Document existing dashboard inventory', 'done', null),
    t(2, 'content-studio', 'Design new dashboard layout', 'Create wireframes for updated dashboards', 'in_progress', 6),
    t(2, 'project-manager', 'Implement dashboard backend', 'Build API endpoints for new dashboard data', 'pending', 7),
    t(2, 'main', 'Approve dashboard budget', 'Review and approve budget for rebuild', 'pending', null)
  ]);
  saveYaml('heartbeats.yaml', []);
  saveYaml('task_results.yaml', []);
}

// Init: sync agents then seed
if (loadYaml('agents.yaml').length === 0) {
  syncFromOpenClaw().then(r => { console.log('[Seed] Synced:', r.synced.join(', ')); seed(); }).catch(e => {
    console.log('[Seed] Fallback:', e.message);
    const now = new Date().toISOString();
    saveYaml('agents.yaml', [
      { id: 1, openclaw_agent_id: 'main', name: 'Zava', role: 'CEO', status: 'active', budget_limit: 5000, budget_spent: 0, heartbeat_enabled: true, heartbeat_interval: 60, last_heartbeat: null, created_at: now },
      { id: 2, openclaw_agent_id: 'project-manager', name: 'Orion', role: 'Strategy', status: 'active', budget_limit: 3000, budget_spent: 0, heartbeat_enabled: true, heartbeat_interval: 30, last_heartbeat: null, created_at: now },
      { id: 3, openclaw_agent_id: 'content-studio', name: 'Content Studio', role: 'Creative', status: 'active', budget_limit: 2000, budget_spent: 0, heartbeat_enabled: true, heartbeat_interval: 30, last_heartbeat: null, created_at: now }
    ]);
    seed();
  });
}

// ===================== HEARTBEAT ENGINE =====================

async function executeTask(agent, task) {
  const projects = loadYaml('projects.yaml');
  const project = projects.find(p => p.id === task.project_id);

  let message = `You are working on a project task. DO the work - do not just say "Done."`;
  message += `\nUse your tools (read, write, exec, web_search, web_fetch) to actually complete the task.`;
  message += `\nYour working directory is the project workspace. Read and write files here.`;
  message += `\nWhen finished, list every file you created with its path.`;
  message += `\n`;
  if (project) {
    message += `\nProject: ${project.title} - ${project.description}`;
  }
  message += `\nTask: ${task.title}`;
  if (task.description) message += `\n${task.description}`;

  // Make agent aware of task creation mechanism
  message += `\n\n--- TOOLS ---`;
  message += `\nYou can create new tasks for this project via HTTP POST:`;
  message += `\nURL: http://localhost:3777/api/projects/${task.project_id}/tasks/from-agent`;
  message += `\nBody (JSON): { agent_id: "${agent.openclaw_agent_id}", title: "task title", description: "details", assigned_to_agent_id: "target-agent" }`;
  message += `\nValid agent IDs: ${loadYaml('agents.yaml').map(a => a.openclaw_agent_id).join(', ')}`;
  message += `\nIMPORTANT: assigned_to_agent_id is REQUIRED. Pick the agent who should do the work.`;
  message += `\nTo create MULTIPLE tasks, make MULTIPLE calls - one endpoint call per task.`;
  message += `\nUse this to break down complex work into subtasks or delegate to other agents.`;
  message += `\n`;
  message += `\nYou can also create new agents for this project via HTTP POST:`;
  message += `\nURL: http://localhost:3777/api/agents`;
  message += `\nBody (JSON): { job_title: "Senior Security Engineer", job_description: "Penetration testing, audits..." }`;
  message += `\nThis creates the agent, its workspace, identity files, and registers it with OpenClaw.`;
  message += `\nAfter creating an agent, you can assign tasks to it using the task creation endpoint above.`;

  let createdAgentInfo = null;

  // Feature 2: Task can create an agent before execution
  if (task.creates_agent) {
    try {
      const oc = await createOpenClawAgent(task.creates_agent, task.creates_agent, null, { role: 'Ops' });
      const agents = loadYaml('agents.yaml');
      if (!agents.find(a => a.openclaw_agent_id === task.creates_agent)) {
        agents.push({
          id: nextId(agents), openclaw_agent_id: task.creates_agent,
          name: task.creates_agent.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
          role: 'Ops', status: 'active',
          budget_limit: 0, budget_spent: 0,
          heartbeat_enabled: 1, heartbeat_interval: 30,
          last_heartbeat: null, created_at: new Date().toISOString()
        });
        saveYaml('agents.yaml', agents);
      }
      createdAgentInfo = { agent_id: task.creates_agent, workspace: oc.workspace };
      message += `\n[Created agent: ${task.creates_agent}]`;
    } catch (e) {
      createdAgentInfo = { agent_id: task.creates_agent, error: e.message };
    }
  }

  try {
    const result = await runOpenClawAgent(agent.openclaw_agent_id, message, 120000, project?.workspace_path);
    const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    // Update task
    const tasks = loadYaml('tasks.yaml');
    const t = tasks.find(x => x.id === task.id);
    if (t) { t.status = 'done'; t.completed_at = new Date().toISOString(); }
    saveYaml('tasks.yaml', tasks);
    // Store result
    const results = loadYaml('task_results.yaml');
    const resultObj = { id: nextId(results), task_id: task.id, agent_id: agent.id, input: message, output, executed_at: new Date().toISOString() };
    if (createdAgentInfo) resultObj.created_agent = createdAgentInfo;
    results.push(resultObj);
    saveYaml('task_results.yaml', results);
    const ret = { action: 'completed', task_id: task.id, task_title: task.title, agent_id: agent.openclaw_agent_id };
    if (createdAgentInfo) ret.created_agent = createdAgentInfo;
    return ret;
  } catch (err) {
    const tasks = loadYaml('tasks.yaml');
    const t = tasks.find(x => x.id === task.id);
    if (t) { t.status = 'failed'; }
    saveYaml('tasks.yaml', tasks);
    const results = loadYaml('task_results.yaml');
    const resultObj = { id: nextId(results), task_id: task.id, agent_id: agent.id, input: message, output: `Error: ${err.message}`, executed_at: new Date().toISOString() };
    if (createdAgentInfo) resultObj.created_agent = createdAgentInfo;
    results.push(resultObj);
    saveYaml('task_results.yaml', results);
    const ret = { action: 'failed', task_id: task.id, task_title: task.title, agent_id: agent.openclaw_agent_id, error: err.message };
    if (createdAgentInfo) ret.created_agent = createdAgentInfo;
    return ret;
  }
}

async function triggerHeartbeat(agent) {
  const tasks = loadYaml('tasks.yaml');
  const pending = tasks.filter(t => t.assigned_agent_id === agent.id && t.status === 'pending' && (!t.dependency_id || tasks.find(d => d.id === t.dependency_id)?.status === 'done')).sort((a, b) => a.id - b.id);
  if (pending.length === 0) {
    const agents = loadYaml('agents.yaml');
    const a = agents.find(x => x.id === agent.id);
    if (a) a.last_heartbeat = new Date().toISOString();
    saveYaml('agents.yaml', agents);
    const hbs = loadYaml('heartbeats.yaml');
    hbs.push({ id: nextId(hbs), agent_id: agent.id, triggered_at: new Date().toISOString(), action_taken: JSON.stringify({ action: 'no_pending_tasks' }), status: 'idle' });
    saveYaml('heartbeats.yaml', hbs);
    return { agent: agent.name, action: 'idle' };
  }
  const task = pending[0];
  // Mark in_progress
  const allTasks = loadYaml('tasks.yaml');
  const t = allTasks.find(x => x.id === task.id);
  if (t) t.status = 'in_progress';
  saveYaml('tasks.yaml', allTasks);
  try {
    const result = await executeTask(agent, task);
    const agents = loadYaml('agents.yaml');
    const a = agents.find(x => x.id === agent.id);
    if (a) a.last_heartbeat = new Date().toISOString();
    saveYaml('agents.yaml', agents);
    const hbs = loadYaml('heartbeats.yaml');
    hbs.push({ id: nextId(hbs), agent_id: agent.id, triggered_at: new Date().toISOString(), action_taken: JSON.stringify(result), status: result.action === 'failed' ? 'error' : 'ok' });
    saveYaml('heartbeats.yaml', hbs);
    return { agent: agent.name, ...result };
  } catch (err) {
    const tasks2 = loadYaml('tasks.yaml');
    const t2 = tasks2.find(x => x.id === task.id);
    if (t2) t2.status = 'pending';
    saveYaml('tasks.yaml', tasks2);
    const agents = loadYaml('agents.yaml');
    const a = agents.find(x => x.id === agent.id);
    if (a) a.last_heartbeat = new Date().toISOString();
    saveYaml('agents.yaml', agents);
    const hbs = loadYaml('heartbeats.yaml');
    hbs.push({ id: nextId(hbs), agent_id: agent.id, triggered_at: new Date().toISOString(), action_taken: JSON.stringify({ action: 'error', error: err.message }), status: 'error' });
    saveYaml('heartbeats.yaml', hbs);
    return { agent: agent.name, action: 'error', error: err.message };
  }
}

async function runHeartbeatCycle() {
  // Reset stuck tasks
  const tasks = loadYaml('tasks.yaml');
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  let changed = false;
  for (const t of tasks) {
    if (t.status === 'in_progress' && t.created_at < tenMinAgo) { t.status = 'pending'; changed = true; }
  }
  if (changed) saveYaml('tasks.yaml', tasks);

  const now = new Date();
  const agents = loadYaml('agents.yaml').filter(a => a.heartbeat_enabled && a.status === 'active');
  const results = [];
  for (const agent of agents) {
    if (!agent.last_heartbeat) { results.push(await triggerHeartbeat(agent)); continue; }
    if ((now - new Date(agent.last_heartbeat)) / 60000 >= agent.heartbeat_interval) { results.push(await triggerHeartbeat(agent)); }
  }
  return results;
}

function startHeartbeatEngine() {
  setInterval(async () => {
    try { const r = await runHeartbeatCycle(); if (r.length > 0) console.log(`[Heartbeat] ${r.map(x => `${x.agent}→${x.action}`).join(', ')}`); } catch (e) { console.error('[Heartbeat]', e.message); }
  }, 60000);
  console.log('[Heartbeat] Engine started (60s interval)');
}

// ===================== API =====================

// Sync
app.post('/api/agents/sync', async (req, res) => {
  try { const r = await syncFromOpenClaw(); res.json({ ok: true, synced: r.synced, count: r.synced.length }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Agents CRUD
app.get('/api/agents', (req, res) => { res.json(loadYaml('agents.yaml')); });
app.post('/api/agents', async (req, res) => {
  const { job_title, job_description, openclaw_agent_id, name, role, status, budget_limit, heartbeat_enabled, heartbeat_interval } = req.body;

  // New format: job_title only (auto-generates everything)
  const title = job_title || name;
  const desc = job_description || '';
  const agentId = openclaw_agent_id || (title ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '');

  if (!title) return res.status(400).json({ error: 'job_title required' });
  try {
    const agents = loadYaml('agents.yaml');
    if (agents.find(a => a.openclaw_agent_id === agentId)) return res.status(409).json({ error: 'Agent already exists' });
    const oc = await createOpenClawAgent(agentId, title, null, { vibe: desc, role: 'Ops' });
    const agent = { id: nextId(agents), openclaw_agent_id: agentId, name: title, role: role || 'Ops', status: status || 'idle', budget_limit: budget_limit || 0, budget_spent: 0, heartbeat_enabled: 1, heartbeat_interval: heartbeat_interval || 30, last_heartbeat: null, created_at: new Date().toISOString() };
    agents.push(agent);
    saveYaml('agents.yaml', agents);
    res.status(201).json({ ...agent, openclaw: oc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/agents/:id', (req, res) => { const a = loadYaml('agents.yaml').find(x => x.id === +req.params.id); a ? res.json(a) : res.status(404).json({ error: 'not found' }); });
app.put('/api/agents/:id', (req, res) => {
  const agents = loadYaml('agents.yaml');
  const a = agents.find(x => x.id === +req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const { name, role, status, budget_limit, budget_spent, heartbeat_enabled, heartbeat_interval } = req.body;
  Object.assign(a, { name: name ?? a.name, role: role ?? a.role, status: status ?? a.status, budget_limit: budget_limit ?? a.budget_limit, budget_spent: budget_spent ?? a.budget_spent, heartbeat_enabled: heartbeat_enabled !== undefined ? (heartbeat_enabled ? 1 : 0) : a.heartbeat_enabled, heartbeat_interval: heartbeat_interval ?? a.heartbeat_interval });
  saveYaml('agents.yaml', agents);
  res.json(a);
});
app.delete('/api/agents/:id', (req, res) => {
  const agents = loadYaml('agents.yaml');
  const idx = agents.findIndex(x => x.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  agents.splice(idx, 1);
  saveYaml('agents.yaml', agents);
  res.json({ ok: true });
});
app.post('/api/agents/:id/heartbeat', async (req, res) => {
  const agent = loadYaml('agents.yaml').find(x => x.id === +req.params.id);
  if (!agent) return res.status(404).json({ error: 'not found' });
  try { res.json(await triggerHeartbeat(agent)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Heartbeats
app.get('/api/heartbeats', (req, res) => {
  const agents = loadYaml('agents.yaml');
  const hbs = loadYaml('heartbeats.yaml').sort((a, b) => b.id - a.id).slice(0, +(req.query.limit) || 50);
  res.json(hbs.map(h => { const a = agents.find(x => x.id === h.agent_id); return { ...h, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id }; }));
});
app.post('/api/heartbeats/tick', async (req, res) => { try { const r = await runHeartbeatCycle(); res.json({ ticked: r.length, results: r }); } catch (e) { res.status(500).json({ error: e.message }); } });

// Projects CRUD
app.get('/api/projects', (req, res) => {
  const projects = loadYaml('projects.yaml');
  const tasks = loadYaml('tasks.yaml');
  res.json(projects.map(p => {
    const pt = tasks.filter(t => t.project_id === p.id);
    return { ...p, task_total: pt.length, task_done: pt.filter(t => t.status === 'done').length };
  }));
});
app.post('/api/projects', (req, res) => {
  const { title, description, workspace_path, status } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!workspace_path) return res.status(400).json({ error: 'workspace_path required' });
  const projects = loadYaml('projects.yaml');
  const p = { id: nextId(projects), title, description: description || '', workspace_path: workspace_path || '', status: status || 'active', created_at: new Date().toISOString() };
  projects.push(p);
  saveYaml('projects.yaml', projects);
  res.status(201).json(p);
});
app.get('/api/projects/:id', (req, res) => {
  const p = loadYaml('projects.yaml').find(x => x.id === +req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const agents = loadYaml('agents.yaml');
  const allTasks = loadYaml('tasks.yaml');
  const tasks = allTasks.filter(t => t.project_id === p.id).map(t => {
    const a = agents.find(x => x.id === t.assigned_agent_id);
    const dep = allTasks.find(d => d.id === t.dependency_id);
    return { ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id, dep_title: dep?.title };
  });
  res.json({ ...p, tasks });
});
app.put('/api/projects/:id', (req, res) => {
  const projects = loadYaml('projects.yaml');
  const p = projects.find(x => x.id === +req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const { title, description, workspace_path, status } = req.body;
  if (workspace_path !== undefined && !workspace_path) return res.status(400).json({ error: 'workspace_path cannot be empty' });
  Object.assign(p, { title: title ?? p.title, description: description ?? p.description, workspace_path: workspace_path ?? p.workspace_path, status: status ?? p.status });
  saveYaml('projects.yaml', projects);
  res.json(p);
});
app.delete('/api/projects/:id', (req, res) => {
  const projects = loadYaml('projects.yaml');
  const idx = projects.findIndex(x => x.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  projects.splice(idx, 1);
  saveYaml('projects.yaml', projects);
  // Also delete tasks
  const tasks = loadYaml('tasks.yaml').filter(t => t.project_id !== +req.params.id);
  saveYaml('tasks.yaml', tasks);
  res.json({ ok: true });
});

// Tasks
app.get('/api/projects/:id/tasks', (req, res) => {
  const agents = loadYaml('agents.yaml');
  res.json(loadYaml('tasks.yaml').filter(t => t.project_id === +req.params.id).map(t => { const a = agents.find(x => x.id === t.assigned_agent_id); return { ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id }; }));
});
app.post('/api/projects/:id/tasks', (req, res) => {
  if (!loadYaml('projects.yaml').find(p => p.id === +req.params.id)) return res.status(404).json({ error: 'project not found' });
  const { assigned_agent_id, title, description, status, dependency_id, creates_agent, created_by_agent_id } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const toNum = (v) => (v === '' || v === null || v === undefined) ? null : +v || null;
  const tasks = loadYaml('tasks.yaml');
  const t = { id: nextId(tasks), project_id: +req.params.id, assigned_agent_id: toNum(assigned_agent_id), title, description: description || '', status: status || 'pending', dependency_id: toNum(dependency_id), creates_agent: creates_agent || null, created_by_agent_id: toNum(created_by_agent_id), created_at: new Date().toISOString(), completed_at: null };
  tasks.push(t);
  saveYaml('tasks.yaml', tasks);
  const agents = loadYaml('agents.yaml');
  const a = agents.find(x => x.id === t.assigned_agent_id);
  res.status(201).json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id });
});

// Feature 3: Agents can create tasks programmatically
app.post('/api/projects/:id/tasks/from-agent', (req, res) => {
  if (!loadYaml('projects.yaml').find(p => p.id === +req.params.id)) return res.status(404).json({ error: 'project not found' });
  const { agent_id, title, description, assigned_to_agent_id } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!agent_id) return res.status(400).json({ error: 'agent_id required (the agent creating this task)' });

  // Resolve agent_id (openclaw_agent_id string) to internal id
  const agents = loadYaml('agents.yaml');
  const creatorAgent = agents.find(a => a.openclaw_agent_id === agent_id || a.id === +agent_id);
  if (!creatorAgent) return res.status(404).json({ error: 'creator agent not found' });

  let assignedId = null;
  if (assigned_to_agent_id) {
    const assigned = agents.find(a => a.openclaw_agent_id === assigned_to_agent_id || a.id === +assigned_to_agent_id);
    if (assigned) assignedId = assigned.id;
  }
  if (!assignedId) return res.status(400).json({ error: 'assigned_to_agent_id is required (the agent who will do the work)' });

  const tasks = loadYaml('tasks.yaml');
  const t = {
    id: nextId(tasks), project_id: +req.params.id,
    assigned_agent_id: assignedId,
    title, description: description || '',
    status: 'pending', dependency_id: null,
    creates_agent: null,
    created_by_agent_id: creatorAgent.id,
    created_at: new Date().toISOString(), completed_at: null
  };
  tasks.push(t);
  saveYaml('tasks.yaml', tasks);
  const a = agents.find(x => x.id === t.assigned_agent_id);
  res.status(201).json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id, created_by: creatorAgent.name });
});
app.get('/api/tasks/:id', (req, res) => {
  const t = loadYaml('tasks.yaml').find(x => x.id === +req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const a = loadYaml('agents.yaml').find(x => x.id === t.assigned_agent_id);
  res.json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id });
});
app.put('/api/tasks/:id', (req, res) => {
  const tasks = loadYaml('tasks.yaml');
  const t = tasks.find(x => x.id === +req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const { assigned_agent_id, title, description, status, dependency_id, creates_agent, created_by_agent_id } = req.body;
  const resolveAgent = (v) => (v === '' || v === null || v === undefined) ? null : +v || null;
  const resolveDep = (v) => (v === '' || v === null || v === undefined) ? null : +v || null;
  Object.assign(t, { assigned_agent_id: assigned_agent_id !== undefined ? resolveAgent(assigned_agent_id) : t.assigned_agent_id, title: title ?? t.title, description: description ?? t.description, status: status ?? t.status, dependency_id: dependency_id !== undefined ? resolveDep(dependency_id) : t.dependency_id, creates_agent: creates_agent !== undefined ? creates_agent : t.creates_agent, created_by_agent_id: created_by_agent_id !== undefined ? created_by_agent_id : t.created_by_agent_id });
  if (status === 'done' && !t.completed_at) t.completed_at = new Date().toISOString();
  saveYaml('tasks.yaml', tasks);
  const a = loadYaml('agents.yaml').find(x => x.id === t.assigned_agent_id);
  res.json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id });
});
app.get('/api/tasks/:id/results', (req, res) => { res.json(loadYaml('task_results.yaml').filter(r => r.task_id === +req.params.id).sort((a, b) => b.id - a.id)); });
app.post('/api/tasks/:id/run', async (req, res) => {
  const task = loadYaml('tasks.yaml').find(x => x.id === +req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (!task.assigned_agent_id) return res.status(400).json({ error: 'no assigned agent' });
  const agent = loadYaml('agents.yaml').find(x => x.id === task.assigned_agent_id);
  if (!agent) return res.status(400).json({ error: 'agent not found' });
  // Mark in_progress
  const tasks = loadYaml('tasks.yaml');
  const t = tasks.find(x => x.id === task.id);
  if (t) t.status = 'in_progress';
  saveYaml('tasks.yaml', tasks);
  try { res.json(await executeTask(agent, task)); } catch (e) {
    const tasks2 = loadYaml('tasks.yaml');
    const t2 = tasks2.find(x => x.id === task.id);
    if (t2) t2.status = 'pending';
    saveYaml('tasks.yaml', tasks2);
    res.status(500).json({ error: e.message });
  }
});

// Dashboard
app.get('/api/dashboard', (req, res) => {
  const agents = loadYaml('agents.yaml');
  const tasks = loadYaml('tasks.yaml');
  const projects = loadYaml('projects.yaml');
  res.json({
    total_agents: agents.length,
    active_tasks: tasks.filter(t => ['pending', 'in_progress'].includes(t.status)).length,
    completed_tasks: tasks.filter(t => t.status === 'done').length,
    total_spent: agents.reduce((s, a) => s + (a.budget_spent || 0), 0),
    agents,
    projects: projects.map(p => ({ ...p, task_total: tasks.filter(t => t.project_id === p.id).length, task_done: tasks.filter(t => t.project_id === p.id && t.status === 'done').length }))
  });
});

app.listen(PORT, () => { console.log(`ClawDesk running on http://localhost:${PORT}`); startHeartbeatEngine(); });
