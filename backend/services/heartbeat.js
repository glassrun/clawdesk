const db = require('../db');
const { nextId } = db;

// These are set by server.js when registering the route
let _broadcastSSE = null;
let _setTaskStatus = null;
let _syncFromOpenClaw = null;

function setBroadcastSSE(fn) { _broadcastSSE = fn; }
function setSetTaskStatus(fn) { _setTaskStatus = fn; }
function setSyncFromOpenClaw(fn) { _syncFromOpenClaw = fn; }

module.exports = { runHeartbeatCycle, triggerHeartbeat, startHeartbeatEngine, setBroadcastSSE, setSetTaskStatus, setSyncFromOpenClaw, getStats, isRunning };

// ===================== TRACKING HELPERS =====================

function setTaskStatus(taskId, newStatus) {
  if (_setTaskStatus) return _setTaskStatus(taskId, newStatus);
  // Fallback inline implementation
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
      ...t,
      id: nextId('tasks'),
      status: 'pending',
      created_at: new Date().toISOString(),
      _status_changed_at: null,
      completed_at: null,
      _retry_count: 0,
      run_count: (t.run_count || 0) + 1
    };
    tasks.push(newTask);
    db.saveTasks(tasks);
    console.log(`[Recurring] Task "${t.title}" completed, created repeat run #${newTask.run_count}`);
  }
  return t;
}

// ===================== TASK EXECUTION (imported from executor lazily) =====================

// ===================== TRIGGER HEARTBEAT =====================

async function triggerHeartbeat(agent, heartbeatBatch) {
  const tasks = db.loadTasks();
  const pending = tasks.filter(t => t.assigned_agent_id === agent.id && t.status === 'pending' && (!t.dependency_id || tasks.find(d => d.id === t.dependency_id)?.status === 'done')).sort((a, b) => {
    const pri = { high: 0, medium: 1, low: 2 };
    const pa = pri[a.priority] ?? 1, pb = pri[b.priority] ?? 1;
    return pa !== pb ? pa - pb : a.id - b.id;
  });
  if (pending.length === 0) {
    const agents = db.loadAgents();
    const a = agents.find(x => x.id === agent.id);
    if (a) a.last_heartbeat = new Date().toISOString();
    db.saveAgents(agents);
    const entry = { agent_id: agent.id, triggered_at: new Date().toISOString(), action_taken: { action: 'no_pending_tasks' }, status: 'idle' };
    if (heartbeatBatch) { heartbeatBatch.push(entry); } else { const hbs = db.loadHeartbeats(); hbs.push({ id: nextId('heartbeats'), ...entry, action_taken: JSON.stringify(entry.action_taken) }); db.saveHeartbeats(hbs); }
    return { agent: agent.name, action: 'idle' };
  }
  const task = pending[0];
  setTaskStatus(task.id, 'in_progress');
  try {
    const { executeTask } = require('./executor');
    const result = await executeTask(agent, task);
    const agents = db.loadAgents();
    const a = agents.find(x => x.id === agent.id);
    if (a) a.last_heartbeat = new Date().toISOString();
    db.saveAgents(agents);
    const entry = { agent_id: agent.id, triggered_at: new Date().toISOString(), action_taken: result, status: result.action === 'failed' ? 'error' : 'ok' };
    if (heartbeatBatch) { heartbeatBatch.push(entry); } else { const hbs = db.loadHeartbeats(); hbs.push({ id: nextId('heartbeats'), ...entry, action_taken: JSON.stringify(entry.action_taken) }); db.saveHeartbeats(hbs); }
    return { agent: agent.name, ...result };
  } catch (err) {
    setTaskStatus(task.id, 'pending');
    const agents = db.loadAgents();
    const a = agents.find(x => x.id === agent.id);
    if (a) a.last_heartbeat = new Date().toISOString();
    db.saveAgents(agents);
    const entry = { agent_id: agent.id, triggered_at: new Date().toISOString(), action_taken: { action: 'error', error: err.message }, status: 'error' };
    if (heartbeatBatch) { heartbeatBatch.push(entry); } else { const hbs = db.loadHeartbeats(); hbs.push({ id: nextId('heartbeats'), ...entry, action_taken: JSON.stringify(entry.action_taken) }); db.saveHeartbeats(hbs); }
    return { agent: agent.name, action: 'error', error: err.message };
  }
}

// ===================== HEARTBEAT ENGINE =====================

let heartbeatRunning = false;
let heartbeatStats = { cycles: 0, totalMs: 0, agentsProcessed: 0, errors: 0, lastCycleMs: 0, last10Ms: [] };

async function runHeartbeatCycle() {
  heartbeatRunning = true;
  const cycleStart = Date.now();
  let results = [];
  const cycleHeartbeats = [];
  const cycleIdBase = (db.db.prepare('SELECT MAX(id) as maxId FROM heartbeats').get().maxId || 0);
  try {
    const tasks = db.loadTasks();
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
      db.saveTasks(tasks);
      if (stuckResetLog.length > 0) {
        console.log(`[Heartbeat] Reset ${stuckResetLog.length} stuck task(s): ${stuckResetLog.map(s => s.title).join(', ')}`);
        for (const s of stuckResetLog) {
          cycleHeartbeats.push({ agent_id: null, triggered_at: new Date().toISOString(), action_taken: { action: 'stuck_reset', ...s }, status: 'warning' });
        }
      }
    }

    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    let retryChanged = false;
    const retryLog = [];
    for (const t of tasks) {
      if (t.status === 'failed') {
        t.retry_count = t.retry_count || 0;
        const changedAt = t._status_changed_at || t.created_at;
        if (changedAt < fifteenMinAgo && t.retry_count < 3) {
          t.status = 'pending';
          t.retry_count += 1;
          delete t._status_changed_at;
          retryChanged = true;
          retryLog.push({ task_id: t.id, title: t.title, attempt: t.retry_count, failed_since: changedAt });
        }
      }
    }
    if (retryChanged) {
      db.saveTasks(tasks);
      if (retryLog.length > 0) {
        console.log(`[Heartbeat] Auto-retry: ${retryLog.length} failed task(s): ${retryLog.map(s => `${s.title} (${s.attempt}/3)`).join(', ')}`);
        for (const s of retryLog) {
          cycleHeartbeats.push({ agent_id: null, triggered_at: new Date().toISOString(), action_taken: { action: 'auto_retry', ...s }, status: 'ok' });
        }
      }
    }

    const now = new Date();
    const agents = db.loadAgents().filter(a => a.heartbeat_enabled && a.status === 'active');
    const heartbeatPromises = [];
    for (const agent of agents) {
      if (agent.last_heartbeat && (now - new Date(agent.last_heartbeat)) / 1000 < agent.heartbeat_interval) continue;
      heartbeatPromises.push(
        (async () => {
          try {
            const hbPromise = triggerHeartbeat(agent, cycleHeartbeats);
            const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('heartbeat timeout (600s)')), 600000));
            return await Promise.race([hbPromise, timeoutPromise]);
          } catch (e) {
            console.error(`[Heartbeat] ${agent.name}: ${e.message}`);
            return { agent: agent.name, action: 'error', error: e.message };
          }
        })()
      );
    }

    results = await Promise.all(heartbeatPromises);
    if (_broadcastSSE) _broadcastSSE('heartbeat', { results, ts: Date.now() });
    if (cycleHeartbeats.length > 0) {
      let idCounter = cycleIdBase;
      const entries = cycleHeartbeats.map(hb => ({ id: ++idCounter, ...hb, action_taken: JSON.stringify(hb.action_taken) }));
      const hbs = db.loadHeartbeats();
      hbs.push(...entries);
      db.saveHeartbeats(hbs);
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
    if (results.length > 0 && _broadcastSSE) _broadcastSSE('heartbeat', { results, ts: Date.now() });
    if (heartbeatStats.cycles % 50 === 0 && heartbeatStats.cycles > 0) {
      const taskIds = new Set(db.loadTasks().map(t => t.id));
      const before = db.loadTaskResults().length;
      const clean = db.loadTaskResults().filter(r => taskIds.has(r.task_id));
      if (clean.length !== before) { db.saveTaskResults(clean); console.log(`[Cleanup] Removed ${before - clean.length} orphaned task results`); }
    }
  }
}

function startHeartbeatEngine() {
  setInterval(async () => {
    try {
      const r = await runHeartbeatCycle();
      if (r.length > 0) {
        console.log(`[Heartbeat] ${r.map(x => `${x.agent}→${x.action}`).join(', ')}`);
        if (_broadcastSSE) _broadcastSSE('heartbeat', { results: r, ts: Date.now() });
      }
    } catch (e) { console.error('[Heartbeat]', e.message); }
  }, 1000);
  console.log('[Heartbeat] Engine started (1s interval)');
}

function getStats() {
  return {
    cycles: heartbeatStats.cycles,
    totalMs: heartbeatStats.totalMs,
    agentsProcessed: heartbeatStats.agentsProcessed,
    errors: heartbeatStats.errors,
    lastCycleMs: heartbeatStats.lastCycleMs,
    last10Ms: heartbeatStats.last10Ms
  };
}

function isRunning() { return heartbeatRunning; }