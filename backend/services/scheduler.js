const db = require('../db');
const { nextId } = db;

// ===================== SCHEDULER SERVICE =====================
// Runs as part of the backend loop, checks for due scheduled tasks
// and triggers them with load-balancing across agents.

let _broadcastSSE = null;
let _setTaskStatus = null;

function setBroadcastSSE(fn) { _broadcastSSE = fn; }
function setSetTaskStatus(fn) { _setTaskStatus = fn; }

// ===================== Load Balancing =====================

function getAgentLoadCounts() {
  // Returns a map of agent_id -> number of in_progress tasks
  const tasks = db.loadTasks();
  const counts = {};
  for (const t of tasks) {
    if (t.status === 'in_progress' && t.assigned_agent_id) {
      counts[t.assigned_agent_id] = (counts[t.assigned_agent_id] || 0) + 1;
    }
  }
  return counts;
}

function pickLeastLoadedAgent(agentIds) {
  if (!agentIds || agentIds.length === 0) return null;
  const loads = getAgentLoadCounts();
  let best = null;
  let minLoad = Infinity;
  for (const aid of agentIds) {
    const load = loads[aid] || 0;
    if (load < minLoad) { minLoad = load; best = aid; }
  }
  return best;
}

// ===================== Task Dependency Check =====================

function isTaskSatisfied(task, allTasks) {
  if (!task.dependency_id && !task.dependency_ids) return true;
  const done = (t) => t.status === 'done';
  if (task.dependency_id) {
    const dep = allTasks.find(d => d.id === task.dependency_id);
    if (!dep || !done(dep)) return false;
  }
  if (task.dependency_ids) {
    try {
      const ids = JSON.parse(task.dependency_ids);
      for (const id of ids) {
        const dep = allTasks.find(d => d.id === id);
        if (!dep || !done(dep)) return false;
      }
    } catch { return false; }
  }
  return true;
}

// ===================== Trigger Rule Processing =====================

function processTriggerRules(projectId, completedTaskId) {
  const projects = db.loadProjects();
  const p = projects.find(x => x.id === projectId);
  if (!p || !p.trigger_rules) return;

  let rules = p.trigger_rules;
  if (typeof rules === 'string') {
    try { rules = JSON.parse(rules); } catch { return; }
  }
  if (!Array.isArray(rules)) return;

  for (const rule of rules) {
    if (rule.when !== 'task_done') continue;
    if (rule.task_id && +rule.task_id !== +completedTaskId) continue;

    const newTask = {
      id: nextId('tasks'),
      project_id: projectId,
      title: rule.then_create_task?.title || `Follow-up from task #${completedTaskId}`,
      description: rule.then_create_task?.description || '',
      status: 'pending',
      priority: rule.then_create_task?.priority || 'medium',
      assigned_agent_id: null,
      dependency_id: null,
      dependency_ids: null,
      creates_agent: null,
      created_by_agent_id: null,
      created_at: new Date().toISOString(),
      scheduled_at: rule.then_create_task?.scheduled_at || null,
      requires_approval: rule.then_create_task?.requires_approval ? 1 : 0,
    };

    if (rule.then_create_task?.assigned_to_agent_id) {
      const agents = db.loadAgents();
      const agent = agents.find(a => a.openclaw_agent_id === rule.then_create_task.assigned_to_agent_id || String(a.id) === String(rule.then_create_task.assigned_to_agent_id));
      if (agent) newTask.assigned_agent_id = agent.id;
    }

    const tasks = db.loadTasks();
    tasks.push(newTask);
    db.saveTasks(tasks);
    console.log(`[Scheduler] Trigger rule auto-created task #${newTask.id}: "${newTask.title}"`);
  }
}

// ===================== SCHEDULER TICK =====================

async function runSchedulerTick() {
  const db = require('../db');
  const { executeTask } = require('./executor');
  const now = new Date();

  // Find tasks that are scheduled for now (or past) and not yet executed
  let allTasks = db.loadTasks();
  const dueTasks = allTasks.filter(t => {
    if (t.status !== 'pending') return false;
    if (!t.scheduled_at) return false;
    const scheduledTime = new Date(t.scheduled_at);
    return scheduledTime <= now;
  });

  if (dueTasks.length === 0) return { triggered: 0 };

  const agents = db.loadAgents().filter(a => a.status === 'active');
  const triggered = [];

  for (const task of dueTasks) {
    // Re-check that task is still in pending state
    const tasks = db.loadTasks();
    const currentTask = tasks.find(t => t.id === task.id);
    if (!currentTask || currentTask.status !== 'pending') continue;

    // Resolve assigned agent with load balancing
    let agent = null;
    if (currentTask.assigned_agent_id) {
      agent = agents.find(a => a.id === currentTask.assigned_agent_id);
    }

    if (!agent) {
      // No agent assigned — pick least loaded active agent
      const activeAgentIds = agents.map(a => a.id);
      const leastLoadedId = pickLeastLoadedAgent(activeAgentIds);
      if (leastLoadedId) {
        agent = agents.find(a => a.id === leastLoadedId);
        currentTask.assigned_agent_id = agent.id;
        db.saveTasks(tasks);
      }
    }

    if (!agent) {
      console.log(`[Scheduler] No agents available for scheduled task #${task.id}: "${task.title}"`);
      continue;
    }

    // Mark as in_progress and execute
    const { setTaskStatus } = require('./heartbeat');
    setTaskStatus(currentTask.id, 'in_progress');

    try {
      const result = await executeTask(agent, currentTask);
      triggered.push({ task_id: currentTask.id, agent: agent.name, result: result.action });
      console.log(`[Scheduler] Triggered task #${currentTask.id} "${currentTask.title}" on agent ${agent.name} → ${result.action}`);

      // After task completes, process trigger rules
      if (result.action === 'completed') {
        processTriggerRules(currentTask.project_id, currentTask.id);
      }
    } catch (e) {
      console.error(`[Scheduler] Error executing task #${currentTask.id}: ${e.message}`);
      const { setTaskStatus } = require('./heartbeat');
      setTaskStatus(currentTask.id, 'failed');
      triggered.push({ task_id: currentTask.id, agent: agent.name, result: 'error', error: e.message });
    }
  }

  return { triggered: triggered.length, details: triggered };
}

// ===================== APPROVAL GATE PROCESSING =====================

function createApprovalRequest(taskId) {
  const id = nextId('approvals');
  db.prepare(`INSERT INTO approvals (id,task_id,status,requested_at,resolved_at,resolved_by,notes)
    VALUES (?,?,?,?,?,?,?)`)
    .run(id, taskId, 'pending', new Date().toISOString(), null, null, '');
  console.log(`[Scheduler] Created approval request #${id} for task #${taskId}`);
  return id;
}

function checkAndCreateApproval(task) {
  if (!task.requires_approval) return null;
  return createApprovalRequest(task.id);
}

// ===================== START SCHEDULER =====================

let schedulerInterval = null;

function startScheduler(intervalMs = 30000) {
  if (schedulerInterval) return; // already running
  schedulerInterval = setInterval(async () => {
    try {
      const r = await runSchedulerTick();
      if (r.triggered > 0) {
        console.log(`[Scheduler tick] triggered ${r.triggered} task(s)`);
        if (_broadcastSSE) _broadcastSSE('scheduler', { results: r, ts: Date.now() });
      }
    } catch (e) {
      console.error('[Scheduler tick]', e.message);
    }
  }, intervalMs);
  console.log(`[Scheduler] Started (interval: ${intervalMs}ms)`);
}

function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Stopped');
  }
}

function isSchedulerRunning() {
  return schedulerInterval !== null;
}

module.exports = {
  runSchedulerTick,
  startScheduler,
  stopScheduler,
  isSchedulerRunning,
  setBroadcastSSE,
  setSetTaskStatus,
  processTriggerRules,
  createApprovalRequest,
  checkAndCreateApproval,
  pickLeastLoadedAgent,
  getAgentLoadCounts,
};
