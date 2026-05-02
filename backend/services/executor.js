const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { nextId } = require('../db');
const OPENCLAW_CLI = (() => {
  const val = process.env.OPENCLAW_CLI;
  // If set to "1" or other obvious junk (from systemd/gateway env bleed), ignore it
  if (!val || val === '1' || !val.trim()) return 'openclaw';
  // Accept if it looks like a path or starts with "openclaw"
  if (val.includes('/') || val.startsWith('openclaw')) return val.trim();
  return 'openclaw';
})();
const OPENCLAW_NODE = process.env.OPENCLAW_NODE || '/usr/bin/node';
const OPENCLAW_MODULE = process.env.OPENCLAW_MODULE || '/home/openclaw/.npm-global/lib/node_modules/openclaw/openclaw.mjs';
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3777}`;

// Re-exported so routes can access without circular
module.exports = { runOpenClawAgent, createOpenClawAgent, deleteOpenClawAgent, executeTask };

// ===================== OPENCLAW AGENT CLI WRAPPERS =====================

function runOpenClawAgent(agentId, message, timeout = 600000, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCLAW_CLI, ['agent', '--agent', agentId, '--message', message, '--json', '--timeout', String(Math.floor((timeout || 600000) / 1000))], { cwd });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', err => reject(new Error('spawn error: ' + err.message)));
    child.on('close', code => {
      let result = null;
      if (stdout && stdout.trim()) { try { result = JSON.parse(stdout.trim()); } catch {} }
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
    const TIMEOUT_MS = 300000;

    // Use spawnSync with shell:true + inherit — only pattern that works with the CLI's
    // gateway RPC (other stdio modes cause it to exit with code 1)
    const { spawnSync } = require('child_process');
    const cmd = `${OPENCLAW_CLI} agents add "${agentId}" --non-interactive --workspace "${wsDir}" --json`;
    const result = spawnSync(cmd, { shell: true, timeout: TIMEOUT_MS });
    const output = (result.stdout || '').toString() + (result.stderr || '').toString();

    // Only create workspace files and resolve if CLI succeeded
    if (result.status !== 0 && !output.includes('already exists')) {
      reject(new Error(`Failed: exit ${result.status}\n${output.substring(0, 500)}`));
      return;
    }

    // CLI succeeded — create identity files
    fs.mkdirSync(wsDir, { recursive: true });
    const emoji = opts.emoji || '🤖';
    const vibe = opts.vibe || 'helpful and focused';
    fs.writeFileSync(path.join(wsDir, 'IDENTITY.md'), `# IDENTITY.md\n\n- **Name:** ${name}\n- **Role:** ${vibe}\n- **Creature:** AI agent\n- **Vibe:** ${vibe.split('.').filter(s=>s.trim())[0].split(',').slice(0,2).map(s=>s.trim()).join(', ') || 'focused and effective'}\n- **Emoji:** ${emoji}\n`);
    fs.writeFileSync(path.join(wsDir, 'SOUL.md'), `# SOUL.md\n\nYou are ${name}. ${vibe}. Be resourceful, direct, and actually do the work - don't just say you did.\n`);
    fs.writeFileSync(path.join(wsDir, 'USER.md'), `# USER.md\n\nS is your operator. Listen carefully. Execute precisely. No filler.\n`);

    // set-identity — same pattern
    const idCmd = `${OPENCLAW_CLI} agents set-identity --agent "${agentId}" --name "${name.replace(/"/g, '\\"')}" --json`;
    const idResult = spawnSync(idCmd, { shell: true, timeout: 15000 });
    if (idResult.status !== 0) console.log(`[createOpenClawAgent] set-identity: ${idResult.stderr.toString().substring(0, 200)}`);

    resolve({ agentId, workspace: wsDir, output: output.substring(0, 500) });
  });
}

function deleteOpenClawAgent(agentId) {
  const { spawnSync } = require('child_process');
  const cmd = `${OPENCLAW_CLI} agents delete "${agentId}" --force --json`;
  const result = spawnSync('sh', ['-c', cmd], { 
    timeout: 8000,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout = result.stdout?.toString() || '';
  const stderr = result.stderr?.toString() || '';
  const notFound = stderr.includes('not found') || stdout.includes('not found') || stdout.includes('cannot be deleted');
  if (result.status === 0 || notFound) return;
  throw new Error(`Delete failed (exit ${result.status}): ${stderr || stdout}`.substring(0, 300));
}

// ===================== TASK EXECUTION =====================

async function executeTask(agent, task) {
  const db = require('../db');
  const projects = db.loadProjects();
  const project = projects.find(p => p.id === task.project_id);

  let message = `You are a ClawDesk agent. ClawDesk is AI-powered project management.\n\nWORKSPACE RULES:\n- Use project workspace_path for file ops\n- Write to FULL paths\n- Don't ask if unclear\n\n`;
  message += `\nUse your tools (read, write, exec, web_search, web_fetch) to actually complete the task.`;
  if (project && project.workspace_path) {
    message += `\nCRITICAL: Write ALL files to the PROJECT workspace, not your own workspace.`;
    message += `\nProject workspace: ${project.workspace_path}`;
    message += `\nUse the write tool with FULL paths: ${project.workspace_path}/[filename]`;
    message += `\nUse the read tool to open and fully read ALL files in the ${project.workspace_path} folder. Then summarize the key information from them before starting your work.".`;
  }
  message += `\nWhen finished, list every file you created with its path.`;
  message += `\n`;
  if (project) {
    message += `\nProject: ${project.title} - ${project.description}`;
  }
  message += `\nTask: ${task.title}`;
  if (task.description) message += `\n${task.description}`;

  message += `\n\n--- TOOLS ---`;
  message += `\nYou can create new agents for this project via HTTP POST:`;
  message += `\nURL: ${BASE_URL}/api/agents`;
  message += `\nBody (JSON): { job_title: "Senior Security Engineer", job_description: "Penetration testing, audits..." }`;
  message += `\nThis creates the agent, its workspace, identity files, and registers it with OpenClaw.`;
  message += `\nAfter creating an agent, you can assign tasks to it using the task creation endpoint above.`;

  let createdAgentInfo = null;

  if (task.creates_agent) {
    try {
      const oc = await createOpenClawAgent(task.creates_agent, task.creates_agent, null, {});
      const agents = db.loadAgents();
      if (!agents.find(a => a.openclaw_agent_id === task.creates_agent)) {
        agents.push({
          id: nextId('agents'), openclaw_agent_id: task.creates_agent,
          name: task.creates_agent.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
          status: 'active',
          budget_limit: 0, budget_spent: 0,
          heartbeat_enabled: 1, heartbeat_interval: 1,
          last_heartbeat: null, created_at: new Date().toISOString()
        });
        db.saveAgents(agents);
      }
      createdAgentInfo = { agent_id: task.creates_agent, workspace: oc.workspace };
      message += `\n[Created agent: ${task.creates_agent}]`;

      try {
        const agents = db.loadAgents();
        const newAgent = agents.find(a => a.openclaw_agent_id === task.creates_agent);
        if (newAgent) {
          const tasks = db.loadTasks();
          tasks.push({
            id: nextId('tasks'),
            project_id: task.project_id,
            assigned_agent_id: newAgent.id,
            title: `Onboarding: ${task.creates_agent}`,
            description: `Welcome! You are the newly created agent: ${task.creates_agent}. Review the project context and pick up tasks as needed.`,
            status: 'pending',
            priority: 'medium',
            dependency_id: task.id,
            creates_agent: null,
            created_by_agent_id: agent.id,
            created_at: new Date().toISOString(),
            completed_at: null
          });
          db.saveTasks(tasks);
          console.log(`[AutoAssign] Created onboarding task for ${task.creates_agent}`);
        }
      } catch(e) {
        console.log(`[AutoAssign] Failed to create onboarding task: ${e.message}`);
      }
    } catch (e) {
      createdAgentInfo = { agent_id: task.creates_agent, error: e.message };
    }
  }

  const startTime = Date.now();
  try {
    const result = await runOpenClawAgent(agent.openclaw_agent_id, message, 600000, undefined);
    const durationMs = Date.now() - startTime;
    const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

    const { setTaskStatus } = require('./heartbeat');
    setTaskStatus(task.id, 'done');
    const results = db.loadTaskResults();
    const resultObj = { id: nextId('task_results'), task_id: task.id, agent_id: agent.id, input: message, output, duration_ms: durationMs, executed_at: new Date().toISOString() };
    if (createdAgentInfo) resultObj.created_agent = createdAgentInfo;
    results.push(resultObj);
    db.saveTaskResults(results);
    const ret = { action: 'completed', task_id: task.id, task_title: task.title, agent_id: agent.openclaw_agent_id };
    if (createdAgentInfo) ret.created_agent = createdAgentInfo;
    return ret;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const { setTaskStatus } = require('./heartbeat');
    setTaskStatus(task.id, 'failed');
    const results = db.loadTaskResults();
    const resultObj = { id: nextId('task_results'), task_id: task.id, agent_id: agent.id, input: message, output: `Error: ${err.message}`, duration_ms: durationMs, executed_at: new Date().toISOString() };
    if (createdAgentInfo) resultObj.created_agent = createdAgentInfo;
    results.push(resultObj);
    db.saveTaskResults(results);
    const ret = { action: 'failed', task_id: task.id, task_title: task.title, agent_id: agent.openclaw_agent_id, error: err.message };
    if (createdAgentInfo) ret.created_agent = createdAgentInfo;
    return ret;
  }
}
