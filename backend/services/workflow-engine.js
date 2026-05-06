const db = require('../db');
const { nextId } = db;

// ===================== WORKFLOW ENGINE =====================
// Executes a defined workflow: ordered steps with agents.
// Steps execute sequentially, passing output context to the next step.

let _broadcastSSE = null;

function setBroadcastSSE(fn) { _broadcastSSE = fn; }

// ===================== Execute a Single Workflow Step =====================

async function executeWorkflowStep(run, step, previousContext) {
  const { executeTask } = require('./executor');

  // Resolve agent
  const agents = db.loadAgents();
  let agent = step.agent_id
    ? agents.find(a => a.openclaw_agent_id === step.agent_id || String(a.id) === String(step.agent_id))
    : null;

  if (!agent) {
    // Try to pick least-loaded active agent
    const activeAgents = agents.filter(a => a.status === 'active');
    if (activeAgents.length === 0) {
      throw new Error(`No active agents available for step "${step.task}"`);
    }
    // Simple round-robin based on current_step
    const idx = run.current_step % activeAgents.length;
    agent = activeAgents[idx];
  }

  // Build context message for this step
  let contextHint = '';
  if (previousContext) {
    contextHint = `\n\n--- PREVIOUS STEP OUTPUT (for context) ---\n${previousContext}\n`;
  }

  const taskObj = {
    id: nextId('tasks'),
    project_id: run.project_id,
    assigned_agent_id: agent.id,
    title: step.task || `Step ${run.current_step + 1}`,
    description: (step.description || '') + contextHint,
    status: 'pending',
    priority: step.priority || 'medium',
    dependency_id: null,
    dependency_ids: null,
    creates_agent: step.creates_agent || null,
    created_by_agent_id: null,
    created_at: new Date().toISOString(),
    scheduled_at: step.scheduled_at || null,
    requires_approval: step.requires_approval ? 1 : 0,
  };

  const tasks = db.loadTasks();
  tasks.push(taskObj);
  db.saveTasks(tasks);

  if (_broadcastSSE) _broadcastSSE('workflow_step_started', { run_id: run.id, step: run.current_step + 1, task_id: taskObj.id, agent: agent.name });

  // Execute the task synchronously
  const { setTaskStatus } = require('./heartbeat');
  setTaskStatus(taskObj.id, 'in_progress');

  try {
    const result = await executeTask(agent, taskObj);

    // Merge step context into workflow run context
    const updatedRuns = db.loadWorkflowRuns();
    const r = updatedRuns.find(x => x.id === run.id);
    if (r) {
      const ctx = typeof r.context === 'string' ? JSON.parse(r.context) : (r.context || {});
      ctx[`step_${run.current_step}`] = {
        agent: agent.name,
        task_title: step.task,
        result: result.action,
        output_preview: result.output ? String(result.output).substring(0, 500) : null,
      };
      r.context = JSON.stringify(ctx);
      db.saveWorkflowRuns(updatedRuns);
    }

    if (_broadcastSSE) _broadcastSSE('workflow_step_done', { run_id: run.id, step: run.current_step + 1, result: result.action, agent: agent.name });

    return {
      ...result,
      agent_name: agent.name,
      task_id: taskObj.id,
    };
  } catch (e) {
    if (_broadcastSSE) _broadcastSSE('workflow_step_error', { run_id: run.id, step: run.current_step + 1, error: e.message });
    throw e;
  }
}

// ===================== Run a Complete Workflow =====================

async function runWorkflow(workflowRunId, template) {
  const runs = db.loadWorkflowRuns();
  const run = runs.find(x => x.id === workflowRunId);
  if (!run) throw new Error(`Workflow run #${workflowRunId} not found`);

  let steps = run.steps;
  if (typeof steps === 'string') {
    try { steps = JSON.parse(steps); } catch { steps = []; }
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Workflow has no steps');
  }

  // Set step outcomes
  let stepResults = [];
  let lastOutput = null;

  for (let i = run.current_step; i < steps.length; i++) {
    const step = steps[i];
    const stepRun = { ...run, current_step: i };

    // Update current_step in DB
    const allRuns = db.loadWorkflowRuns();
    const r = allRuns.find(x => x.id === workflowRunId);
    if (r) {
      r.current_step = i;
      db.saveWorkflowRuns(allRuns);
    }

    try {
      const result = await executeWorkflowStep(stepRun, step, lastOutput);
      stepResults.push(result);
      lastOutput = result.output || result.summary || JSON.stringify(result);
    } catch (e) {
      // Mark workflow as failed
      const allRuns2 = db.loadWorkflowRuns();
      const r2 = allRuns2.find(x => x.id === workflowRunId);
      if (r2) {
        r2.status = 'failed';
        const ctx2 = typeof r2.context === 'string' ? JSON.parse(r2.context) : (r2.context || {});
        ctx2.error = { step: i + 1, message: e.message };
        r2.context = JSON.stringify(ctx2);
        db.saveWorkflowRuns(allRuns2);
      }
      if (_broadcastSSE) _broadcastSSE('workflow_done', { run_id: workflowRunId, status: 'failed', error: e.message });
      throw e;
    }
  }

  // All steps done — mark workflow complete
  const allRuns = db.loadWorkflowRuns();
  const r = allRuns.find(x => x.id === workflowRunId);
  if (r) {
    r.status = 'completed';
    r.completed_at = new Date().toISOString();
    const ctx = typeof r.context === 'string' ? JSON.parse(r.context) : (r.context || {});
    ctx.final_output = lastOutput ? String(lastOutput).substring(0, 1000) : null;
    ctx.step_count = steps.length;
    r.context = JSON.stringify(ctx);
    db.saveWorkflowRuns(allRuns);
  }

  if (_broadcastSSE) _broadcastSSE('workflow_done', { run_id: workflowRunId, status: 'completed', steps_completed: steps.length });

  return {
    run_id: workflowRunId,
    status: 'completed',
    steps_completed: steps.length,
    step_results: stepResults,
    final_output: lastOutput,
  };
}

// ===================== Create and Start a Workflow =====================

async function createAndStartWorkflow(projectId, title, steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('steps must be a non-empty array');
  }

  // Validate each step has an agent or will be auto-assigned
  // and each step has a task description
  for (const step of steps) {
    if (!step.task) throw new Error('Each step must have a task field');
  }

  const now = new Date().toISOString();
  const id = db.insertWorkflowRun({
    id: nextId('workflow_runs'),
    project_id: projectId,
    title: title || `Workflow ${Date.now()}`,
    status: 'running',
    created_at: now,
    completed_at: null,
    steps: JSON.stringify(steps),
    current_step: 0,
    context: '{}',
  });

  const run = { id, project_id: projectId, title, status: 'running', created_at: now, steps, current_step: 0, context: {} };

  if (_broadcastSSE) _broadcastSSE('workflow_started', { run_id: id, project_id: projectId, title, steps: steps.length });

  // Run asynchronously (don't block the HTTP response)
  setImmediate(async () => {
    try {
      await runWorkflow(id, steps);
    } catch (e) {
      console.error(`[Workflow ${id}] Failed: ${e.message}`);
    }
  });

  return { run_id: id, status: 'running', steps_count: steps.length };
}

module.exports = {
  runWorkflow,
  createAndStartWorkflow,
  executeWorkflowStep,
  setBroadcastSSE,
};
