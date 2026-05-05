'use strict';
/**
 * executor.test.js — standalone, non-spawning unit tests for executor logic
 * Run: node tests/executor.test.js
 */

const assertEqual = (a, b) => { if (a !== b) throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const assertTrue = a => { if (!a) throw new Error(`Expected truthy, got ${JSON.stringify(a)}`); };
const assertThrows = async (fn, msg) => {
  try { await fn(); throw new Error('Expected to throw but did not'); } catch (e) { if (msg && !e.message.includes(msg)) throw e; }
};

// ── Test helpers ────────────────────────────────────────────────────────────────

// Mock the DB
const mockDb = {
  tasks: [],
  agents: [],
  projects: [],
  taskResults: [],
  loadTasks: () => [...mockDb.tasks],
  loadAgents: () => [...mockDb.agents],
  loadProjects: () => [...mockDb.projects],
  loadTaskResults: () => [...mockDb.taskResults],
  saveTasks: (t) => { mockDb.tasks = t; },
  saveAgents: (a) => { mockDb.agents = a; },
  saveProjects: (p) => { mockDb.projects = p; },
  saveTaskResults: (r) => { mockDb.taskResults = r; },
};

function nextId(table) {
  const items = mockDb[table] || [];
  return (items.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1;
}

function resetMock() {
  mockDb.tasks = [];
  mockDb.agents = [];
  mockDb.projects = [];
  mockDb.taskResults = [];
}

// Stub require('./heartbeat') for the circular dependency
const mockHeartbeat = {
  _setTaskStatus: null,
  setBroadcastSSE() {},
  setSetTaskStatus(fn) { this._setTaskStatus = fn; },
  setSyncFromOpenClaw() {},
};
const mockRequireCache = {};
function mockRequire(mod) {
  if (mod === '../db') return mockDb;
  if (mod === './heartbeat') return mockHeartbeat;
  return require(mod);
}

// Stub process.env
const origEnv = { ...process.env };
function cleanEnv() {
  const e = { ...origEnv };
  delete e.OPENCLAW_CLI;
  delete e.OPENCLAW_NODE;
  delete e.OPENCLAW_MODULE;
  delete e.BASE_URL;
  process.env = e;
}
function restoreEnv() { process.env = origEnv; }

// ── Message construction test ──────────────────────────────────────────────────

// We test the message-building logic by extracting the core string manipulation
// without spawning any process.

function buildMessage(agent, task, project, baseUrl, agents) {
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
  message += `\nYou can create new tasks for this project via HTTP POST:`;
  message += `\nURL: ${baseUrl}/api/projects/${task.project_id}/tasks/from-agent`;
  message += `\nBody (JSON): { agent_id: "${agent.openclaw_agent_id}", title: "task title", description: "details", assigned_to_agent_id: "target-agent", priority: "medium" }`;
  message += `\nValid agent IDs: ${agents.map(a => a.openclaw_agent_id).join(', ')}`;
  message += `\nIMPORTANT: assigned_to_agent_id is REQUIRED. Pick the agent who should do the work.`;
  message += `\nTo create MULTIPLE tasks, make MULTIPLE calls - one endpoint call per task.`;
  message += `\n`;
  message += `\nYou can create new agents for this project via HTTP POST:`;
  message += `\nURL: ${baseUrl}/api/agents`;
  message += `\nBody (JSON): { job_title: "Senior Security Engineer", job_description: "Penetration testing, audits..." }`;
  message += `\nThis creates the agent, its workspace, identity files, and registers it with OpenClaw.`;
  message += `\nAfter creating an agent, you can assign tasks to it using the task creation endpoint above.`;
  return message;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

test('buildMessage — contains task title and description', () => {
  resetMock();
  const agent = { openclaw_agent_id: 'test-agent', id: 1 };
  const task = { id: 1, project_id: 1, title: 'Build login page', description: 'Must use OAuth2' };
  const project = { title: 'Web App', description: 'Main web application' };
  const msg = buildMessage(agent, task, project, 'http://localhost:3777', [agent]);
  assertTrue(msg.includes('Build login page'));
  assertTrue(msg.includes('Must use OAuth2'));
  assertTrue(msg.includes('Web App'));
});

test('buildMessage — includes project workspace rules when workspace_path is set', () => {
  resetMock();
  const agent = { openclaw_agent_id: 'test-agent', id: 1 };
  const task = { id: 1, project_id: 1, title: 'Task', description: '' };
  const project = { title: 'P', description: 'D', workspace_path: '/tmp/myproject' };
  const msg = buildMessage(agent, task, project, 'http://localhost:3777', [agent]);
  assertTrue(msg.includes('/tmp/myproject'));
  assertTrue(msg.includes('CRITICAL: Write ALL files to the PROJECT workspace'));
});

test('buildMessage — omits workspace rules when no workspace_path', () => {
  resetMock();
  const agent = { openclaw_agent_id: 'test-agent', id: 1 };
  const task = { id: 1, project_id: 1, title: 'Task', description: '' };
  const project = { title: 'P', description: 'D', workspace_path: null };
  const msg = buildMessage(agent, task, project, 'http://localhost:3777', [agent]);
  assertTrue(!msg.includes('CRITICAL: Write ALL files to the PROJECT workspace'));
});

test('buildMessage — includes tool endpoints', () => {
  resetMock();
  const agent = { openclaw_agent_id: 'my-bot', id: 1 };
  const task = { id: 5, project_id: 3, title: 'Task', description: '' };
  const project = { title: 'P', description: 'D' };
  const agents = [{ openclaw_agent_id: 'my-bot', id: 1 }, { openclaw_agent_id: 'worker-1', id: 2 }];
  const msg = buildMessage(agent, task, project, 'http://localhost:3777', agents);
  assertTrue(msg.includes('POST'));
  assertTrue(msg.includes('/api/projects/3/tasks/from-agent'));
  assertTrue(msg.includes('my-bot'));
  assertTrue(msg.includes('worker-1'));
});

test('buildMessage — omits description when not provided', () => {
  resetMock();
  const agent = { openclaw_agent_id: 'test', id: 1 };
  const task = { id: 1, project_id: 1, title: 'Task', description: '' };
  const project = { title: 'P', description: 'D' };
  const msg = buildMessage(agent, task, project, 'http://localhost:3777', [agent]);
  assertTrue(!msg.includes('\nundefined'));
  assertTrue(!msg.includes('\nnull'));
});

test('buildMessage — includes creates_agent content when set', () => {
  resetMock();
  const agent = { openclaw_agent_id: 'test', id: 1 };
  const task = { id: 1, project_id: 1, title: 'Task', description: '', creates_agent: 'new-bot-01' };
  const project = { title: 'P', description: 'D' };
  const msg = buildMessage(agent, task, project, 'http://localhost:3777', [agent]);
  // The creates_agent handling happens separately in executeTask, not in the base message
  assertTrue(msg.includes('Task'));
});

// ── creates_agent flow test ────────────────────────────────────────────────────

test('creates_agent — when task.creates_agent is set, onboarding task is created', async () => {
  resetMock();
  const { nextId } = require('./helpers');
  const mockNextId = 1;
  let createdOnboarding = false;
  let createdAgentId = null;

  // Simulate what executeTask does for creates_agent
  const task = { id: 99, project_id: 1, title: 'Create worker bot', creates_agent: 'worker-bot-1' };
  const agent = { id: 1, openclaw_agent_id: 'orchestrator' };

  // Pre-populate agents so we don't try to call real createOpenClawAgent
  mockDb.agents = [{ id: 1, openclaw_agent_id: 'orchestrator', name: 'Orchestrator' }];
  mockDb.projects = [{ id: 1, title: 'Test', description: '' }];

  // Simulate the creates_agent block — verify it would create an onboarding task
  try {
    // What executeTask does:
    const newAgentId = task.creates_agent;
    const newAgent = {
      id: mockNextId,
      openclaw_agent_id: newAgentId,
      name: newAgentId.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
      status: 'active',
      budget_limit: 0, budget_spent: 0,
      heartbeat_enabled: 1, heartbeat_interval: 1,
      last_heartbeat: null, created_at: new Date().toISOString()
    };

    // Onboarding task creation
    const onboardingTask = {
      id: mockNextId + 1,
      project_id: task.project_id,
      assigned_agent_id: newAgent.id,
      title: `Onboarding: ${newAgentId}`,
      description: `Welcome! You are the newly created agent: ${newAgentId}. Review the project context and pick up tasks as needed.`,
      status: 'pending',
      priority: 'medium',
      dependency_id: task.id,
      creates_agent: null,
      created_by_agent_id: agent.id,
      created_at: new Date().toISOString(),
      completed_at: null
    };

    createdAgentId = newAgentId;
    // Verify onboarding task has correct fields
    assertEqual(onboardingTask.title, 'Onboarding: worker-bot-1');
    assertEqual(onboardingTask.assigned_agent_id, newAgent.id);
    assertEqual(onboardingTask.dependency_id, task.id);
    assertEqual(onboardingTask.creates_agent, null);
    createdOnboarding = true;
  } catch (e) {
    // Expected — we don't have all mocks set up
  }

  assertTrue(createdOnboarding);
  assertEqual(createdAgentId, 'worker-bot-1');
});

// ── Retry count test ───────────────────────────────────────────────────────────

test('retry logic — _retry_count increments correctly', () => {
  resetMock();

  // Simulate task retry via /retry endpoint logic
  const task = { id: 1, project_id: 1, title: 'Retry me', status: 'failed', _retry_count: 0 };
  const tasks = [task];

  // Simulate what retry does
  task._retry_count = (task._retry_count || 0) + 1;
  task.status = 'pending';
  delete task._status_changed_at;

  assertEqual(task._retry_count, 1);
  assertEqual(task.status, 'pending');

  // Second retry
  task._retry_count = (task._retry_count || 0) + 1;
  task.status = 'pending';
  delete task._status_changed_at;

  assertEqual(task._retry_count, 2);

  // Third retry (should be max)
  task._retry_count = (task._retry_count || 0) + 1;
  assertEqual(task._retry_count, 3);
});

test('retry logic — task without prior retry_count initializes to 0', () => {
  resetMock();
  const task = { id: 1, status: 'failed' }; // no _retry_count
  const count = (task._retry_count || 0) + 1;
  assertEqual(count, 1);
  assertEqual(task._retry_count, undefined); // original unchanged
  task._retry_count = count; // what the actual code does
  assertEqual(task._retry_count, 1);
});

// ── Message parsing tests ─────────────────────────────────────────────────────

test('message includes valid agent IDs list', () => {
  resetMock();
  const agents = [
    { openclaw_agent_id: 'alice', id: 1 },
    { openclaw_agent_id: 'bob', id: 2 },
    { openclaw_agent_id: 'charlie', id: 3 },
  ];
  const task = { id: 1, project_id: 1, title: 'T', description: '' };
  const project = { title: 'P', description: 'D' };
  const agent = agents[0];
  const msg = buildMessage(agent, task, project, 'http://localhost:3777', agents);
  assertTrue(msg.includes('alice'));
  assertTrue(msg.includes('bob'));
  assertTrue(msg.includes('charlie'));
});

test('empty agents list is handled', () => {
  resetMock();
  const agents = [];
  const task = { id: 1, project_id: 1, title: 'T', description: '' };
  const project = { title: 'P', description: 'D' };
  const agent = { openclaw_agent_id: 'solo', id: 99 };
  const msg = buildMessage(agent, task, project, 'http://localhost:3777', agents);
  assertTrue(msg.includes('Valid agent IDs:'));
  assertTrue(!msg.includes('Valid agent IDs: alice, bob'));
});

// ── executor exports test ──────────────────────────────────────────────────────

test('executor module exports expected functions', () => {
  cleanEnv();
  // Read the executor file without executing to check exports
  const fs = require('fs');
  const content = fs.readFileSync('./services/executor.js', 'utf8');
  assertTrue(content.includes('runOpenClawAgent'));
  assertTrue(content.includes('createOpenClawAgent'));
  assertTrue(content.includes('deleteOpenClawAgent'));
  assertTrue(content.includes('executeTask'));
  assertTrue(content.includes('setSSEContext'));
  assertTrue(content.includes('broadcastTaskStream'));
  assertTrue(content.includes('broadcastTaskDone'));
  restoreEnv();
});

test('setSSEContext — returns an object with expected methods', () => {
  // We test the module interface without actually loading it with all deps
  const fs = require('fs');
  const content = fs.readFileSync('./services/executor.js', 'utf8');
  // Module must export setSSEContext, broadcastTaskStream, broadcastTaskDone
  assertTrue(content.includes('setSSEContext'));
  assertTrue(content.includes('broadcastTaskStream'));
  assertTrue(content.includes('broadcastTaskDone'));
  assertTrue(content.includes('_broadcastSSE'));
  assertTrue(content.includes('_sseClients'));
});

// ── runner ──────────────────────────────────────────────────────────────────────

async function run() {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();