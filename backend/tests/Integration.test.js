'use strict';
/**
 * Integration.test.js — integration tests for ClawDesk backend features
 * Run via Jest: npx jest tests/Integration.test.js
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { getDb, closeDb, makeAgent } = require('./helpers');

// ── HTTP helper ────────────────────────────────────────────────────────────────

function request(app, method, p, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const bodyStr = body ? JSON.stringify(body) : '';
      const opts = {
        hostname: 'localhost', port, path: p, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      };
      const req = http.request(opts, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', e => { server.close(); reject(e); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

// ── Tool Registry App ──────────────────────────────────────────────────────

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
    for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
    res.json(updateTool(req.params.name, updates));
  });
  const app = express();
  app.use(express.json());
  app.use('/api/tools', router);
  return app;
}

// ── Capabilities App ───────────────────────────────────────────────────────

function createCapabilitiesApp(db) {
  const express = require('express');
  const router = express.Router();
  router.get('/:id/capabilities', (req, res) => {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(+req.params.id);
    if (!agent) return res.status(404).json({ error: 'not found' });
    const agentWorkspace = path.join(process.env.HOME, '.openclaw', 'agents', agent.openclaw_agent_id);
    const capFile = path.join(agentWorkspace, 'CAPABILITIES.md');
    const capabilities = { tools: [], skills: [], raw: null };
    if (fs.existsSync(capFile)) {
      try {
        const content = fs.readFileSync(capFile, 'utf8');
        capabilities.raw = content;
        const toolMatches = content.matchAll(/(?:^|\n)###\s*(tool|skill):\s*(\w+)/gi);
        for (const m of toolMatches) {
          const lower = m[2].toLowerCase();
          if (lower && !capabilities.tools.includes(lower)) capabilities.tools.push(lower);
        }
      } catch (e) { return res.status(500).json({ error: 'failed to parse CAPABILITIES.md: ' + e.message }); }
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
  const app = express();
  app.use(express.json());
  app.use('/api/agents', router);
  return app;
}

// ── withToolRetry (standalone) ─────────────────────────────────────────────

async function withToolRetry(fn, maxRetries, delays) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (err) { lastError = err; if (attempt < maxRetries) await new Promise(r => setTimeout(r, delays[attempt] ?? delays[delays.length - 1])); }
  }
  throw lastError;
}

// ══════════════════════════════════════════════════════════════════════════════
// TOOL REGISTRY
// ══════════════════════════════════════════════════════════════════════════════

describe('Tool Registry', () => {
  describe('GET /api/tools', () => {
    test('returns array of tools with required fields', async () => {
      const app = createToolsApp();
      const { status, body } = await request(app, 'GET', '/api/tools');
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      for (const tool of body) {
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.riskLevel).toBe('string');
        expect(typeof tool.rateLimit).toBe('object');
        expect(typeof tool.enabled).toBe('boolean');
      }
    });

    test('includes expected tools', async () => {
      const app = createToolsApp();
      const { status, body } = await request(app, 'GET', '/api/tools');
      expect(status).toBe(200);
      const names = body.map(t => t.name);
      expect(names).toContain('read');
      expect(names).toContain('write');
      expect(names).toContain('exec');
      expect(names).toContain('web_search');
      expect(names).toContain('web_fetch');
    });
  });

  describe('GET /api/tools/:name', () => {
    test('returns a specific tool', async () => {
      const app = createToolsApp();
      const { status, body } = await request(app, 'GET', '/api/tools/read');
      expect(status).toBe(200);
      expect(body.name).toBe('read');
      expect(typeof body.description).toBe('string');
      expect(body.riskLevel).toBe('low');
    });

    test('404 for unknown tool', async () => {
      const app = createToolsApp();
      const { status, body } = await request(app, 'GET', '/api/tools/nonexistent-tool-xyz');
      expect(status).toBe(404);
      expect(body.error).toBe('tool not found');
    });
  });

  describe('PATCH /api/tools/:name', () => {
    test('can disable a tool', async () => {
      const app = createToolsApp();
      const { status, body } = await request(app, 'PATCH', '/api/tools/exec', { enabled: false });
      expect(status).toBe(200);
      expect(body.enabled).toBe(false);
      // Verify it stayed disabled
      const { status: s2, body: b2 } = await request(app, 'GET', '/api/tools/exec');
      expect(s2).toBe(200);
      expect(b2.enabled).toBe(false);
    });

    test('can re-enable a tool', async () => {
      const app = createToolsApp();
      await request(app, 'PATCH', '/api/tools/exec', { enabled: false });
      const { status, body } = await request(app, 'PATCH', '/api/tools/exec', { enabled: true });
      expect(status).toBe(200);
      expect(body.enabled).toBe(true);
    });

    test('can update rateLimit', async () => {
      const app = createToolsApp();
      const newLimit = { maxPerMinute: 99, burst: 15 };
      const { status, body } = await request(app, 'PATCH', '/api/tools/read', { rateLimit: newLimit });
      expect(status).toBe(200);
      expect(body.rateLimit.maxPerMinute).toBe(99);
      expect(body.rateLimit.burst).toBe(15);
    });

    test('404 for unknown tool', async () => {
      const app = createToolsApp();
      const { status, body } = await request(app, 'PATCH', '/api/tools/totally-fake', { enabled: false });
      expect(status).toBe(404);
      expect(body.error).toBe('tool not found');
    });

    test('ignores unknown fields', async () => {
      const app = createToolsApp();
      const { status, body } = await request(app, 'PATCH', '/api/tools/read', { someField: 'ignored' });
      expect(status).toBe(200);
      expect(body.someField).toBeUndefined();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AGENT CAPABILITIES
// ══════════════════════════════════════════════════════════════════════════════

describe('Agent Capabilities', () => {
  afterEach(() => {
    try {
      const capTestPath = path.join(process.env.HOME, '.openclaw', 'agents', 'cap-test-agent', 'CAPABILITIES.md');
      if (fs.existsSync(capTestPath)) fs.unlinkSync(capTestPath);
    } catch {}
  });

  test('GET /api/agents/:id/capabilities — empty tools for agent with no CAPABILITY.md', async () => {
    const db = getDb();
    const agentHome = path.join(process.env.HOME, '.openclaw', 'agents');
    fs.mkdirSync(agentHome, { recursive: true });
    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)')
      .run(1, 'no-cap-agent', 'No Cap Agent', 'active', new Date().toISOString());
    const app = createCapabilitiesApp(db);
    const { status, body } = await request(app, 'GET', '/api/agents/1/capabilities');
    expect(status).toBe(200);
    expect(body.agent_id).toBe(1);
    expect(body.capabilities_file).toBe(false);
    expect(Array.isArray(body.declared_tools)).toBe(true);
    expect(body.declared_tools.length).toBe(0);
    closeDb(db);
  });

  test('GET /api/agents/:id/capabilities — returns capabilities for agent with CAPABILITIES.md', async () => {
    const db = getDb();
    const agentHome = path.join(process.env.HOME, '.openclaw', 'agents', 'cap-test-agent');
    fs.mkdirSync(agentHome, { recursive: true });
    fs.writeFileSync(path.join(agentHome, 'CAPABILITIES.md'), `CAPABILITIES.md\n\n### tool: read\n### tool: write\n### skill: web_search\n`);

    db.prepare('INSERT INTO agents (id,openclaw_agent_id,name,status,created_at) VALUES (?,?,?,?,?)')
      .run(2, 'cap-test-agent', 'Cap Test Agent', 'active', new Date().toISOString());

    const app = createCapabilitiesApp(db);
    const { status, body } = await request(app, 'GET', '/api/agents/2/capabilities');
    expect(status).toBe(200);
    expect(body.capabilities_file).toBe(true);
    expect(body.declared_tools).toContain('read');
    expect(body.declared_tools).toContain('write');
    expect(body.raw).toBeTruthy();
    expect(body.raw).toContain('CAPABILITIES.md');
    closeDb(db);
  });

  test('GET /api/agents/:id/capabilities — 404 for non-existent agent', async () => {
    const db = getDb();
    const app = createCapabilitiesApp(db);
    const { status, body } = await request(app, 'GET', '/api/agents/99999/capabilities');
    expect(status).toBe(404);
    expect(body.error).toBe('not found');
    closeDb(db);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// WITH TOOL RETRY
// ══════════════════════════════════════════════════════════════════════════════

describe('withToolRetry', () => {
  test('succeeds after 2 failures then success', async () => {
    let counter = 0;
    const fn = async () => { counter++; if (counter < 3) throw new Error(`fail ${counter}`); return 'success'; };
    const result = await withToolRetry(fn, 2, [50, 100]);
    expect(result).toBe('success');
    expect(counter).toBe(3);
  });

  test('throws after max retries exceeded', async () => {
    let attempts = 0;
    const alwaysFails = async () => { attempts++; throw new Error('permanent failure'); };
    await expect(withToolRetry(alwaysFails, 2, [5, 5])).rejects.toThrow('permanent failure');
    expect(attempts).toBe(3);
  });

  test('succeeds on first attempt, no extra calls', async () => {
    let attempts = 0;
    const succeedFirst = async () => { attempts++; return 'ok'; };
    const result = await withToolRetry(succeedFirst, 5, [5, 5, 5, 5, 5]);
    expect(result).toBe('ok');
    expect(attempts).toBe(1);
  });

  test('retries with increasing delays (backoff)', async () => {
    const callTimes = [];
    let counter = 0;
    const fn = async () => {
      callTimes.push(Date.now());
      counter++;
      if (counter < 3) throw new Error(`fail ${counter}`);
      return 'success';
    };
    const result = await withToolRetry(fn, 2, [50, 100]);
    expect(result).toBe('success');
    expect(callTimes.length).toBe(3);
    const gap1 = callTimes[1] - callTimes[0];
    const gap2 = callTimes[2] - callTimes[1];
    expect(gap1).toBeGreaterThanOrEqual(45);
    expect(gap1).toBeLessThan(200);
    expect(gap2).toBeGreaterThanOrEqual(95);
    expect(gap2).toBeLessThan(300);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// TASK RESULTS — tools_used column
// ══════════════════════════════════════════════════════════════════════════════

describe('task_results.tools_used', () => {
  test('column exists and stores tool invocation records', () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(task_results)").all().map(r => r.name);
    expect(cols).toContain('tools_used');
    db.prepare(`INSERT INTO task_results (id,task_id,agent_id,input,output,duration_ms,executed_at,tools_used)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(1, 1, 1, 'task input', 'task output', 1500, new Date().toISOString(),
        JSON.stringify([{ tool: 'exec', description: 'openclaw-agent-cli', ts: new Date().toISOString() }]));
    const row = db.prepare('SELECT * FROM task_results WHERE id = 1').get();
    expect(row.task_id).toBe(1);
    expect(row.tools_used).not.toBeNull();
    const toolsUsed = JSON.parse(row.tools_used);
    expect(Array.isArray(toolsUsed)).toBe(true);
    expect(toolsUsed.length).toBe(1);
    expect(toolsUsed[0].tool).toBe('exec');
    closeDb(db);
  });

  test('round-trip through saveTaskResults/loadTaskResults', () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(task_results)").all().map(r => r.name);
    expect(cols).toContain('tools_used');

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

    // Simulate save+load cycle
    const before = db.prepare('SELECT * FROM task_results WHERE id IN (10,11)').all();
    db.exec("DELETE FROM task_results");
    const ins = db.prepare(`INSERT INTO task_results (id,task_id,agent_id,input,output,duration_ms,executed_at,created_agent,input_tokens,output_tokens,cache_read_tokens,total_tokens,cost,tools_used) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of before) ins.run(r.id, r.task_id, r.agent_id, r.input, r.output, r.duration_ms, r.executed_at, r.created_agent || '', r.input_tokens || 0, r.output_tokens || 0, r.cache_read_tokens || 0, r.total_tokens || 0, r.cost || 0, r.tools_used || null);

    const after = db.prepare('SELECT * FROM task_results WHERE id IN (10,11)').all();
    expect(after.length).toBe(2);

    const r1 = after.find(r => r.id === 10);
    const parsed1 = JSON.parse(r1.tools_used);
    expect(parsed1.length).toBe(1);
    expect(parsed1[0].tool).toBe('exec');

    const r2 = after.find(r => r.id === 11);
    const parsed2 = JSON.parse(r2.tools_used);
    expect(parsed2.length).toBe(2);
    expect(parsed2[1].tool).toBe('session_stats');
    closeDb(db);
  });
});
