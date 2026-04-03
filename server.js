const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const yaml = require('js-yaml');

const app = express();
const PORT = process.env.PORT || 3777;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const OPENCLAW_CLI = process.env.OPENCLAW_CLI || '/home/openclaw/.npm-global/bin/openclaw';
const DATA_DIR = path.join(__dirname, 'data');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// ===================== REQUEST LOGGING =====================

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path.startsWith('/api') || req.path === '/health') {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// ===================== YAML STORAGE =====================

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Clean up stale .tmp files from failed atomic writes
try {
  const tmpFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.tmp'));
  for (const f of tmpFiles) { fs.unlinkSync(path.join(DATA_DIR, f)); console.log(`[Startup] Cleaned stale tmp: ${f}`); }
} catch {}

function loadYaml(file) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return [];
  try {
    const data = yaml.load(fs.readFileSync(fp, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) { console.error(`[YAML] Failed to parse ${file}: ${e.message}`); return []; }
}

function saveYaml(file, data) {
  const fp = path.join(DATA_DIR, file);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, yaml.dump(data, { lineWidth: -1, noRefs: true }));
  fs.renameSync(tmp, fp);
}

const MAX_HEARTBEATS = 1000;
function saveHeartbeats(data) {
  if (data.length > MAX_HEARTBEATS) data = data.slice(-MAX_HEARTBEATS);
  saveYaml('heartbeats.yaml', data);
}

const MAX_TASK_RESULTS = 500;
function saveTaskResults(data) {
  if (data.length > MAX_TASK_RESULTS) data = data.slice(-MAX_TASK_RESULTS);
  saveYaml('task_results.yaml', data);
}

function nextId(arr) { return arr.length > 0 ? Math.max(...arr.map(x => x.id)) + 1 : 1; }

// Normalize task for API response — fill in defaults for missing fields
function normalizeTask(t, agents) {
  const a = agents?.find(x => x.id === t.assigned_agent_id);
  return { ...t, priority: t.priority || 'medium', agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id };
}

// ===================== OPENCLAW HELPERS =====================

function runOpenClawAgent(agentId, message, timeout = 180000, cwd) {
  return new Promise((resolve, reject) => {
    const args = ['agent', '--agent', agentId, '--message', message, '--json', '--timeout', String(Math.floor(timeout / 1000))];
    const opts = { timeout, maxBuffer: 1024 * 1024 };
    if (cwd) opts.cwd = cwd;
    execFile(OPENCLAW_CLI, args, opts, (err, stdout, stderr) => {
      let result = null;
      if (stdout && stdout.trim()) { try { result = JSON.parse(stdout.trim()); } catch {} }
      if (result && result.status === 'ok') return resolve(result);
      if (result && !err) return resolve(result);
      if (err && result) return resolve(result);
      // Fallback: if agent did actual work (stdout exists), treat as success
      if (stdout && stdout.trim().length > 0) return resolve({ status: 'ok', summary: 'completed', _raw: stdout.trim().substring(0, 2000) });
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
    fs.writeFileSync(path.join(wsDir, 'IDENTITY.md'), `# IDENTITY.md\n\n- **Name:** ${name}\n- **Role:** ${vibe}\n- **Creature:** AI agent\n- **Vibe:** ${vibe.split('.').filter(s=>s.trim())[0].split(',').slice(0,2).map(s=>s.trim()).join(', ') || 'focused and effective'}\n- **Emoji:** ${emoji}\n`);
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

function deleteOpenClawAgent(agentId) {
  return new Promise((resolve, reject) => {
    const cmd = `${OPENCLAW_CLI} agents delete "${agentId}" --force --json`;
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Failed to delete agent: ${err.message}`));
      resolve();
    });
  });
}

function syncFromOpenClaw() {
  return new Promise((resolve, reject) => {
    exec(`${OPENCLAW_CLI} agents list`, { timeout: 15000 }, (err, stdout, stderr) => {
      const output = (stderr || '') + (stdout || '');
      const agentIds = [...new Set(output.split('\n').map(l => l.trim()).filter(l => l.match(/^-\s+(\S+)/)).map(l => l.match(/^-\s+(\S+)/)[1]))];
      if (agentIds.length === 0 && err) return reject(new Error(`Failed: ${err.message}`));
      let agents = loadYaml('agents.yaml');
      for (const id of agentIds) {
        const existing = agents.find(a => a.openclaw_agent_id === id);
        if (existing) {
          existing.status = 'active';
          // Update name from OpenClaw if it changed
          const syncedName = id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
          if (existing.name !== syncedName) existing.name = syncedName;
        } else {
          agents.push({
            id: nextId(agents), openclaw_agent_id: id,
            name: id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
            status: 'active',
            budget_limit: 0, budget_spent: 0,
            heartbeat_enabled: 1, heartbeat_interval: 30,
            last_heartbeat: null, created_at: new Date().toISOString()
          });
        }
      }
      // Remove agents not present in OpenClaw
      const syncedSet = new Set(agentIds);
      let cleaned = agents.length;
      agents = agents.filter(a => syncedSet.has(a.openclaw_agent_id));
      cleaned = cleaned - agents.length;
      saveYaml('agents.yaml', agents);
      if (cleaned > 0) console.log(`[Sync] Marked ${cleaned} agent(s) inactive (not in OpenClaw)`);
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
  const t = (pid, agent, title, desc, status, dep, priority) => ({ id: ++tid, project_id: pid, assigned_agent_id: agentMap[agent] || null, title, description: desc, status, dependency_id: dep, creates_agent: null, created_by_agent_id: null, priority: priority || 'medium', created_at: now, completed_at: status === 'done' ? now : null });
  saveYaml('tasks.yaml', [
    t(1, 'content-studio', 'Design campaign visuals', 'Create banner ads, social media graphics, and email templates', 'in_progress', null, 'high'),
    t(1, 'main', 'Review campaign strategy', 'Review and approve Q2 strategy and budget', 'pending', null, 'medium'),
    t(1, 'project-manager', 'Set up tracking', 'Install analytics tracking on landing pages', 'pending', null, 'medium'),
    t(1, 'content-studio', 'Write ad copy', 'Draft copy for all Q2 ad placements', 'pending', 1, 'high'),
    t(1, 'main', 'Final launch approval', 'Final review and sign-off', 'pending', 4, 'low'),
    t(2, 'project-manager', 'Audit current dashboards', 'Document existing dashboard inventory', 'done', null, 'medium'),
    t(2, 'content-studio', 'Design new dashboard layout', 'Create wireframes for updated dashboards', 'in_progress', 6, 'medium'),
    t(2, 'project-manager', 'Implement dashboard backend', 'Build API endpoints for new dashboard data', 'pending', 7, 'high'),
    t(2, 'main', 'Approve dashboard budget', 'Review and approve budget for rebuild', 'pending', null, 'low')
  ]);
  saveYaml('heartbeats.yaml', []);
  saveYaml('task_results.yaml', []);
}

// Init: sync agents then seed
if (loadYaml('agents.yaml').length === 0) {
  syncFromOpenClaw().then(r => { console.log('[Seed] Synced:', r.synced.join(', ')); seed(); }).catch(e => {
    console.log('[Seed] Sync failed:', e.message);
    seed();
  });
}

// ===================== TRACKING HELPERS =====================

// Mark a task's status and record when it entered that status
function setTaskStatus(taskId, newStatus) {
  const tasks = loadYaml('tasks.yaml');
  const t = tasks.find(x => x.id === taskId);
  if (!t) return null;
  const oldStatus = t.status;
  t.status = newStatus;
  t._status_changed_at = new Date().toISOString();
  if (newStatus === 'done') t.completed_at = new Date().toISOString();
  else if (oldStatus === 'done') t.completed_at = null;
  saveYaml('tasks.yaml', tasks);
  // Auto-complete project if all tasks are done
  if (newStatus === 'done') {
    const projectTasks = tasks.filter(x => x.project_id === t.project_id);
    if (projectTasks.length > 0 && projectTasks.every(x => x.status === 'done')) {
      const projects = loadYaml('projects.yaml');
      const p = projects.find(x => x.id === t.project_id);
      if (p && p.status === 'active') { p.status = 'completed'; saveYaml('projects.yaml', projects); console.log(`[Auto] Project "${p.title}" marked completed — all tasks done`); }
    }
  }
  // Reopen project if task is un-done
  if (oldStatus === 'done' && newStatus !== 'done') {
    const projects = loadYaml('projects.yaml');
    const p = projects.find(x => x.id === t.project_id);
    if (p && p.status === 'completed') { p.status = 'active'; saveYaml('projects.yaml', projects); console.log(`[Auto] Project "${p.title}" reopened — task un-completed`); }
  }
  return t;
}

// ===================== HEARTBEAT ENGINE =====================

async function executeTask(agent, task) {
  const projects = loadYaml('projects.yaml');
  const project = projects.find(p => p.id === task.project_id);

  let message = `You are working on a project task. DO the work - do not just say "Done."`;
  message += `\nUse your tools (read, write, exec, web_search, web_fetch) to actually complete the task.`;
  if (project && project.workspace_path) {
    message += `\nCRITICAL: Write ALL files to the PROJECT workspace, not your own workspace.`;
    message += `\nProject workspace: ${project.workspace_path}`;
    message += `\nUse the write tool with FULL paths: ${project.workspace_path}/[filename]`;
    message += `\nUse read to check existing files in the project workspace first.`;
  }
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
  message += `\nURL: ${BASE_URL}/api/projects/${task.project_id}/tasks/from-agent`;
  message += `\nBody (JSON): { agent_id: "${agent.openclaw_agent_id}", title: "task title", description: "details", assigned_to_agent_id: "target-agent" }`;
  message += `\nValid agent IDs: ${loadYaml('agents.yaml').map(a => a.openclaw_agent_id).join(', ')}`;
  message += `\nIMPORTANT: assigned_to_agent_id is REQUIRED. Pick the agent who should do the work.`;
  message += `\nTo create MULTIPLE tasks, make MULTIPLE calls - one endpoint call per task.`;
  message += `\nUse this to break down complex work into subtasks or delegate to other agents.`;
  message += `\n`;
  message += `\nYou can also create new agents for this project via HTTP POST:`;
  message += `\nURL: ${BASE_URL}/api/agents`;
  message += `\nBody (JSON): { job_title: "Senior Security Engineer", job_description: "Penetration testing, audits..." }`;
  message += `\nThis creates the agent, its workspace, identity files, and registers it with OpenClaw.`;
  message += `\nAfter creating an agent, you can assign tasks to it using the task creation endpoint above.`;

  let createdAgentInfo = null;

  // Feature 2: Task can create an agent before execution
  if (task.creates_agent) {
    try {
      const oc = await createOpenClawAgent(task.creates_agent, task.creates_agent, null, {});
      const agents = loadYaml('agents.yaml');
      if (!agents.find(a => a.openclaw_agent_id === task.creates_agent)) {
        agents.push({
          id: nextId(agents), openclaw_agent_id: task.creates_agent,
          name: task.creates_agent.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
          status: 'active',
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

  const startTime = Date.now();
  try {
    const result = await runOpenClawAgent(agent.openclaw_agent_id, message, 180000, project?.workspace_path);
    const durationMs = Date.now() - startTime;
    const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    setTaskStatus(task.id, 'done');
    // Store result with duration
    const results = loadYaml('task_results.yaml');
    const resultObj = { id: nextId(results), task_id: task.id, agent_id: agent.id, input: message, output, duration_ms: durationMs, executed_at: new Date().toISOString() };
    if (createdAgentInfo) resultObj.created_agent = createdAgentInfo;
    results.push(resultObj);
    saveTaskResults(results);
    const ret = { action: 'completed', task_id: task.id, task_title: task.title, agent_id: agent.openclaw_agent_id };
    if (createdAgentInfo) ret.created_agent = createdAgentInfo;
    return ret;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    setTaskStatus(task.id, 'failed');
    const results = loadYaml('task_results.yaml');
    const resultObj = { id: nextId(results), task_id: task.id, agent_id: agent.id, input: message, output: `Error: ${err.message}`, duration_ms: durationMs, executed_at: new Date().toISOString() };
    if (createdAgentInfo) resultObj.created_agent = createdAgentInfo;
    results.push(resultObj);
    saveTaskResults(results);
    const ret = { action: 'failed', task_id: task.id, task_title: task.title, agent_id: agent.openclaw_agent_id, error: err.message };
    if (createdAgentInfo) ret.created_agent = createdAgentInfo;
    return ret;
  }
}

async function triggerHeartbeat(agent) {
  const tasks = loadYaml('tasks.yaml');
  const pending = tasks.filter(t => t.assigned_agent_id === agent.id && t.status === 'pending' && (!t.dependency_id || tasks.find(d => d.id === t.dependency_id)?.status === 'done')).sort((a, b) => {
    const pri = { high: 0, medium: 1, low: 2 };
    const pa = pri[a.priority] ?? 1, pb = pri[b.priority] ?? 1;
    return pa !== pb ? pa - pb : a.id - b.id;
  });
  if (pending.length === 0) {
    const agents = loadYaml('agents.yaml');
    const a = agents.find(x => x.id === agent.id);
    if (a) a.last_heartbeat = new Date().toISOString();
    saveYaml('agents.yaml', agents);
    const hbs = loadYaml('heartbeats.yaml');
    hbs.push({ id: nextId(hbs), agent_id: agent.id, triggered_at: new Date().toISOString(), action_taken: JSON.stringify({ action: 'no_pending_tasks' }), status: 'idle' });
    saveHeartbeats(hbs);
    return { agent: agent.name, action: 'idle' };
  }
  const task = pending[0];
  // Mark in_progress with timestamp
  setTaskStatus(task.id, 'in_progress');
  try {
    const result = await executeTask(agent, task);
    const agents = loadYaml('agents.yaml');
    const a = agents.find(x => x.id === agent.id);
    if (a) a.last_heartbeat = new Date().toISOString();
    saveYaml('agents.yaml', agents);
    const hbs = loadYaml('heartbeats.yaml');
    hbs.push({ id: nextId(hbs), agent_id: agent.id, triggered_at: new Date().toISOString(), action_taken: JSON.stringify(result), status: result.action === 'failed' ? 'error' : 'ok' });
    saveHeartbeats(hbs);
    return { agent: agent.name, ...result };
  } catch (err) {
    setTaskStatus(task.id, 'pending');
    const agents = loadYaml('agents.yaml');
    const a = agents.find(x => x.id === agent.id);
    if (a) a.last_heartbeat = new Date().toISOString();
    saveYaml('agents.yaml', agents);
    const hbs = loadYaml('heartbeats.yaml');
    hbs.push({ id: nextId(hbs), agent_id: agent.id, triggered_at: new Date().toISOString(), action_taken: JSON.stringify({ action: 'error', error: err.message }), status: 'error' });
    saveHeartbeats(hbs);
    return { agent: agent.name, action: 'error', error: err.message };
  }
}

let heartbeatRunning = false; // Concurrency guard
let heartbeatStats = { cycles: 0, totalMs: 0, agentsProcessed: 0, errors: 0, lastCycleMs: 0, last10Ms: [] };

async function runHeartbeatCycle() {
  if (heartbeatRunning) { console.log('[Heartbeat] Cycle already running, skipping'); return []; }
  heartbeatRunning = true;
  const cycleStart = Date.now();
  let results = [];
  try {
  // Reset stuck tasks — only tasks that have been in_progress for >10 min
  const tasks = loadYaml('tasks.yaml');
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  let changed = false;
  const stuckResetLog = [];
  for (const t of tasks) {
    if (t.status === 'in_progress') {
      const changedAt = t._status_changed_at || t.created_at;
      if (changedAt < tenMinAgo) {
        t.status = 'pending';
        delete t._status_changed_at;
        changed = true;
        stuckResetLog.push({ task_id: t.id, title: t.title, stuck_since: changedAt });
      }
    }
  }
  if (changed) {
    saveYaml('tasks.yaml', tasks);
    if (stuckResetLog.length > 0) {
      const hbs = loadYaml('heartbeats.yaml');
      for (const s of stuckResetLog) {
        hbs.push({ id: nextId(hbs), agent_id: null, triggered_at: new Date().toISOString(), action_taken: JSON.stringify({ action: 'stuck_reset', ...s }), status: 'warning' });
      }
      saveHeartbeats(hbs);
      console.log(`[Heartbeat] Reset ${stuckResetLog.length} stuck task(s): ${stuckResetLog.map(s => s.title).join(', ')}`);
    }
  }

  const now = new Date();
  const agents = loadYaml('agents.yaml').filter(a => a.heartbeat_enabled && a.status === 'active');
  for (const agent of agents) {
    if (agent.last_heartbeat && (now - new Date(agent.last_heartbeat)) / 60000 < agent.heartbeat_interval) continue;
    // Per-agent timeout: don't let one agent block the whole cycle
    try {
      const hbPromise = triggerHeartbeat(agent);
      const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('heartbeat timeout (200s)')), 200000));
      results.push(await Promise.race([hbPromise, timeoutPromise]));
    } catch (e) {
      console.error(`[Heartbeat] ${agent.name}: ${e.message}`);
      results.push({ agent: agent.name, action: 'error', error: e.message });
    }
  }
  return results;
  } finally {
    heartbeatRunning = false;
    const elapsed = Date.now() - cycleStart;
    heartbeatStats.cycles++;
    heartbeatStats.totalMs += elapsed;
    heartbeatStats.lastCycleMs = elapsed;
    heartbeatStats.last10Ms.push(elapsed);
    if (heartbeatStats.last10Ms.length > 10) heartbeatStats.last10Ms.shift();
    heartbeatStats.agentsProcessed += results.length;
    heartbeatStats.errors += results.filter(r => r.action === 'error').length;
    // Periodic cleanup every 50 cycles (~50 min)
    if (heartbeatStats.cycles % 50 === 0 && heartbeatStats.cycles > 0) {
      const taskIds = new Set(loadYaml('tasks.yaml').map(t => t.id));
      const before = loadYaml('task_results.yaml').length;
      const clean = loadYaml('task_results.yaml').filter(r => taskIds.has(r.task_id));
      if (clean.length !== before) { saveTaskResults(clean); console.log(`[Cleanup] Removed ${before - clean.length} orphaned task results`); }
    }
  }
}

function startHeartbeatEngine() {
  setInterval(async () => {
    try { const r = await runHeartbeatCycle(); if (r.length > 0) console.log(`[Heartbeat] ${r.map(x => `${x.agent}→${x.action}`).join(', ')}`); } catch (e) { console.error('[Heartbeat]', e.message); }
  }, 60000);
  console.log('[Heartbeat] Engine started (60s interval)');
}

// ===================== API =====================

// API route listing (self-documenting)
app.get('/api', (req, res) => {
  res.json({
    name: 'ClawDesk',
    version: '1.0.0',
    endpoints: {
      health: ['GET /health', 'GET /health/ready'],
      agents: ['GET /api/agents', 'POST /api/agents', 'GET /api/agents/:id', 'PUT /api/agents/:id', 'DELETE /api/agents/:id', 'GET /api/agents/:id/stats', 'GET /api/agents/:id/tasks', 'POST /api/agents/:id/heartbeat', 'POST /api/agents/:id/reactivate', 'POST /api/agents/sync'],
      projects: ['GET /api/projects', 'POST /api/projects', 'GET /api/projects/:id', 'PUT /api/projects/:id', 'DELETE /api/projects/:id', 'GET /api/projects/:id/stats', 'GET /api/projects/:id/tasks', 'POST /api/projects/:id/tasks', 'POST /api/projects/:id/tasks/from-agent', 'POST /api/projects/:id/reopen'],
      tasks: ['GET /api/tasks', 'GET /api/tasks/summary', 'GET /api/tasks/:id', 'PUT /api/tasks/:id', 'DELETE /api/tasks/:id', 'GET /api/tasks/:id/results', 'GET /api/tasks/:id/history', 'GET /api/tasks/:id/chain', 'GET /api/tasks/:id/dependents', 'POST /api/tasks/:id/run', 'POST /api/tasks/:id/retry', 'POST /api/tasks/:id/cancel', 'POST /api/tasks/:id/duplicate', 'POST /api/tasks/:id/assign', 'POST /api/tasks/:id/notes', 'POST /api/tasks/bulk'],
      heartbeats: ['GET /api/heartbeats', 'POST /api/heartbeats/tick'],
      system: ['GET /api/system/stats', 'POST /api/system/cleanup'],
      dashboard: ['GET /api/dashboard']
    },
    docs: { tasks: 'Supports ?status, ?priority, ?agent_id, ?project_id, ?search, ?sort_by, ?sort_dir, ?page, ?limit filters' }
  });
});

// Sync
app.post('/api/agents/sync', async (req, res) => {
  try { const r = await syncFromOpenClaw(); res.json({ ok: true, synced: r.synced, count: r.synced.length }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Agents CRUD
app.get('/api/agents', (req, res) => {
  let agents = loadYaml('agents.yaml');
  if (req.query.status) agents = agents.filter(a => a.status === req.query.status);
  if (req.query.search) { const s = req.query.search.toLowerCase(); agents = agents.filter(a => a.name.toLowerCase().includes(s) || a.openclaw_agent_id.toLowerCase().includes(s)); }
  // Default: hide inactive agents unless explicitly requested
  if (!req.query.status) agents = agents.filter(x => x.status === 'active');
  res.json(agents);
});
app.post('/api/agents', async (req, res) => {
  const { job_title, job_description, openclaw_agent_id, name, status, budget_limit, heartbeat_enabled, heartbeat_interval } = req.body;

  // New format: job_title only (auto-generates everything)
  const title = job_title || name;
  const desc = job_description || '';
  const agentId = openclaw_agent_id || (title ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '');

  if (!title) return res.status(400).json({ error: 'job_title required' });
  try {
    const agents = loadYaml('agents.yaml');
    if (agents.find(a => a.openclaw_agent_id === agentId)) return res.status(409).json({ error: 'Agent already exists' });
    const oc = await createOpenClawAgent(agentId, title, null, { vibe: desc });
    const agent = { id: nextId(agents), openclaw_agent_id: agentId, name: title, status: status || 'idle', budget_limit: budget_limit || 0, budget_spent: 0, heartbeat_enabled: 1, heartbeat_interval: heartbeat_interval || 30, last_heartbeat: null, created_at: new Date().toISOString() };
    agents.push(agent);
    saveYaml('agents.yaml', agents);
    res.status(201).json({ ...agent, openclaw: oc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/agents/:id', (req, res) => { const a = loadYaml('agents.yaml').find(x => x.id === +req.params.id); a ? res.json(a) : res.status(404).json({ error: 'not found' }); });
// Agent stats — per-agent workload summary
app.get('/api/agents/:id/stats', (req, res) => {
  const agent = loadYaml('agents.yaml').find(x => x.id === +req.params.id);
  if (!agent) return res.status(404).json({ error: 'not found' });
  const tasks = loadYaml('tasks.yaml').filter(t => t.assigned_agent_id === agent.id);
  const projects = loadYaml('projects.yaml');
  const projectIds = [...new Set(tasks.map(t => t.project_id))];
  const hbs = loadYaml('heartbeats.yaml').filter(h => h.agent_id === agent.id);
  const lastHb = hbs.reduce((best, h) => (!best || h.id > best.id) ? h : best, null);
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  res.json({
    agent_id: agent.id, name: agent.name, openclaw_agent_id: agent.openclaw_agent_id,
    status: agent.status, heartbeat_enabled: !!agent.heartbeat_enabled,
    last_heartbeat: agent.last_heartbeat,
    tasks: { total: tasks.length, ...byStatus },
    projects: projectIds.map(pid => { const p = projects.find(x => x.id === pid); return { id: pid, title: p?.title || 'Unknown', tasks: tasks.filter(t => t.project_id === pid).length }; }),
    heartbeat_runs: hbs.length,
    last_heartbeat_action: lastHb ? (() => { try { return JSON.parse(lastHb.action_taken); } catch { return { raw: lastHb.action_taken }; } })() : null
  });
});
app.put('/api/agents/:id', (req, res) => {
  const agents = loadYaml('agents.yaml');
  const a = agents.find(x => x.id === +req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const { name, status, budget_limit, budget_spent, heartbeat_enabled, heartbeat_interval } = req.body;
  Object.assign(a, { name: name ?? a.name, status: status ?? a.status, budget_limit: budget_limit ?? a.budget_limit, budget_spent: budget_spent ?? a.budget_spent, heartbeat_enabled: heartbeat_enabled !== undefined ? (heartbeat_enabled ? 1 : 0) : a.heartbeat_enabled, heartbeat_interval: Math.max(1, +(heartbeat_interval ?? a.heartbeat_interval)) });
  saveYaml('agents.yaml', agents);
  res.json(a);
});
app.delete('/api/agents/:id', async (req, res) => {
  const agents = loadYaml('agents.yaml');
  const idx = agents.findIndex(x => x.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const agent = agents[idx];
  
  const tasks = loadYaml('tasks.yaml');
  const agentTasks = tasks.filter(t => t.assigned_agent_id === agent.id && t.status !== 'done');
  if (agentTasks.length > 0 && req.query.force !== '1') {
    return res.status(400).json({ 
      error: 'agent has active pending tasks', 
      pending_tasks: agentTasks.length, 
      hint: 'add ?force=1 to delete anyway'
    });
  }
  try {
    await deleteOpenClawAgent(agent.openclaw_agent_id);
    agents.splice(idx, 1);
    saveYaml('agents.yaml', agents);
    // Also remove assigned tasks
    const agentTaskIds = new Set(loadYaml('tasks.yaml').filter(t => t.assigned_agent_id === agent.id).map(t => t.id));
    const tasks = loadYaml('tasks.yaml').filter(t => t.assigned_agent_id !== agent.id);
    saveYaml('tasks.yaml', tasks);
    // Also clean up orphaned heartbeat entries
    const hbs = loadYaml('heartbeats.yaml').filter(h => h.agent_id !== agent.id);
    saveHeartbeats(hbs);
    // Also clean up task results for deleted tasks
    if (agentTaskIds.size > 0) {
      const results = loadYaml('task_results.yaml').filter(r => !agentTaskIds.has(r.task_id));
      saveTaskResults(results);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/agents/:id/heartbeat', async (req, res) => {
  const agent = loadYaml('agents.yaml').find(x => x.id === +req.params.id);
  if (!agent) return res.status(404).json({ error: 'not found' });
  try { res.json(await triggerHeartbeat(agent)); } catch (e) { res.status(500).json({ error: e.message }); }
});
// Reactivate an inactive agent (marked inactive by sync)
app.post('/api/agents/:id/reactivate', (req, res) => {
  const agents = loadYaml('agents.yaml');
  const a = agents.find(x => x.id === +req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.status === 'active') return res.status(400).json({ error: 'agent is already active' });
  a.status = 'active';
  a.heartbeat_enabled = 1;
  saveYaml('agents.yaml', agents);
  res.json({ ok: true, id: a.id, name: a.name, status: a.status });
});
// List tasks assigned to an agent
app.get('/api/agents/:id/tasks', (req, res) => {
  const agent = loadYaml('agents.yaml').find(x => x.id === +req.params.id);
  if (!agent) return res.status(404).json({ error: 'not found' });
  let tasks = loadYaml('tasks.yaml').filter(t => t.assigned_agent_id === agent.id);
  if (req.query.status) tasks = tasks.filter(t => t.status === req.query.status);
  if (req.query.project_id) tasks = tasks.filter(t => t.project_id === +req.query.project_id);
  const pri = { high: 0, medium: 1, low: 2 };
  tasks.sort((a, b) => (pri[a.priority] ?? 1) - (pri[b.priority] ?? 1) || a.id - b.id);
  res.json({ agent_id: agent.id, agent_name: agent.name, tasks: tasks.length, data: tasks });
});

// Heartbeats
app.get('/api/heartbeats', (req, res) => {
  const agents = loadYaml('agents.yaml');
  let all = loadYaml('heartbeats.yaml').sort((a, b) => b.id - a.id);
  if (req.query.status) all = all.filter(h => h.status === req.query.status);
  if (req.query.agent_id) all = all.filter(h => h.agent_id === +req.query.agent_id);
  const page = Math.max(1, +(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, +(req.query.limit) || 50));
  const total = all.length;
  const offset = (page - 1) * limit;
  const hbs = all.slice(offset, offset + limit);
  res.json({ data: hbs.map(h => { const a = agents.find(x => x.id === h.agent_id); return { ...h, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id }; }), total, page, limit, pages: Math.ceil(total / limit) });
});
app.post('/api/heartbeats/tick', async (req, res) => { try { const r = await runHeartbeatCycle(); res.json({ ticked: r.length, results: r }); } catch (e) { res.status(500).json({ error: e.message }); } });

// Projects CRUD
app.get('/api/projects', (req, res) => {
  let projects = loadYaml('projects.yaml');
  if (req.query.status) projects = projects.filter(p => p.status === req.query.status);
  const tasks = loadYaml('tasks.yaml');
  res.json(projects.map(p => {
    const pt = tasks.filter(t => t.project_id === p.id);
    const done = pt.filter(t => t.status === 'done').length;
    return { ...p, task_total: pt.length, task_done: done, completion_pct: pt.length > 0 ? Math.round(done / pt.length * 100) : 0 };
  }));
});
app.post('/api/projects', (req, res) => {
  const { title, description, workspace_path, status } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200 chars)' });
  if (status && !['active', 'completed', 'failed'].includes(status)) return res.status(400).json({ error: 'status must be active, completed, or failed' });
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
    const cb = agents.find(x => x.id === t.created_by_agent_id);
    const dep = allTasks.find(d => d.id === t.dependency_id);
    return { ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id, created_by_agent_slug: cb?.openclaw_agent_id, dep_title: dep?.title };
  });
  const done = tasks.filter(t => t.status === 'done').length;
  res.json({ ...p, tasks, task_total: tasks.length, task_done: done, completion_pct: tasks.length > 0 ? Math.round(done / tasks.length * 100) : 0 });
});
// Project stats — aggregated metrics for a project
app.get('/api/projects/:id/stats', (req, res) => {
  const p = loadYaml('projects.yaml').find(x => x.id === +req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const agents = loadYaml('agents.yaml');
  const tasks = loadYaml('tasks.yaml').filter(t => t.project_id === p.id);
  const byStatus = {}; const byPriority = {}; const byAgent = {};
  let oldestPending = null; let oldestInProgress = null;
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    byPriority[t.priority || 'medium'] = (byPriority[t.priority || 'medium'] || 0) + 1;
    if (t.assigned_agent_id) {
      if (!byAgent[t.assigned_agent_id]) byAgent[t.assigned_agent_id] = { pending: 0, in_progress: 0, done: 0, failed: 0, total: 0 };
      byAgent[t.assigned_agent_id][t.status] = (byAgent[t.assigned_agent_id][t.status] || 0) + 1;
      byAgent[t.assigned_agent_id].total++;
    }
    if (t.status === 'pending' && (!oldestPending || t.created_at < oldestPending)) oldestPending = t.created_at;
    if (t.status === 'in_progress' && (!oldestInProgress || (t._status_changed_at || t.created_at) < oldestInProgress)) oldestInProgress = t._status_changed_at || t.created_at;
  }
  const agentBreakdown = Object.entries(byAgent).map(([aid, counts]) => {
    const a = agents.find(x => x.id === +aid);
    return { agent_id: +aid, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id, ...counts };
  }).sort((a, b) => b.total - a.total);
  res.json({
    project_id: p.id, title: p.title, status: p.status,
    total_tasks: tasks.length, completion_pct: tasks.length > 0 ? Math.round((byStatus.done || 0) / tasks.length * 100) : 0,
    by_status: byStatus, by_priority: byPriority,
    agent_breakdown: agentBreakdown,
    oldest_pending: oldestPending, oldest_in_progress: oldestInProgress
  });
});
app.put('/api/projects/:id', (req, res) => {
  const projects = loadYaml('projects.yaml');
  const p = projects.find(x => x.id === +req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const { title, description, workspace_path, status } = req.body;
  if (workspace_path === '') return res.status(400).json({ error: 'workspace_path cannot be empty string (use null or omit to keep existing)' });
  Object.assign(p, { title: title ?? p.title, description: description ?? p.description, workspace_path: workspace_path ?? p.workspace_path, status: status ?? p.status });
  saveYaml('projects.yaml', projects);
  res.json(p);
});
// Reopen a completed/failed project
app.post('/api/projects/:id/reopen', (req, res) => {
  const projects = loadYaml('projects.yaml');
  const p = projects.find(x => x.id === +req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (p.status === 'active') return res.status(400).json({ error: 'project is already active' });
  p.status = 'active';
  saveYaml('projects.yaml', projects);
  res.json({ ok: true, id: p.id, title: p.title, status: p.status });
});
app.delete('/api/projects/:id', (req, res) => {
  const projects = loadYaml('projects.yaml');
  const idx = projects.findIndex(x => x.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  projects.splice(idx, 1);
  saveYaml('projects.yaml', projects);
  // Also delete tasks and their results
  const projectTaskIds = new Set(loadYaml('tasks.yaml').filter(t => t.project_id === +req.params.id).map(t => t.id));
  const tasks = loadYaml('tasks.yaml').filter(t => t.project_id !== +req.params.id);
  saveYaml('tasks.yaml', tasks);
  if (projectTaskIds.size > 0) {
    const results = loadYaml('task_results.yaml').filter(r => !projectTaskIds.has(r.task_id));
    saveTaskResults(results);
  }
  res.json({ ok: true });
});

// Tasks
app.get('/api/projects/:id/tasks', (req, res) => {
  const agents = loadYaml('agents.yaml');
  let tasks = loadYaml('tasks.yaml').filter(t => t.project_id === +req.params.id);
  if (req.query.status) tasks = tasks.filter(t => t.status === req.query.status);
  if (req.query.priority) tasks = tasks.filter(t => t.priority === req.query.priority);
  if (req.query.agent_id) tasks = tasks.filter(t => t.assigned_agent_id === +req.query.agent_id);
  if (req.query.search) { const s = req.query.search.toLowerCase(); tasks = tasks.filter(t => t.title.toLowerCase().includes(s)); }
  res.json(tasks.map(t => { const a = agents.find(x => x.id === t.assigned_agent_id); const cb = agents.find(x => x.id === t.created_by_agent_id); return { ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id, created_by_agent_slug: cb?.openclaw_agent_id }; }));
});
app.post('/api/projects/:id/tasks', (req, res) => {
  if (!loadYaml('projects.yaml').find(p => p.id === +req.params.id)) return res.status(404).json({ error: 'project not found' });
  const { assigned_agent_id, title, description, status, dependency_id, creates_agent, created_by_agent_id, priority } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  if (title.length > 500) return res.status(400).json({ error: 'title too long (max 500 chars)' });
  if (priority && !['low', 'medium', 'high'].includes(priority)) return res.status(400).json({ error: 'priority must be low, medium, or high' });
  const toNum = (v) => (v === '' || v === null || v === undefined) ? null : +v || null;
  // Validate assigned agent exists
  const assignId = toNum(assigned_agent_id);
  if (assignId) {
    const allAgents = loadYaml('agents.yaml');
    if (!allAgents.find(a => a.id === assignId)) return res.status(400).json({ error: `agent #${assignId} not found` });
  }
  // Validate dependency
  const depId = toNum(dependency_id);
  if (depId) {
    const allTasks = loadYaml('tasks.yaml');
    const dep = allTasks.find(t => t.id === depId);
    if (!dep) return res.status(400).json({ error: `dependency task #${depId} not found` });
    if (dep.project_id !== +req.params.id) return res.status(400).json({ error: `dependency task #${depId} belongs to a different project` });
    // Check for circular dependency chain
    const visited = new Set();
    let current = depId;
    while (current && !visited.has(current)) {
      visited.add(current);
      const parent = allTasks.find(t => t.id === current);
      current = parent?.dependency_id;
    }
    if (current) return res.status(400).json({ error: `circular dependency detected: task #${depId} is part of a cycle` });
  }
  const tasks = loadYaml('tasks.yaml');
  const t = { id: nextId(tasks), project_id: +req.params.id, assigned_agent_id: toNum(assigned_agent_id), title, description: description || '', status: status || 'pending', dependency_id: depId, creates_agent: creates_agent || null, created_by_agent_id: toNum(created_by_agent_id), priority: priority || 'medium', created_at: new Date().toISOString(), completed_at: null };
  tasks.push(t);
  saveYaml('tasks.yaml', tasks);
  const agents = loadYaml('agents.yaml');
  const a = agents.find(x => x.id === t.assigned_agent_id);
  res.status(201).json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id });
});

// Feature 3: Agents can create tasks programmatically
app.post('/api/projects/:id/tasks/from-agent', (req, res) => {
  if (!loadYaml('projects.yaml').find(p => p.id === +req.params.id)) return res.status(404).json({ error: 'project not found' });
  const { agent_id, title, description, assigned_to_agent_id, priority, dependency_id } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!agent_id) return res.status(400).json({ error: 'agent_id required (the agent creating this task)' });
  if (priority && !['low', 'medium', 'high'].includes(priority)) return res.status(400).json({ error: 'priority must be low, medium, or high' });

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
  // Validate dependency if provided
  const depId = dependency_id ? +dependency_id : null;
  if (depId) {
    const dep = tasks.find(t => t.id === depId);
    if (!dep) return res.status(400).json({ error: `dependency task #${depId} not found` });
    if (dep.project_id !== +req.params.id) return res.status(400).json({ error: `dependency task #${depId} belongs to a different project` });
  }
  const t = {
    id: nextId(tasks), project_id: +req.params.id,
    assigned_agent_id: assignedId,
    title, description: description || '',
    status: 'pending', dependency_id: depId,
    creates_agent: null,
    created_by_agent_id: creatorAgent.id,
    priority: priority || 'medium',
    created_at: new Date().toISOString(), completed_at: null
  };
  tasks.push(t);
  saveYaml('tasks.yaml', tasks);
  const a = agents.find(x => x.id === t.assigned_agent_id);
  res.status(201).json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id, created_by: creatorAgent.name });
});
// Task summary — lightweight aggregate counts without fetching all tasks
app.get('/api/tasks/summary', (req, res) => {
  let tasks = loadYaml('tasks.yaml');
  if (req.query.project_id) tasks = tasks.filter(t => t.project_id === +req.query.project_id);
  if (req.query.agent_id) tasks = tasks.filter(t => t.assigned_agent_id === +req.query.agent_id);
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
app.get('/api/tasks/:id', (req, res) => {
  const t = loadYaml('tasks.yaml').find(x => x.id === +req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const agents = loadYaml('agents.yaml');
  const resp = normalizeTask(t, agents);
  if (t.status === 'in_progress' && t._status_changed_at) {
    resp.in_progress_seconds = Math.round((Date.now() - new Date(t._status_changed_at)) / 1000);
  }
  res.json(resp);
});
app.put('/api/tasks/:id', (req, res) => {
  const tasks = loadYaml('tasks.yaml');
  const t = tasks.find(x => x.id === +req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const { assigned_agent_id, title, description, status, dependency_id, creates_agent, created_by_agent_id, priority } = req.body;
  const resolveAgent = (v) => (v === '' || v === null || v === undefined) ? null : +v || null;
  const resolveDep = (v) => (v === '' || v === null || v === undefined) ? null : +v || null;
  if (priority && !['low', 'medium', 'high'].includes(priority)) return res.status(400).json({ error: 'priority must be low, medium, or high' });
  // Validate circular dependency if dependency_id is being changed
  const newDepId = dependency_id !== undefined ? resolveDep(dependency_id) : t.dependency_id;
  if (newDepId && newDepId !== t.dependency_id) {
    const allTasks = loadYaml('tasks.yaml');
    const dep = allTasks.find(d => d.id === newDepId);
    if (!dep) return res.status(400).json({ error: `dependency task #${newDepId} not found` });
    if (dep.project_id !== t.project_id) return res.status(400).json({ error: `dependency task #${newDepId} belongs to a different project` });
    const visited = new Set();
    let current = newDepId;
    while (current && !visited.has(current)) {
      if (current === t.id) return res.status(400).json({ error: 'circular dependency detected' });
      visited.add(current);
      const parent = allTasks.find(d => d.id === current);
      current = parent?.dependency_id;
    }
  }
  const oldStatus = t.status;
  Object.assign(t, { assigned_agent_id: assigned_agent_id !== undefined ? resolveAgent(assigned_agent_id) : t.assigned_agent_id, title: title ?? t.title, description: description ?? t.description, status: status ?? t.status, dependency_id: dependency_id !== undefined ? resolveDep(dependency_id) : t.dependency_id, creates_agent: creates_agent !== undefined ? creates_agent : t.creates_agent, created_by_agent_id: created_by_agent_id !== undefined ? created_by_agent_id : t.created_by_agent_id, priority: priority ?? t.priority });
  if (status && status !== oldStatus) {
    t._status_changed_at = new Date().toISOString();
    if (status === 'done') { if (!t.completed_at) t.completed_at = new Date().toISOString(); }
    else if (oldStatus === 'done') { t.completed_at = null; } // clear when un-completing
    // Auto-complete project if all tasks are now done
    if (status === 'done') {
      const projectTasks = tasks.filter(x => x.project_id === t.project_id);
      if (projectTasks.length > 0 && projectTasks.every(x => x.status === 'done')) {
        const projects = loadYaml('projects.yaml');
        const p = projects.find(x => x.id === t.project_id);
        if (p && p.status === 'active') { p.status = 'completed'; saveYaml('projects.yaml', projects); console.log(`[Auto] Project "${p.title}" marked completed — all tasks done`); }
      }
    }
    // Reopen project if a task is un-done from a completed project
    if (oldStatus === 'done' && status !== 'done') {
      const projects = loadYaml('projects.yaml');
      const p = projects.find(x => x.id === t.project_id);
      if (p && p.status === 'completed') { p.status = 'active'; saveYaml('projects.yaml', projects); console.log(`[Auto] Project "${p.title}" reopened — task #${t.id} un-completed`); }
    }
  }
  saveYaml('tasks.yaml', tasks);
  const a = loadYaml('agents.yaml').find(x => x.id === t.assigned_agent_id);
  res.json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id });
});
app.delete('/api/tasks/:id', (req, res) => {
  const tasks = loadYaml('tasks.yaml');
  const idx = tasks.findIndex(x => x.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const deletedId = tasks[idx].id;
  // Clear dependency references to deleted task (prevents orphaned deps blocking execution)
  let cleared = 0;
  for (const t of tasks) {
    if (t.dependency_id === deletedId) { t.dependency_id = null; cleared++; }
  }
  if (cleared > 0) console.log(`[Delete] Cleared ${cleared} dependency reference(s) to deleted task #${deletedId}`);
  tasks.splice(idx, 1);
  saveYaml('tasks.yaml', tasks);
  // Also clean up task results
  const results = loadYaml('task_results.yaml').filter(r => r.task_id !== +req.params.id);
  saveTaskResults(results);
  res.json({ ok: true });
});
app.get('/api/tasks/:id/results', (req, res) => { res.json(loadYaml('task_results.yaml').filter(r => r.task_id === +req.params.id).sort((a, b) => b.id - a.id)); });
// Task history — combined execution results + heartbeat entries mentioning this task
app.get('/api/tasks/:id/history', (req, res) => {
  const allTasks = loadYaml('tasks.yaml');
  const task = allTasks.find(x => x.id === +req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const agents = loadYaml('agents.yaml');
  const results = loadYaml('task_results.yaml').filter(r => r.task_id === task.id).sort((a, b) => b.id - a.id);
  // Find heartbeat entries that mention this task
  const hbs = loadYaml('heartbeats.yaml').filter(h => {
    try { const a = JSON.parse(h.action_taken); return a.task_id === task.id || (a.title && a.title === task.title); } catch { return false; }
  }).sort((a, b) => b.id - a.id);
  // Dependency chain
  const chain = [];
  let current = task.dependency_id;
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    const dep = allTasks.find(t => t.id === current);
    if (!dep) { chain.push({ id: current, title: '[deleted]' }); break; }
    chain.push({ id: dep.id, title: dep.title, status: dep.status });
    current = dep.dependency_id;
  }
  // Dependents
  const dependents = allTasks.filter(t => t.dependency_id === task.id).map(t => ({ id: t.id, title: t.title, status: t.status }));
  res.json({
    task: { id: task.id, title: task.title, status: task.status, priority: task.priority, assigned_agent_id: task.assigned_agent_id, created_at: task.created_at, completed_at: task.completed_at, retry_count: task._retry_count || 0 },
    executions: results.filter(r => r.type !== 'note').map(r => ({ id: r.id, status: r.output?.startsWith('Error:') ? 'failed' : 'completed', duration_ms: r.duration_ms, executed_at: r.executed_at, output_preview: (r.output || '').substring(0, 200) })),
    notes: results.filter(r => r.type === 'note').map(r => ({ id: r.id, note: r.output, agent_id: r.agent_id, created_at: r.executed_at })),
    heartbeat_entries: hbs.map(h => { const a = agents.find(x => x.id === h.agent_id); return { id: h.id, triggered_at: h.triggered_at, status: h.status, agent_name: a?.name, action: (() => { try { return JSON.parse(h.action_taken); } catch { return { raw: h.action_taken }; } })() }; }),
    dependency_chain: chain,
    dependents,
    total_executions: results.filter(r => r.type !== 'note').length,
    total_notes: results.filter(r => r.type === 'note').length,
    total_heartbeat_entries: hbs.length
  });
});
// Reverse dependency lookup — tasks that depend on this task
app.get('/api/tasks/:id/dependents', (req, res) => {
  const task = loadYaml('tasks.yaml').find(x => x.id === +req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const agents = loadYaml('agents.yaml');
  const dependents = loadYaml('tasks.yaml').filter(t => t.dependency_id === task.id).map(t => {
    const a = agents.find(x => x.id === t.assigned_agent_id);
    return { id: t.id, title: t.title, status: t.status, priority: t.priority, agent_name: a?.name };
  });
  res.json({ task_id: task.id, task_title: task.title, blocked_by_this: dependents, count: dependents.length });
});
// Dependency chain — full chain of ancestors this task depends on
app.get('/api/tasks/:id/chain', (req, res) => {
  const tasks = loadYaml('tasks.yaml');
  const task = tasks.find(x => x.id === +req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const chain = [];
  const visited = new Set();
  let current = task.dependency_id;
  while (current && !visited.has(current)) {
    visited.add(current);
    const dep = tasks.find(t => t.id === current);
    if (!dep) { chain.push({ id: current, title: '[deleted]', status: 'missing' }); break; }
    chain.push({ id: dep.id, title: dep.title, status: dep.status, priority: dep.priority });
    current = dep.dependency_id;
  }
  res.json({ task_id: task.id, title: task.title, status: task.status, chain_length: chain.length, chain, blocked: chain.some(c => c.status !== 'done') });
});
// Duplicate a task — clones title/description/priority/agent/creates_agent, resets status to pending
app.post('/api/tasks/:id/duplicate', (req, res) => {
  const tasks = loadYaml('tasks.yaml');
  const orig = tasks.find(x => x.id === +req.params.id);
  if (!orig) return res.status(404).json({ error: 'not found' });
  // Validate assigned agent still exists
  if (orig.assigned_agent_id) {
    const agents = loadYaml('agents.yaml');
    if (!agents.find(a => a.id === orig.assigned_agent_id)) return res.status(400).json({ error: 'assigned agent no longer exists — reassign before duplicating' });
  }
  const t = {
    id: nextId(tasks), project_id: orig.project_id,
    assigned_agent_id: orig.assigned_agent_id,
    title: req.body.title || (orig.title + ' (copy)'),
    description: orig.description, status: 'pending',
    dependency_id: orig.dependency_id,
    creates_agent: orig.creates_agent,
    created_by_agent_id: orig.created_by_agent_id,
    priority: orig.priority,
    created_at: new Date().toISOString(), completed_at: null
    // intentionally omitting _retry_count, _status_changed_at — copies start clean
  };
  tasks.push(t);
  saveYaml('tasks.yaml', tasks);
  const a = loadYaml('agents.yaml').find(x => x.id === t.assigned_agent_id);
  res.status(201).json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id });
});
// Bulk task update — update status/priority/agent for multiple tasks at once
app.post('/api/tasks/bulk', (req, res) => {
  const { task_ids, status, priority, assigned_agent_id } = req.body;
  if (!Array.isArray(task_ids) || task_ids.length === 0) return res.status(400).json({ error: 'task_ids must be a non-empty array' });
  if (task_ids.length > 100) return res.status(400).json({ error: 'max 100 tasks per bulk update' });
  if (priority && !['low', 'medium', 'high'].includes(priority)) return res.status(400).json({ error: 'priority must be low, medium, or high' });
  // Validate assigned agent if reassigning
  if (assigned_agent_id !== undefined && assigned_agent_id) {
    const allAgents = loadYaml('agents.yaml');
    if (!allAgents.find(a => a.id === +assigned_agent_id)) return res.status(400).json({ error: `agent #${assigned_agent_id} not found` });
  }
  const tasks = loadYaml('tasks.yaml');
  const updated = [];
  const affectedProjects = new Set();
  for (const tid of task_ids) {
    const t = tasks.find(x => x.id === +tid);
    if (!t) continue;
    const oldStatus = t.status;
    if (status) { t.status = status; if (status !== oldStatus) t._status_changed_at = new Date().toISOString(); if (status === 'done') { if (!t.completed_at) t.completed_at = new Date().toISOString(); affectedProjects.add(t.project_id); } }
    if (priority) t.priority = priority;
    if (assigned_agent_id !== undefined) t.assigned_agent_id = assigned_agent_id ? +assigned_agent_id : null;
    updated.push(t.id);
  }
  saveYaml('tasks.yaml', tasks);
  // Check auto-completion for affected projects
  if (status === 'done') {
    const projects = loadYaml('projects.yaml');
    let changed = false;
    for (const pid of affectedProjects) {
      const projectTasks = tasks.filter(x => x.project_id === pid);
      if (projectTasks.length > 0 && projectTasks.every(x => x.status === 'done')) {
        const p = projects.find(x => x.id === pid);
        if (p && p.status === 'active') { p.status = 'completed'; changed = true; console.log(`[Auto] Project "${p.title}" marked completed — all tasks done`); }
      }
    }
    if (changed) saveYaml('projects.yaml', projects);
  }
  res.json({ ok: true, updated: updated.length, task_ids: updated });
});
app.post('/api/tasks/:id/run', async (req, res) => {
  const task = loadYaml('tasks.yaml').find(x => x.id === +req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (!task.assigned_agent_id) return res.status(400).json({ error: 'no assigned agent' });
  const agent = loadYaml('agents.yaml').find(x => x.id === task.assigned_agent_id);
  if (!agent) return res.status(400).json({ error: 'agent not found' });
  // Mark in_progress with timestamp
  setTaskStatus(task.id, 'in_progress');
  try { res.json(await executeTask(agent, task)); } catch (e) {
    setTaskStatus(task.id, 'pending');
    // Log to heartbeat for visibility
    const hbs = loadYaml('heartbeats.yaml');
    hbs.push({ id: nextId(hbs), agent_id: agent.id, triggered_at: new Date().toISOString(), action_taken: JSON.stringify({ action: 'run_error', task_id: task.id, task_title: task.title, error: e.message }), status: 'error' });
    saveHeartbeats(hbs);
    res.status(500).json({ error: e.message });
  }
});
// Cancel an in-progress task — resets to pending
app.post('/api/tasks/:id/cancel', (req, res) => {
  const tasks = loadYaml('tasks.yaml');
  const t = tasks.find(x => x.id === +req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.status !== 'in_progress') return res.status(400).json({ error: `task status is "${t.status}", can only cancel in_progress tasks` });
  t.status = 'pending';
  delete t._status_changed_at;
  saveYaml('tasks.yaml', tasks);
  // Log cancellation
  const hbs = loadYaml('heartbeats.yaml');
  hbs.push({ id: nextId(hbs), agent_id: null, triggered_at: new Date().toISOString(), action_taken: JSON.stringify({ action: 'task_cancelled', task_id: t.id, title: t.title }), status: 'warning' });
  saveHeartbeats(hbs);
  res.json({ ok: true, task_id: t.id, title: t.title, status: 'pending' });
});
// Add a note to a task (stored in task_results with special type)
app.post('/api/tasks/:id/notes', (req, res) => {
  const { note, agent_id } = req.body;
  if (!note) return res.status(400).json({ error: 'note required' });
  const task = loadYaml('tasks.yaml').find(x => x.id === +req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const results = loadYaml('task_results.yaml');
  results.push({ id: nextId(results), task_id: task.id, agent_id: agent_id || null, input: '[note]', output: note, type: 'note', executed_at: new Date().toISOString() });
  saveTaskResults(results);
  res.json({ ok: true, task_id: task.id, note });
});
// Reassign a task to a different agent (lightweight — no need for full PUT)
app.post('/api/tasks/:id/assign', (req, res) => {
  const { agent_id } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  const tasks = loadYaml('tasks.yaml');
  const t = tasks.find(x => x.id === +req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const agents = loadYaml('agents.yaml');
  const agent = agents.find(a => a.id === +agent_id || a.openclaw_agent_id === agent_id);
  if (!agent) return res.status(400).json({ error: 'agent not found' });
  const oldAgentId = t.assigned_agent_id;
  t.assigned_agent_id = agent.id;
  saveYaml('tasks.yaml', tasks);
  res.json({ ok: true, task_id: t.id, title: t.title, old_agent_id: oldAgentId, new_agent_id: agent.id, new_agent_name: agent.name });
});
// Retry a failed task — resets to pending so heartbeat picks it up, or runs immediately
app.post('/api/tasks/:id/retry', async (req, res) => {
  const tasks = loadYaml('tasks.yaml');
  const task = tasks.find(x => x.id === +req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.status !== 'failed') return res.status(400).json({ error: `task status is "${task.status}", can only retry failed tasks` });
  if (!task.assigned_agent_id) return res.status(400).json({ error: 'no assigned agent' });
  const agent = loadYaml('agents.yaml').find(x => x.id === task.assigned_agent_id);
  if (!agent) return res.status(400).json({ error: 'agent not found' });
  // Track retry count
  task._retry_count = (task._retry_count || 0) + 1;
  task.status = 'pending';
  delete task._status_changed_at;
  saveYaml('tasks.yaml', tasks);
  if (req.query.immediate === '1' || req.query.immediate === 'true') {
    // Run immediately
    setTaskStatus(task.id, 'in_progress');
    try { res.json({ retried: true, immediate: true, ...await executeTask(agent, task) }); } catch (e) {
      setTaskStatus(task.id, 'failed');
      res.json({ retried: true, immediate: true, action: 'failed', error: e.message, retry_count: task._retry_count });
    }
  } else {
    res.json({ retried: true, immediate: false, task_id: task.id, status: 'pending', retry_count: task._retry_count, message: 'Task reset to pending. Heartbeat engine will pick it up.' });
  }
});

// Dashboard
app.get('/api/tasks', (req, res) => {
  const agents = loadYaml('agents.yaml');
  let tasks = loadYaml('tasks.yaml');
  // Filters
  if (req.query.status) tasks = tasks.filter(t => t.status === req.query.status);
  if (req.query.agent_id) tasks = tasks.filter(t => t.assigned_agent_id === +req.query.agent_id);
  if (req.query.priority) tasks = tasks.filter(t => t.priority === req.query.priority);
  if (req.query.project_id) tasks = tasks.filter(t => t.project_id === +req.query.project_id);
  if (req.query.search) { const s = req.query.search.toLowerCase(); tasks = tasks.filter(t => t.title.toLowerCase().includes(s)); }
  // Sort
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
  // Pagination
  const page = Math.max(1, +(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, +(req.query.limit) || 50));
  const total = tasks.length;
  const offset = (page - 1) * limit;
  const paged = tasks.slice(offset, offset + limit);
  res.json({ data: paged.map(t => normalizeTask(t, agents)), total, page, limit, pages: Math.ceil(total / limit) });
});
app.get('/api/dashboard', (req, res) => {
  const agents = loadYaml('agents.yaml');
  const tasks = loadYaml('tasks.yaml');
  const projects = loadYaml('projects.yaml');
  const hbs = loadYaml('heartbeats.yaml');
  const recentHbs = hbs.sort((a, b) => b.id - a.id).slice(0, 10);
  res.json({
    total_agents: agents.length,
    active_tasks: tasks.filter(t => ['pending', 'in_progress'].includes(t.status)).length,
    completed_tasks: tasks.filter(t => t.status === 'done').length,
    failed_tasks: tasks.filter(t => t.status === 'failed').length,
    total_spent: agents.reduce((s, a) => s + (a.budget_spent || 0), 0),
    agents: agents.map(a => {
      const at = tasks.filter(t => t.assigned_agent_id === a.id);
      return {
        ...a,
        tasks_pending: at.filter(t => t.status === 'pending').length,
        tasks_in_progress: at.filter(t => t.status === 'in_progress').length,
        tasks_done: at.filter(t => t.status === 'done').length,
        tasks_failed: at.filter(t => t.status === 'failed').length,
        tasks_total: at.length
      };
    }),
    projects: projects.map(p => {
      const pt = tasks.filter(t => t.project_id === p.id);
      const done = pt.filter(t => t.status === 'done').length;
      return { ...p, task_total: pt.length, task_done: done, completion_pct: pt.length > 0 ? Math.round(done / pt.length * 100) : 0 };
    }),
    recent_heartbeats: recentHbs.map(h => {
      const a = agents.find(x => x.id === h.agent_id);
      let action; try { action = JSON.parse(h.action_taken); } catch { action = {}; }
      return { id: h.id, triggered_at: h.triggered_at, status: h.status, agent_name: a?.name || 'System', action_summary: action.action || 'unknown' };
    })
  });
});

// ===================== HEALTH CHECK =====================

// Lightweight readiness probe (no YAML loading)
app.get('/health/ready', (req, res) => {
  res.json({ status: 'ready', timestamp: new Date().toISOString() });
});
app.get('/health', (req, res) => {
  const agents = loadYaml('agents.yaml');
  const tasks = loadYaml('tasks.yaml');
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    agents: agents.length,
    active_tasks: tasks.filter(t => ['pending', 'in_progress'].includes(t.status)).length,
    failed_tasks: tasks.filter(t => t.status === 'failed').length,
    heartbeat: {
      cycles: heartbeatStats.cycles,
      avgMs: heartbeatStats.cycles > 0 ? Math.round(heartbeatStats.totalMs / heartbeatStats.cycles) : 0,
      lastMs: heartbeatStats.lastCycleMs,
      recentAvgMs: heartbeatStats.last10Ms.length > 0 ? Math.round(heartbeatStats.last10Ms.reduce((a,b) => a+b, 0) / heartbeatStats.last10Ms.length) : 0,
      agentsProcessed: heartbeatStats.agentsProcessed,
      errors: heartbeatStats.errors,
      running: heartbeatRunning
    },
    timestamp: new Date().toISOString()
  });
});

// System stats — aggregate overview of all data
app.get('/api/system/stats', (req, res) => {
  const agents = loadYaml('agents.yaml');
  const tasks = loadYaml('tasks.yaml');
  const projects = loadYaml('projects.yaml');
  const hbs = loadYaml('heartbeats.yaml');
  const results = loadYaml('task_results.yaml');
  const dataFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.yaml') && !f.endsWith('.tmp'));
  const fileSizes = {};
  for (const f of dataFiles) {
    try { fileSizes[f] = fs.statSync(path.join(DATA_DIR, f)).size; } catch { fileSizes[f] = 0; }
  }
  res.json({
    agents: agents.length,
    tasks: tasks.length,
    projects: projects.length,
    heartbeats: hbs.length,
    task_results: results.length,
    max_heartbeats: MAX_HEARTBEATS,
    max_task_results: MAX_TASK_RESULTS,
    file_sizes_bytes: fileSizes,
    uptime_seconds: Math.round(process.uptime()),
    node_version: process.version,
    timestamp: new Date().toISOString()
  });
});

// Data integrity — clean orphaned records
app.post('/api/system/cleanup', (req, res) => {
  const tasks = loadYaml('tasks.yaml');
  const agents = loadYaml('agents.yaml');
  const taskIds = new Set(tasks.map(t => t.id));
  const agentIds = new Set(agents.map(a => a.id));
  // Clean orphaned task results
  const results = loadYaml('task_results.yaml');
  const beforeResults = results.length;
  const cleanResults = results.filter(r => taskIds.has(r.task_id));
  if (cleanResults.length !== beforeResults) saveTaskResults(cleanResults);
  // Clean orphaned heartbeats
  const hbs = loadYaml('heartbeats.yaml');
  const beforeHbs = hbs.length;
  const cleanHbs = hbs.filter(h => !h.agent_id || agentIds.has(h.agent_id));
  if (cleanHbs.length !== beforeHbs) saveHeartbeats(cleanHbs);
  // Clear stale completed_at on non-done tasks
  let clearedDates = 0;
  for (const t of tasks) {
    if (t.status !== 'done' && t.completed_at) { t.completed_at = null; clearedDates++; }
  }
  if (clearedDates > 0) saveYaml('tasks.yaml', tasks);
  res.json({
    ok: true,
    orphaned_results_removed: beforeResults - cleanResults.length,
    orphaned_heartbeats_removed: beforeHbs - cleanHbs.length,
    stale_completed_at_cleared: clearedDates
  });

// 404 for unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});});

// ===================== ERROR HANDLING MIDDLEWARE =====================

app.use((err, req, res, _next) => {
  console.error('[Error]', err.stack || err.message || err);
  const status = err.status || 500;
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
});

const server = app.listen(PORT, () => { console.log(`ClawDesk running on http://localhost:${PORT}`); startHeartbeatEngine(); });

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[Shutdown] ${signal} received, draining...`);
  // Wait for any running heartbeat cycle to finish (max 10s)
  const deadline = Date.now() + 10000;
  const check = () => {
    if (!heartbeatRunning || Date.now() > deadline) {
      console.log('[Shutdown] Goodbye');
      server.close(() => process.exit(0));
    } else {
      setTimeout(check, 200);
    }
  };
  check();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
