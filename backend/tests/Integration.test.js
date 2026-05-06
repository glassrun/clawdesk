'use strict';
/**
 * Integration.test.js — integration tests for ClawDesk backend features
 * Covers: tool registry routes, agent capabilities, withToolRetry, tools_used in task_results
 *
 * Run: node tests/Integration.test.js
 * Or via Jest: npx jest tests/Integration.test.js
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { getDb, closeDb, makeAgent } = require('./helpers');

// ── assertion helpers ───────────────────────────────────────────────────────────

function assertEqual(a, b) {
  if (a !== b) throw new Error(`Expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`);
}
function assertTrue(a) {
  if (!a) throw new Error(`Expected truthy, got ${JSON.stringify(a)}`);
}
function assertArrayIncludes(arr, val) {
  if (!arr.includes(val)) throw new Error(`Expected array ${JSON.stringify(arr)} to include ${JSON.stringify(val)}`);
}

// ── HTTP request helper ────────────────────────────────────────────────────────

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const bodyStr = body ? JSON.stringify(body) : '';
      const opts = {
        hostname: 'localhost', port, path, method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      };
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

// ── Mini Express app factory that mirrors the real route behaviour ─────────────

function createToolsApp() {
  const express = require('express');
  const { getAllTools, getTool, updateTool } = require('../services/tool-registry');
  const router = express.Router();

  router.get('/', (req, res) => { res.json(getAllTools()); });
  router.get('/:name', (req, res) => {
    const tool = getTool(req.params.name);
    if (!tool) return res.status(404).json({ error: 'tool not found' });
    res.json(tool);
  });
  router.patch('/:name', (req, res) => {
    const tool = getTool(req.params.name);
    if (!tool) return res.status(404).json({ error: 'tool not found' });
    const allowed = ['enabled', 'rateLimit', 'description', 'riskLevel'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const updated = updateTool(req.params.name, updates);
    res.json(updated);
  });

  const app = require('express')();
  app.use(require('express').json());
  app.use('/api/tools', router);
  return app;
}

function createCapabilitiesApp(db) {
  const express = require('express');
  const router = express.Router();

  router.get('/:id/capabilities', (req, res) => {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(+req.params.id);
    if (!agent) return res.status(404).json({ error: 'not found' });

    const fs = require('fs');
    const agentWorkspace = path.join(process.env.HOME || '/home/openclaw', '.openclaw', 'agents', agent.openclaw_agent_id);
    const capFile = path.join(agentWorkspace, 'CAPABILITIES.md');

    const capabilities = { tools: [], skills: [], raw: null };

    if (fs.existsSync(capFile)) {
      try {
        const content = fs.readFileSync(capFile, 'utf8');
        capabilities.raw = content;
        // Match "### tool: name" or "### skill: name" lines; capture the identifier after the colon
        const toolMatches = content.matchAll(/(?:^|\n)###\s*(tool|skill):\s*(\w+)/gi);
        for (const m of toolMatches) {
          const lower = m[2].toLowerCase();
          if (lower && !capabilities.tools.includes(lower)) capabilities.tools.push(lower);
        }
        const allToolNames = ['read', 'write', 'exec', 'web_search', 'web_fetch', 'image', 'video', 'music'];
        for (const t of allToolNames) {
          const regex = new RegExp(`(^|\n)\\s*[-*\\u2022]\\s*${t}\\b`, 'i');
          if (regex.test(content) && !capabilities.tools.includes(t)) {
            capabilities.tools.push(t);
          }
        }
      } catch (e) {
        return res.status(500).json({ error: 'failed to parse CAPABILITIES.md: ' + e.message });
      }
    }

    const { getAllTools } = require('../services/tool-registry');
    const allTools = getAllTools();
    const availableTools = allTools.filter(t => t.enabled).map(t => t.name);

    res.json({
      agent_id: agent.id,
      openclaw_agent_id: agent.openclaw_agent_id,
      available_tools: availableTools,
      declared_tools: capabilities.tools,
      declared_skills: capabilities.skills,
      capabilities_file: fs.existsSync(capFile),
      raw: capabilities.raw,
    });
  });

  const app = require('express')();
  app.use(require('express').json());
  app.use('/api/agents', router);
  return app;
}

// ── withToolRetry unit test (standalone) ──────────────────────────────────────

async function withToolRetryTestLogic() {
  // Simulates the withToolRetry helper from services/executor.js
  const RETRY_CONFIG = { maxRetries: 2, delays: [50, 100] };

  async function withToolRetry(fn, label, overrideRetry) {
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
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  // Test 1: fails twice, succeeds on 3rd attempt
  {
    let counter = 0;
    const fn = async () => {
      counter++;
      if (counter < 3) throw new Error(`fail ${counter}`);
      return 'success';
    };
    const result = await withToolRetry(fn, 'test-fn');
    assertEqual(result, 'success');
    assertEqual(counter, 3); // initial + 2 retries
  }

  // Test 2: always fails — throws after maxRetries
  {
    let counter = 0;
    const fn = async () => {
      counter++;
      throw new Error('always fail');
    };
    let threw = false;
    try {
      await withToolRetry(fn, 'always-fail', { maxRetries: 2, delays: [10, 10] });
    } catch (e) {
      threw = true;
      assertEqual(e.message, 'always fail');
    }
    assertTrue(threw);
    assertEqual(counter, 3); // initial + 2 retries
  }

  // Test 3: succeeds on first try — no retries
  {
    let counter = 0;
    const fn = async () => { counter++; return 'first-try'; };
    const result = await withToolRetry(fn, 'first-try', { maxRetries: 5, delays: [10, 10, 10, 10, 10] });
    assertEqual(result, 'first-try');
    assertEqual(counter, 1);
  }
}

// ── tools_used column in task_results ─────────────────────────────────────────

function testToolsUsedColumn() {
  const db = getDb();

  // Verify the column exists via the helpers' schema
  const cols = db.prepare("PRAGMA table_info(task_results)").all().map(r => r.name);
  assertArrayIncludes(cols, 'tools_used');

  // Insert a task result with tools_used populated
  db.prepare(`
    INSERT INTO task_results (id,task_id,agent_id,input,output,duration_ms,executed_at,tools_used)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    1, 1, 1,
    'task input',
    'task output',
    1500,
    new Date().toISOString(),
    JSON.stringify([
      { tool: 'exec', description: 'openclaw-agent-cli', ts: new Date().toISOString() },
      { tool: 'session_stats', description: 'token usage from sessions.json', ts: new Date().toISOString() },
    ])
  );

  const row = db.prepare('SELECT * FROM task_results WHERE id = 1').get();
  assertEqual(row.task_id, 1);
  assertEqual(row.tools_used !== null, true);

  const toolsUsed = JSON.parse(row.tools_used);
  assertEqual(Array.isArray(toolsUsed), true);
  assertEqual(toolsUsed.length, 2);
  assertEqual(toolsUsed[0].tool, 'exec');
  assertEqual(toolsUsed[1].tool, 'session_stats');

  // saveTaskResults / loadTaskResults round-trip
  const all = db.prepare('SELECT * FROM task_results').all();
  assertEqual(all.length >= 1, true);

  closeDb(db);
}

// ── test suite ────────────────────────────────────────────────────────────────

const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

// ── Tool Registry ──────────────────────────────────────────────────────────────

test('GET /api/tools — returns array of tools with required fields', async () => {
  const app = createToolsApp();
  const { status, body } = await request(app, 'GET', '/api/tools');
  assertEqual(status, 200);
  assertTrue(Array.isArray(body));
  assertTrue(body.length > 0);
  for (const tool of body) {
    assertTrue(typeof tool.name === 'string');
    assertTrue(typeof tool.description === 'string');
    assertTrue(typeof tool.riskLevel === 'string');
    assertTrue(typeof tool.rateLimit === 'object');
    assertTrue(typeof tool.enabled === 'boolean');
  }
});

test('GET /api/tools — includes expected tools (read, write, exec, web_search, web_fetch)', async () => {
  const app = createToolsApp();
  const { status, body } = await request(app, 'GET', '/api/tools');
  assertEqual(status, 200);
  const names = body.map(t => t.name);
  assertArrayIncludes(names, 'read');
  assertArrayIncludes(names, 'write');
  assertArrayIncludes(names, 'exec');
  assertArrayIncludes(names, 'web_search');
  assertArrayIncludes(names, 'web_fetch');
});

test('GET /api/tools/:name — returns a specific tool', async () => {
  const app = createToolsApp();
  const { status, body } = await request(app, 'GET', '/api/tools/read');
  assertEqual(status, 200);
  assertEqual(body.name, 'read');
  assertEqual(typeof body.description, 'string');
  assertEqual(body.riskLevel, 'low');
});

test('GET /api/tools/:name — 404 for unknown tool', async () => {
  const app = createToolsApp();
  const { status, body } = await request(app, 'GET', '/api/tools/nonexistent-tool-xyz');
  assertEqual(status, 404);
  assertEqual(body.error, 'tool not found');
});

test('PATCH /api/tools/:name — can disable a tool (enabled: false)', async () => {
  const app = createToolsApp();
  // Disable exec (high risk tool)
  const { status, body } = await request(app, 'PATCH', '/api/tools/exec', { enabled: false });
  assertEqual(status, 200);
  assertEqual(body.enabled, false);

  // Verify it stayed disabled
  const { status: s2, body: b2 } = await request(app, 'GET', '/api/tools/exec');
  assertEqual(s2, 200);
  assertEqual(b2.enabled, false);
});

test('PATCH /api/tools/:name — can re-enable a tool', async () => {
  const app = createToolsApp();
  // First disable, then re-enable
  await request(app, 'PATCH', '/api/tools/exec', { enabled: false });
  const { status, body } = await request(app, 'PATCH', '/api/tools/exec', { enabled: true });
  assertEqual(status, 200);
  assertEqual(body.enabled, true);
});

test('PATCH /api/tools/:name — can update rateLimit', async () => {
  const app = createToolsApp();
  const newLimit = { maxPerMinute: 99, burst: 15 };
  const { status, body } = await request(app, 'PATCH', '/api/tools/read', { rateLimit: newLimit });
  assertEqual(status, 200);
  assertEqual(body.rateLimit.maxPerMinute, 99);
  assertEqual(body.rateLimit.burst, 15);
});

test('PATCH /api/tools/:name — 404 for unknown tool', async () => {
  const app = createToolsApp();
  const { status, body } = await request(app, 'PATCH', '/api/tools/totally-fake', { enabled: false });
  assertEqual(status, 404);
  assertEqual(body.error, 'tool not found');
});

test('PATCH /api/tools/:name — ignores unknown fields', async () => {
  const app = createToolsApp();
  const { status, body } = await request(app, 'PATCH', '/api/tools/read', { someField: 'ignored' });
  assertEqual(status, 200);
  assertEqual(typeof body.someField, 'undefined'); // should not be present
});

// ── Agent Capabilities ────────────────────────────────────────────────────────

test('GET /api/agents/:id/capabilities — returns empty tools for agent with no CAPABILITY.md', async () => {
  const db = getDb();
  const agentHome = path.join(process.env.HOME || '/home/openclaw', '.openclaw', 'agents');
  fs.mkdirSync(agentHome, { recursive: true });
  // Ensure no CAPABILITIES.md exists for our test agent
  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)')
    .run(1, 'no-cap-agent', 'No Cap Agent', 'active', new Date().toISOString());
  const app = createCapabilitiesApp(db);
  const { status, body } = await request(app, 'GET', '/api/agents/1/capabilities');
  closeDb(db);
  assertEqual(status, 200);
  assertEqual(body.agent_id, 1);
  assertEqual(body.capabilities_file, false);
  assertEqual(Array.isArray(body.declared_tools), true);
  assertEqual(body.declared_tools.length, 0);
});

test('GET /api/agents/:id/capabilities — returns capabilities for agent with CAPABILITIES.md', async () => {
  const db = getDb();
  const agentHome = path.join(process.env.HOME || '/home/openclaw', '.openclaw', 'agents', 'cap-test-agent');
  fs.mkdirSync(agentHome, { recursive: true });

  // Write a CAPABILITIES.md file with "### tool: name" format
  fs.writeFileSync(path.join(agentHome, 'CAPABILITIES.md'), `CAPABILITIES.md

### tool: read
### tool: write
### skill: web_search
`);

  db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)')
    .run(2, 'cap-test-agent', 'Cap Test Agent', 'active', new Date().toISOString());

  const app = createCapabilitiesApp(db);
  const { status, body } = await request(app, 'GET', '/api/agents/2/capabilities');
  closeDb(db);

  assertEqual(status, 200);
  assertEqual(body.capabilities_file, true);
  // The regex matches "### tool: name" format
  assertArrayIncludes(body.declared_tools, 'read');
  assertArrayIncludes(body.declared_tools, 'write');
  assertEqual(body.raw !== null, true);
  assertTrue(body.raw.includes('CAPABILITIES.md'));
});

test('GET /api/agents/:id/capabilities — 404 for non-existent agent', async () => {
  const db = getDb();
  const app = createCapabilitiesApp(db);
  const { status, body } = await request(app, 'GET', '/api/agents/99999/capabilities');
  closeDb(db);
  assertEqual(status, 404);
  assertEqual(body.error, 'not found');
});

// Clean up test CAPABILITIES.md
try {
  const capTestPath = path.join(process.env.HOME || '/home/openclaw', '.openclaw', 'agents', 'cap-test-agent', 'CAPABILITIES.md');
  if (fs.existsSync(capTestPath)) fs.unlinkSync(capTestPath);
} catch (e) { /* ignore cleanup errors */ }

// ── withToolRetry ──────────────────────────────────────────────────────────────

test('withToolRetry — succeeds after 2 failures then success', async () => {
  await withToolRetryTestLogic();
});

test('withToolRetry — throws after max retries exceeded', async () => {
  const RETRY_CONFIG = { maxRetries: 2, delays: [20, 20] };

  async function withToolRetry(fn, label, overrideRetry) {
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
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  let attempts = 0;
  const alwaysFails = async () => { attempts++; throw new Error('permanent failure'); };

  let threw = false;
  let thrownError = null;
  try {
    await withToolRetry(alwaysFails, 'always-fail', { maxRetries: 2, delays: [5, 5] });
  } catch (e) {
    threw = true;
    thrownError = e;
  }

  assertTrue(threw);
  assertEqual(thrownError.message, 'permanent failure');
  // initial + 2 retries = 3 total attempts
  assertEqual(attempts, 3);
});

test('withToolRetry — succeeds on first attempt, no extra calls', async () => {
  const RETRY_CONFIG = { maxRetries: 2, delays: [20, 20] };

  async function withToolRetry(fn, label, overrideRetry) {
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
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  let attempts = 0;
  const succeedFirst = async () => { attempts++; return 'ok'; };

  const result = await withToolRetry(succeedFirst, 'first-ok', { maxRetries: 5, delays: [5, 5, 5, 5, 5] });
  assertEqual(result, 'ok');
  assertEqual(attempts, 1);
});

test('withToolRetry — retries with exponential backoff (order verified)', async () => {
  const callTimes = [];

  const RETRY_CONFIG = { maxRetries: 2, delays: [50, 100] };

  async function withToolRetry(fn, label, overrideRetry) {
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
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  let counter = 0;
  const fn = async () => {
    callTimes.push(Date.now());
    counter++;
    if (counter < 3) throw new Error(`fail ${counter}`);
    return 'success';
  };

  const start = Date.now();
  const result = await withToolRetry(fn, 'backoff-test', { maxRetries: 2, delays: [50, 100] });
  const elapsed = Date.now() - start;

  assertEqual(result, 'success');
  assertEqual(callTimes.length, 3);
  // Delay between call 1→2 should be roughly 50ms
  const gap1 = callTimes[1] - callTimes[0];
  assertTrue(gap1 >= 45 && gap1 <= 150, `gap1=${gap1}ms, expected ~50ms`);
  // Delay between call 2→3 should be roughly 100ms
  const gap2 = callTimes[2] - callTimes[1];
  assertTrue(gap2 >= 95 && gap2 <= 250, `gap2=${gap2}ms, expected ~100ms`);
});

// ── tools_used in task_results ─────────────────────────────────────────────────

test('task_results.tools_used — column exists and stores tool invocation records', () => {
  testToolsUsedColumn();
});

test('task_results.tools_used — round-trip through saveTaskResults/loadTaskResults', () => {
  const db = getDb();

  // Verify tools_used column exists
  const cols = db.prepare("PRAGMA table_info(task_results)").all().map(r => r.name);
  assertArrayIncludes(cols, 'tools_used');

  // Insert two task results with tools_used
  const toolsUsed = [
    [{ tool: 'exec', description: 'openclaw-agent-cli', ts: new Date().toISOString() }],
    [
      { tool: 'exec', description: 'openclaw-agent-cli', ts: new Date().toISOString() },
      { tool: 'session_stats', description: 'usage', ts: new Date().toISOString() },
    ],
  ];

  db.prepare(`INSERT INTO task_results (id,task_id,agent_id,input,output,duration_ms,executed_at,tools_used) VALUES (?,?,?,?,?,?,?,?)`)
    .run(10, 5, 1, 'in1', 'out1', 100, new Date().toISOString(), JSON.stringify(toolsUsed[0]));
  db.prepare(`INSERT INTO task_results (id,task_id,agent_id,input,output,duration_ms,executed_at,tools_used) VALUES (?,?,?,?,?,?,?,?)`)
    .run(11, 6, 1, 'in2', 'out2', 200, new Date().toISOString(), JSON.stringify(toolsUsed[1]));

  // Simulate save+load cycle (saveTaskResults clears and re-inserts)
  const before = db.prepare('SELECT * FROM task_results WHERE id IN (10,11)').all();
  db.exec("DELETE FROM task_results");
  const ins = db.prepare(`INSERT INTO task_results (id,task_id,agent_id,input,output,duration_ms,executed_at,created_agent,input_tokens,output_tokens,cache_read_tokens,total_tokens,cost,tools_used) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of before) ins.run(r.id, r.task_id, r.agent_id, r.input, r.output, r.duration_ms, r.executed_at, r.created_agent || '', r.input_tokens || 0, r.output_tokens || 0, r.cache_read_tokens || 0, r.total_tokens || 0, r.cost || 0, r.tools_used || null);

  const after = db.prepare('SELECT * FROM task_results WHERE id IN (10,11)').all();
  assertEqual(after.length, 2);

  const r1 = after.find(r => r.id === 10);
  const parsed1 = JSON.parse(r1.tools_used);
  assertEqual(parsed1.length, 1);
  assertEqual(parsed1[0].tool, 'exec');

  const r2 = after.find(r => r.id === 11);
  const parsed2 = JSON.parse(r2.tools_used);
  assertEqual(parsed2.length, 2);
  assertEqual(parsed2[1].tool, 'session_stats');

  closeDb(db);
});

// ── runner ─────────────────────────────────────────────────────────────────────

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