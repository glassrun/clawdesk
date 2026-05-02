const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const db = require('./db');
const { nextId } = db;
const cors = require('cors');

// ===================== GLOBAL ERROR HANDLERS =====================

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught Exception:', err);
  process.exit(1);
});

// ===================== RETRY HELPER =====================

async function withRetry(fn, opts = {}) {
  const maxRetries = opts.maxRetries || 3;
  const baseDelay = opts.baseDelay || 1000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const isRetryable = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED' || err.message?.includes('SQLITE_BUSY');
      if (!isRetryable) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`[Retry] ${err.message}, waiting ${delay}ms (attempt ${attempt}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ===================== APP SETUP =====================

const app = express();
const PORT = process.env.PORT || 3777;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const OPENCLAW_CLI = (() => {
  const val = process.env.OPENCLAW_CLI;
  // Use if set to a non-empty, non-numeric value that looks like a path/command
  if (val && val.trim() && !/^\d+$/.test(val) && (val.includes('/') || val.startsWith('openclaw'))) return val.trim();
  return 'openclaw';
})();
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ===================== SSE CLIENTS =====================

let sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = JSON.stringify({ event, data, ts: Date.now() });
  for (const client of sseClients) {
    try { client.write(`event: ${event}\ndata: ${payload}\n\n`); } catch(e) { sseClients.delete(client); }
  }
}

function broadcastTaskUpdate(tasks) {
  if (sseClients.size > 0) broadcastSSE('tasks', { tasks, ts: Date.now() });
}

// ===================== MIDDLEWARE =====================

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

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

// ===================== SHARED STATE FOR ROUTES =====================

const ctx = { db, broadcastSSE, broadcastTaskUpdate, nextId };

// ===================== SYNC FROM OPENCLAW =====================

let syncInProgress = false;

function syncFromOpenClaw() {
  if (syncInProgress) {
    return Promise.resolve({ synced: [], added: 0, updated: 0, removed: 0, source: 'cli', skipped: true });
  }
  syncInProgress = true;
  const CLI = OPENCLAW_CLI;
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    const cp = exec(`${CLI} agents list --json`, (err, stdout, stderr) => {
      if (err) { syncInProgress = false; reject(new Error(`CLI error: ${err.message}`)); return; }
      try {
        const cliAgents = JSON.parse(stdout);
        console.log(`[Sync] CLI returned ${cliAgents.length} agents: ${cliAgents.map(a=>a.id).join(', ')}`);
        const agents = db.loadAgents();
        console.log(`[Sync] DB had ${agents.length} agents before merge`);
        const existingMap = new Map(agents.map(a => [a.openclaw_agent_id, a]));
        let added = 0, updated = 0;
        // Pre-compute next new IDs before any DELETE to avoid nextId() returning same value for all new agents
        let nextNewId = nextId('agents');
        for (const ca of cliAgents) {
          const id = ca.id;
          if (existingMap.has(id)) {
            const e = existingMap.get(id);
            e.name = ca.identityName || ca.name || id;
            e.status = 'active';
            updated++;
          } else {
            agents.push({ id: nextNewId++, openclaw_agent_id: id, name: ca.identityName || ca.name || id, status: 'active', budget_limit: 0, budget_spent: 0, heartbeat_enabled: 1, heartbeat_interval: 60, last_heartbeat: null, tasks_done: 0, tasks_failed: 0, created_at: new Date().toISOString(), model: ca.model || 'minimax/MiniMax-M2.7' });
            added++;
          }
        }
        const cliIds = new Set(cliAgents.map(ca => ca.id));
        const filtered = agents.filter(a => cliIds.has(a.openclaw_agent_id));
        console.log(`[Sync] Saving ${filtered.length} agents (added=${added}, updated=${updated})`);
        try {
          db.saveAgents(filtered);
        } catch (saveErr) {
          if (saveErr.message.includes('UNIQUE constraint failed')) {
            console.log(`[Sync] UNIQUE constraint hit, retrying with INSERT OR REPLACE`);
            db.saveAgentsIdempotent(filtered);
          } else throw saveErr;
        }
        syncInProgress = false;
        resolve({ synced: filtered.map(a => a.openclaw_agent_id), added, updated, removed: 0, source: 'cli' });
      } catch (e) { syncInProgress = false; reject(new Error(`CLI parse error: ${e.message}`)); }
    });
    cp.on('error', err => { syncInProgress = false; reject(new Error('exec error: ' + err.message)); });
  });
}

// ===================== SET TASK STATUS (shared helper) =====================

function setTaskStatus(taskId, newStatus) {
  const tasks = db.loadTasks();
  const t = tasks.find(x => x.id === taskId);
  if (!t) return null;
  const oldStatus = t.status;
  t.status = newStatus;
  t._status_changed_at = new Date().toISOString();
  if (newStatus === 'done') t.completed_at = new Date().toISOString();
  else if (oldStatus === 'done') t.completed_at = null;
  db.saveTasks(tasks);
  if (newStatus === 'done') {
    const projectTasks = tasks.filter(x => x.project_id === t.project_id);
    if (projectTasks.length > 0 && projectTasks.every(x => x.status === 'done')) {
      const projects = db.loadProjects();
      const p = projects.find(x => x.id === t.project_id);
      if (p && p.status === 'active') { p.status = 'completed'; db.saveProjects(projects); console.log(`[Auto] Project "${p.title}" marked completed - all tasks done`); }
    }
  }
  if (oldStatus === 'done' && newStatus !== 'done') {
    const projects = db.loadProjects();
    const p = projects.find(x => x.id === t.project_id);
    if (p && p.status === 'completed') { p.status = 'active'; db.saveProjects(projects); console.log(`[Auto] Project "${p.title}" reopened - task un-completed`); }
  }
  if (newStatus === 'done' && t.repeat === true) {
    const tasks = db.loadTasks();
    const newTask = {
      ...t, id: nextId('tasks'), status: 'pending',
      created_at: new Date().toISOString(), _status_changed_at: null,
      completed_at: null, _retry_count: 0,
      run_count: (t.run_count || 0) + 1
    };
    tasks.push(newTask);
    db.saveTasks(tasks);
    console.log(`[Recurring] Task "${t.title}" completed, created repeat run #${newTask.run_count}`);
  }
  return t;
}

// Register setTaskStatus with heartbeat service
const heartbeat = require('./services/heartbeat');
heartbeat.setBroadcastSSE(broadcastSSE);
heartbeat.setSetTaskStatus(setTaskStatus);
heartbeat.setSyncFromOpenClaw(syncFromOpenClaw);

// ===================== ROUTES =====================

// Self-documenting API index
app.get('/api', (req, res) => {
  res.json({
    name: 'ClawDesk', version: '1.0.0',
    endpoints: {
      health: ['GET /health', 'GET /health/ready'],
      agents: ['GET /api/agents', 'POST /api/agents', 'GET /api/agents/:id', 'PUT /api/agents/:id', 'DELETE /api/agents/:id', 'GET /api/agents/:id/stats', 'GET /api/agents/:id/tasks', 'POST /api/agents/:id/heartbeat', 'POST /api/agents/id/reactivate', 'POST /api/agents/sync'],
      projects: ['GET /api/projects', 'POST /api/projects', 'GET /api/projects/:id', 'PUT /api/projects/:id', 'DELETE /api/projects/:id', 'GET /api/projects/:id/stats', 'GET /api/projects/:id/tasks', 'POST /api/projects/:id/tasks', 'POST /api/projects/:id/tasks/from-agent', 'POST /api/projects/:id/reopen'],
      tasks: ['GET /api/tasks', 'GET /api/tasks/summary', 'GET /api/tasks/:id', 'PUT /api/tasks/:id', 'DELETE /api/tasks/:id', 'GET /api/tasks/:id/results', 'GET /api/tasks/:id/history', 'GET /api/tasks/:id/chain', 'GET /api/tasks/:id/dependents', 'POST /api/tasks/:id/run', 'POST /api/tasks/:id/retry', 'POST /api/tasks/:id/cancel', 'POST /api/tasks/:id/duplicate', 'POST /api/tasks/:id/assign', 'POST /api/tasks/:id/notes', 'POST /api/tasks/bulk'],
      heartbeats: ['GET /api/heartbeats', 'POST /api/heartbeats/tick'],
      system: ['GET /api/system/stats', 'POST /api/system/cleanup', 'POST /api/system/vacuum'],
      dashboard: ['GET /api/dashboard']
    },
    docs: { tasks: 'Supports ?status, ?priority, ?agent_id, ?project_id, ?search, ?sort_by, ?sort_dir, ?page, ?limit filters' }
  });
});

// Agent sync
app.post('/api/agents/sync', async (req, res) => {
  try { const r = await syncFromOpenClaw(); res.json({ ok: true, synced: r.synced, count: r.synced.length }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mount route modules
const agentsRouter = express.Router();
require('./routes/agents')(agentsRouter, { ...ctx, setTaskStatus });
app.use('/api/agents', agentsRouter);

const projectsRouter = express.Router();
require('./routes/projects')(projectsRouter, { ...ctx, setTaskStatus });
app.use('/api/projects', projectsRouter);

const tasksRouter = express.Router();
require('./routes/tasks')(tasksRouter, { ...ctx, setTaskStatus, broadcastTaskUpdate });
app.use('/api/tasks', tasksRouter);

const streamRouter = express.Router();
require('./routes/stream')(streamRouter, { sseClients, broadcastSSE });
app.use('/api/stream', streamRouter);

const systemRouter = express.Router();
const systemCtx = { db, broadcastSSE };
require('./routes/system')(systemRouter, systemCtx);
app.use('/api/system', systemRouter);

// Heartbeats standalone route
const heartbeatsRouter = express.Router();
require('./routes/heartbeats')(heartbeatsRouter, { db, runHeartbeatCycle: heartbeat.runHeartbeatCycle });
app.use('/api/heartbeats', heartbeatsRouter);

// Health endpoints
app.get('/health/ready', (req, res) => { res.json({ status: 'ready', timestamp: new Date().toISOString() }); });
app.get('/health', (req, res) => {
  const agents = db.loadAgents();
  const tasks = db.loadTasks();
  const hb = heartbeat;
  const hbStats = hb.getStats();
  res.json({
    status: 'ok', uptime: process.uptime(),
    agents: agents.length,
    active_tasks: tasks.filter(t => ['pending', 'in_progress'].includes(t.status)).length,
    failed_tasks: tasks.filter(t => t.status === 'failed').length,
    heartbeat: {
      cycles: hbStats.cycles,
      avgMs: hbStats.cycles > 0 ? Math.round(hbStats.totalMs / hbStats.cycles) : 0,
      lastMs: hbStats.lastCycleMs,
      recentAvgMs: hbStats.last10Ms.length > 0 ? Math.round(hbStats.last10Ms.reduce((a,b) => a+b, 0) / hbStats.last10Ms.length) : 0,
      agentsProcessed: hbStats.agentsProcessed,
      errors: hbStats.errors,
      running: hb.isRunning()
    },
    timestamp: new Date().toISOString()
  });
});

// Dashboard (standalone)
app.get('/api/dashboard', (req, res) => {
  const agents = db.loadAgents();
  const tasks = db.loadTasks();
  const projects = db.loadProjects();
  const hbs = db.loadHeartbeats();
  const recentHbs = hbs.sort((a, b) => b.id - a.id).slice(0, 10);
  res.json({
    total_agents: agents.length,
    active_tasks: tasks.filter(t => ['pending', 'in_progress'].includes(t.status)).length,
    completed_tasks: tasks.filter(t => t.status === 'done').length,
    failed_tasks: tasks.filter(t => t.status === 'failed').length,
    total_spent: agents.reduce((s, a) => s + (a.budget_spent || 0), 0),
    agents: agents.map(a => {
      const at = tasks.filter(t => t.assigned_agent_id === a.id);
      return { ...a, tasks_pending: at.filter(t => t.status === 'pending').length, tasks_in_progress: at.filter(t => t.status === 'in_progress').length, tasks_done: at.filter(t => t.status === 'done').length, tasks_failed: at.filter(t => t.status === 'failed').length, tasks_total: at.length };
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

// ===================== ERROR HANDLING MIDDLEWARE =====================

app.use((err, req, res, _next) => {
  console.error('[Error]', err.stack || err.message || err);
  const status = err.status || 500;
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
});

// ===================== SERVER START =====================

const server = app.listen(PORT, () => {
  console.log(`ClawDesk running on http://localhost:${PORT}`);
  syncFromOpenClaw().then(r => { console.log(`[Init] Synced ${r.synced.length} agent(s) from OpenClaw (source: ${r.source})`); }).catch(e => { console.log(`[Init] OpenClaw sync failed: ${e.message}`); });
  heartbeat.startHeartbeatEngine();
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[Shutdown] ${signal} received, draining...`);
  const deadline = Date.now() + 10000;
  const check = () => {
    if (!heartbeat.isRunning() || Date.now() > deadline) {
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