const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const projectBrain = require('./project-brain');
const { nextId } = require('../db');
const OPENCLAW_CLI = (() => {
  const val = process.env.OPENCLAW_CLI;
  if (!val || val === '1' || !val.trim()) return 'openclaw';
  if (val.includes('/') || val.startsWith('openclaw')) return val.trim();
  return 'openclaw';
})();
const OPENCLAW_NODE = process.env.OPENCLAW_NODE || '/usr/bin/node';
const OPENCLAW_MODULE = process.env.OPENCLAW_MODULE || '/home/openclaw/.npm-global/lib/node_modules/openclaw/openclaw.mjs';
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3777}`;

// ===================== SSE CONTEXT FOR STREAMING =====================

let _broadcastSSE = () => {};
let _sseClients = new Map(); // taskId -> Set<Response>
let _setTaskStatus = null;

module.exports = {
  setSSEContext(broadcastFn, clientsMap) {
    _broadcastSSE = broadcastFn;
    _sseClients = clientsMap || new Map();
  },

  setSetTaskStatus(fn) { _setTaskStatus = fn; },

  broadcastTaskStream(taskId, chunk, type) {
    const payload = JSON.stringify({ task_id: taskId, chunk, type, ts: Date.now() });
    _broadcastSSE('task_output', { task_id: taskId, chunk, type });
    const taskClients = _sseClients.get(taskId);
    if (taskClients) {
      for (const client of taskClients) {
        try { client.write(`event: task_output\ndata: ${payload}\n\n`); } catch (e) { taskClients.delete(client); }
      }
    }
  },

  broadcastTaskDone(taskId, status) {
    const payload = JSON.stringify({ task_id: taskId, status, ts: Date.now() });
    _broadcastSSE('task_done', { task_id: taskId, status });
    const taskClients = _sseClients.get(taskId);
    if (taskClients) {
      for (const client of taskClients) {
        try { client.write(`event: task_done\ndata: ${payload}\n\n`); } catch (e) { taskClients.delete(client); }
      }
    }
  },

  // Re-export CLI wrappers
  runOpenClawAgent,
  createOpenClawAgent,
  deleteOpenClawAgent,
  executeTask,
};

// ===================== OPENCLAW AGENT CLI WRAPPERS =====================

function runOpenClawAgent(agentId, message, cwd, onChunk) {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCLAW_CLI, ['agent', '--agent', agentId, '--message', message, '--json'], { cwd });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => {
      const text = d.toString();
      stdout += text;
      if (onChunk) onChunk(text, 'stdout');
    });
    child.stderr.on('data', d => {
      const text = d.toString();
      if (onChunk) onChunk(text, 'stderr');
    });
    child.on('error', err => reject(new Error('spawn error: ' + err.message)));
    child.on('close', code => {
      let result = null;
      if (stdout && stdout.trim()) {
        try { result = JSON.parse(stdout.trim()); } catch {
          // Check for success marker first
          const marker = 'TASK_SUCCESS_CONFIRMED';
          if (stdout.includes(marker)) {
            return resolve({ status: 'ok', summary: 'completed', _raw: stdout.trim().substring(0, 2000) });
          }
          // No marker → treat as failure even with exit 0 (likely an error msg)
          const errMsg = 'openclaw agent did not emit TASK_SUCCESS_CONFIRMED — treating as failed';
          reject(new Error(errMsg + '\nOutput: ' + stdout.trim().substring(0, 500)));
          return;
        }
      }
      if (result && result.status === 'ok') return resolve(result);
      if (result && !code) return resolve(result);
      if (code && result) return resolve(result);
      if (stdout && stdout.trim().length > 0) return resolve({ status: 'ok', summary: 'completed', _raw: stdout.trim().substring(0, 2000) });
      const errMsg = 'openclaw agent returned no output';
      const stderrSnippet = stderr ? stderr.trim().substring(0, 500) : '';
      reject(new Error(errMsg + (stderrSnippet ? '\n' + stderrSnippet : '')));
    });
  });
}

function createOpenClawAgent(agentId, name, workspace, opts = {}) {
  return new Promise((resolve, reject) => {
    const wsDir = workspace || path.join(process.env.HOME, `.openclaw/workspace-${agentId}`);
    const { spawnSync } = require('child_process');
    const cmd = `${OPENCLAW_CLI} agents add "${agentId}" --non-interactive --workspace "${wsDir}" --json`;
    const result = spawnSync(cmd, { shell: true });
    const output = (result.stdout || '').toString() + (result.stderr || '').toString();
    if (result.status !== 0 && !output.includes('already exists')) {
      reject(new Error(`Failed: exit ${result.status}\n${output.substring(0, 500)}`));
      return;
    }
    fs.mkdirSync(wsDir, { recursive: true });
    const emoji = opts.emoji || '🤖';
    const vibe = opts.vibe || 'helpful and focused';
    fs.writeFileSync(path.join(wsDir, 'IDENTITY.md'), `# IDENTITY.md\n\n- **Name:** ${name}\n- **Role:** ${vibe}\n- **Creature:** AI agent\n- **Vibe:** ${vibe.split('.').filter(s=>s.trim())[0].split(',').slice(0,2).map(s=>s.trim()).join(', ') || 'focused and effective'}\n- **Emoji:** ${emoji}\n`);
    fs.writeFileSync(path.join(wsDir, 'SOUL.md'), `# SOUL.md\n\nYou are ${name}. ${vibe}. Be resourceful, direct, and actually do the work - don't just say you did.\n`);
    fs.writeFileSync(path.join(wsDir, 'CAPABILITIES.md'), `# CAPABILITIES.md — ${name}\n\n- **Specialties:** ${vibe || 'general purpose'}\n- **Agent ID:** ${agentId}\n- **Created:** ${new Date().toISOString()}\n`);
    const idCmd = `${OPENCLAW_CLI} agents set-identity --agent "${agentId}" --name "${name.replace(/"/g, '\\"')}" --json`;
    const idResult = spawnSync(idCmd, { shell: true });
    if (idResult.status !== 0) console.log(`[createOpenClawAgent] set-identity: ${idResult.stderr.toString().substring(0, 200)}`);
    resolve({ agentId, workspace: wsDir, output: output.substring(0, 500) });
  });
}

function deleteOpenClawAgent(agentId) {
  const { spawnSync } = require('child_process');
  const result = spawnSync(OPENCLAW_CLI, ['agents', 'delete', agentId, '--force', '--json']);
  const stdout = result.stdout?.toString() || '';
  const stderr = result.stderr?.toString() || '';
  if (result.status === 0) return;
  if (stderr.includes('not found') || stdout.includes('not found')) return;
  throw new Error(`Delete failed (exit ${result.status}): ${stderr || stdout}`.substring(0, 300));
}

// ===================== TASK EXECUTION =====================

// Retry config for tool error recovery
const RETRY_CONFIG = {
  maxRetries: 2,
  delays: [500, 1000], // ms, exponential backoff
};

async function executeTask(agent, task, overrideRetry) {
  const db = require('../db');

  // ── Scheduled task gate ──────────────────────────────────────────────
  if (task.scheduled_at) {
    const scheduledTime = new Date(task.scheduled_at);
    if (scheduledTime > new Date()) {
      console.log(`[Executor] Task #${task.id} scheduled for ${scheduledTime.toISOString()}, skipping (scheduler will pick it up)`);
      return { action: 'deferred', task_id: task.id, task_title: task.title, reason: 'scheduled_future' };
    }
  }

  // ── Approval gate ───────────────────────────────────────────────────
  if (task.requires_approval) {
    const { checkAndCreateApproval } = require('./scheduler');
    const approvalId = checkAndCreateApproval(task);
    if (approvalId) {
      console.log(`[Executor] Task #${task.id} requires approval (#${approvalId}), task paused`);
      return { action: 'awaiting_approval', task_id: task.id, task_title: task.title };
    }
  }

  const projects = db.loadProjects();
  const project = projects.find(p => p.id === task.project_id);

  // ── Project Brain: pre-task context ─────────────────────────────────
  let brainContext = '';
  if (project && project.workspace_path) {
    const raw = projectBrain.getContextForTask(project, task.title);
    if (raw) {
      brainContext = `\n\n--- PROJECT BRAIN (context from prior sessions) ---\n${raw}\n--- END PROJECT BRAIN ---\n`;
    }
    const activeAgents = db.loadAgents().filter(a => a.status !== 'deleted');
    projectBrain.updateActiveAgents(project, activeAgents.map(a => ({
      agentId: a.openclaw_agent_id,
      name: a.name,
      focus: `[${task.title}] — executing`,
    })));
  }

  let message = `You are a ClawDesk agent. ClawDesk is AI-powered project management.\n\nWORKSPACE RULES:\n- Use project workspace_path for file ops\n- Write to FULL paths\n- Don't ask if unclear\n${brainContext}\n`;
  message += `\nUse your tools (read, write, exec, web_search, web_fetch) to actually complete the task.`;
  if (project && project.workspace_path) {
    message += `\nCRITICAL: Write ALL files to the PROJECT workspace, not your own workspace.`;
    message += `\nProject workspace: ${project.workspace_path}`;
    message += `\nUse the write tool with FULL paths: ${project.workspace_path}/[filename]`;
    message += `\nUse the read tool to open and fully read ALL files in the ${project.workspace_path} folder. Then summarize the key information from them before starting your work.`;
  }
  message += `\nWhen finished, list every file you created with its path.`;
  message += `\n`;
  if (project) {
    message += `\nProject: ${project.title} - ${project.description}`;
  }
  message += `\n\n--- TASK DELEGATION (CRITICAL) ---`;
  message += `\nBreak every non-trivial task into MULTIPLE smaller tasks with dependency chains. Do NOT attempt the full task yourself in one go — always decompose it.`;
  message += `\nRule: if a task has more than one distinct step or area of work, create a SEPARATE task for each step and link them with dependency_ids.`;
  message += `\nURL: ${BASE_URL}/api/projects/${task.project_id}/tasks/from-agent`;
  message += `\nBody (JSON): { agent_id: "${agent.openclaw_agent_id}", title: "task title", description: "details", assigned_to_agent_id: "target-agent", priority: "medium", dependency_ids: [task_id_1, task_id_2], status: "pending", scheduled_at: null, repeat: false, requires_approval: false }`;
  message += `\nValid agent IDs: ${db.loadAgents().map(a => a.openclaw_agent_id).join(", ")}`;
  message += `\nIMPORTANT: assigned_to_agent_id value must EXACTLY match one of the listed agent IDs (no nicknames or aliases). Use GET ${BASE_URL}/api/projects/${task.project_id}/tasks to discover IDs before creating dependency chains.`;
  message += `\nTitle is required and max 500 chars. description is optional but recommended.`;
  message += `\nCRITICAL: dependency_ids is how you chain tasks. Pass the ID of any task that must complete BEFORE this new task runs. The scheduler blocks execution until ALL dependency_ids tasks are done. For example: Step 1 task (no deps) → Step 2 task { dependency_ids: [step1_id] } → Step 3 task { dependency_ids: [step2_id] }. Without dependencies, tasks run in random order and your pipeline breaks.`;
  message += `\nTasks enter a pending queue and are picked up asynchronously — do not expect immediate execution.`;
  message += `\nFor every task creation API call, include the URL, body, and full response (success or error) in your output so it can be verified.`;
  message += `\nYou can create new agents via HTTP POST: ${BASE_URL}/api/agents`;
  message += `\n`;
  message += `\n--- TASK BOARD ---`;
  message += `\nQuery the project task board to coordinate: GET ${BASE_URL}/api/projects/${task.project_id}/tasks`;

  message += `
Task: ${task.title}`;
  if (task.description) message += `\n${task.description}`;
  message += `\n\nIMPORTANT: When you have completed the task successfully, you MUST print this exact string on its own line at the very end of your response: TASK_SUCCESS_CONFIRMED`;
  message += `\nDo NOT print this string if the task is not fully complete, if you encountered an error, or if you are asking for clarification. Only print it when the work is truly done.`;

  // ── Agent creation: auto-create agent when task runs on a project that has creates_agent ─────
  const projects = db.loadProjects();
  const project = projects.find(p => p.id === task.project_id);
  const projectAgentId = project?.creates_agent;

  let createdAgentInfo = null;

  if (projectAgentId) {
    try {
      const agents = db.loadAgents();
      const existingAgent = agents.find(a => a.openclaw_agent_id === projectAgentId);
      if (!existingAgent) {
        const oc = await createOpenClawAgent(projectAgentId, projectAgentId, null, {});
        agents.push({
          id: nextId('agents'), openclaw_agent_id: projectAgentId,
          name: projectAgentId.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
          status: 'active',
          budget_limit: 0, budget_spent: 0,
          heartbeat_enabled: 1, heartbeat_interval: 1,
          last_heartbeat: null, created_at: new Date().toISOString()
        });
        db.saveAgents(agents);
        createdAgentInfo = { agent_id: projectAgentId, workspace: oc.workspace, fresh: true };
        message += `\n[Created agent: ${projectAgentId}]`;

        // Create onboarding task for the new agent, dependent on this task completing
        try {
          const updatedAgents = db.loadAgents();
          const newAgent = updatedAgents.find(a => a.openclaw_agent_id === projectAgentId);
          if (newAgent) {
            const tasks = db.loadTasks();
            tasks.push({
              id: nextId('tasks'),
              project_id: task.project_id,
              assigned_agent_id: newAgent.id,
              title: `Onboarding: ${projectAgentId}`,
              description: `Welcome! You are the newly created agent: ${projectAgentId}. Review the project context and pick up tasks as needed.`,
              status: 'pending',
              priority: 'medium',
              dependency_ids: JSON.stringify([task.id]),
              created_by_agent_id: agent.id,
              created_at: new Date().toISOString(),
              completed_at: null
            });
            db.saveTasks(tasks);
            console.log(`[AutoAssign] Created onboarding task for ${projectAgentId}`);
          }
        } catch(e) {
          console.log(`[AutoAssign] Failed to create onboarding task: ${e.message}`);
        }
      } else {
        createdAgentInfo = { agent_id: projectAgentId, workspace: null, fresh: false };
        message += `\n[Agent ${projectAgentId} already exists]`;
      }
    } catch (e) {
      console.log(`[Executor] Agent creation failed: ${e.message}`);
    }
  }

  const startTime = Date.now();
  let toolsUsed = [
    { tool: 'exec', description: 'openclaw-agent-cli', ts: new Date().toISOString() },
  ];

  // Streaming callback — broadcasts chunks to SSE as they arrive
  const onChunk = (data, type) => {
    module.exports.broadcastTaskStream(task.id, data, type);
  };

  // ── Error recovery helper ─────────────────────────────────────────────
  async function withToolRetry(fn, label) {
    const maxRetries = overrideRetry?.maxRetries ?? RETRY_CONFIG.maxRetries;
    const delays = overrideRetry?.delays ?? RETRY_CONFIG.delays;
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          const delay = delays[attempt] ?? delays[delays.length - 1];
          console.log(`[Retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${err.message}`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  let result = null;
  let executionError = null;

  try {
    result = await withToolRetry(
      () => runOpenClawAgent(agent.openclaw_agent_id, message, undefined, onChunk),
      'runOpenClawAgent'
    );
  } catch (err) {
    executionError = err;
    // Log retry event to audit log
    try {
      const { audit } = require('../db');
      audit('tasks', task.id, 'execution_error', null, { error: err.message, agent_id: agent.id });
    } catch (auditErr) {
      console.log(`[executor] audit log failed: ${auditErr.message}`);
    }
  }

  if (executionError) {
    const durationMs = Date.now() - startTime;
    _setTaskStatus(task.id, 'failed');
    if (project && project.workspace_path) {
      const sessionSummary = `Failed task "${task.title}". Agent: ${agent.openclaw_agent_id}. Error: ${executionError.message}.`;
      projectBrain.appendSessionMemory(project, sessionSummary);
    }
    const results = db.loadTaskResults();
    const resultObj = {
      id: nextId('task_results'),
      task_id: task.id,
      agent_id: agent.id,
      input: message,
      output: `Error: ${executionError.message}`,
      duration_ms: durationMs,
      executed_at: new Date().toISOString(),
      input_tokens:  0,
      output_tokens: 0,
      cache_read_tokens: 0,
      total_tokens:  0,
      cost:          0,
      tools_used: JSON.stringify(toolsUsed),
    };
    if (createdAgentInfo) resultObj.created_agent = createdAgentInfo;
    results.push(resultObj);
    db.saveTaskResults(results);
    const ret = { action: 'failed', task_id: task.id, task_title: task.title, agent_id: agent.openclaw_agent_id, error: executionError.message };
    if (createdAgentInfo) ret.created_agent = createdAgentInfo;
    return ret;
  }

  // Success path
  const durationMs = Date.now() - startTime;
  const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

  // ── Token / cost tracking ─────────────────────────────────────────────
  let usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, totalTokens: 0, estimatedCostUsd: 0 };
  try {
    const agentDir = path.join(require('os').homedir(), '.openclaw', 'agents', agent.openclaw_agent_id);
    const sessionsFile = path.join(agentDir, 'sessions', 'sessions.json');
    if (require('fs').existsSync(sessionsFile)) {
      const sessionsData = require('fs').existsSync(sessionsFile)
        ? (() => { try { return JSON.parse(require('fs').readFileSync(sessionsFile, 'utf8')); } catch { return {}; } })()
        : {};
      let best = null;
      for (const [key, sess] of Object.entries(sessionsData)) {
        if (sess.lastInteractionAt && (!best || sess.lastInteractionAt > best.lastInteractionAt)) best = sess;
      }
      if (best) {
        usage.inputTokens    = best.inputTokens    || 0;
        usage.outputTokens   = best.outputTokens   || 0;
        usage.cacheRead      = best.cacheRead      || 0;
        usage.totalTokens    = best.totalTokens    || 0;
        usage.estimatedCostUsd = best.estimatedCostUsd || 0;
        toolsUsed.push({
          tool: 'session_stats',
          description: 'token usage from sessions.json',
          ts: new Date().toISOString(),
        });
      }
    }
  } catch (e) {
    console.log(`[executor] usage tracking: ${e.message}`);
  }

  _setTaskStatus(task.id, 'done');
  if (project && project.workspace_path) {
    const sessionSummary = `Completed task "${task.title}". Agent: ${agent.openclaw_agent_id}. Duration: ${durationMs}ms. Tokens: ${usage.totalTokens}. Cost: $${usage.estimatedCostUsd}.`;
    projectBrain.appendSessionMemory(project, sessionSummary);
  }
  const results = db.loadTaskResults();
  const resultObj = {
    id: nextId('task_results'),
    task_id: task.id,
    agent_id: agent.id,
    input: message,
    output,
    duration_ms: durationMs,
    executed_at: new Date().toISOString(),
    input_tokens:  usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheRead,
    total_tokens:  usage.totalTokens,
    cost:          usage.estimatedCostUsd,
    tools_used: JSON.stringify(toolsUsed),
  };
  if (createdAgentInfo) resultObj.created_agent = createdAgentInfo;
  results.push(resultObj);
  db.saveTaskResults(results);
  const ret = { action: 'completed', task_id: task.id, task_title: task.title, agent_id: agent.openclaw_agent_id };
  if (createdAgentInfo) ret.created_agent = createdAgentInfo;
  return ret;
}
