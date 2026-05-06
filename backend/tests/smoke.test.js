'use strict';
/**
 * smoke.test.js — end-to-end smoke tests for the ClawDesk backend
 *
 * Tests the full stack against a real (or test) server:
 * - Workflow creation and execution
 * - Task board coordination
 * - Approvals flow
 * - Database persistence
 *
 * Run: node tests/smoke.test.js [port]
 * Defaults to port 3777 if not specified.
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { getDb, closeDb, TEST_DB_PATH } = require('./helpers');

const PORT = process.argv[2] || 3777;
const BASE = `http://localhost:${PORT}`;

// ── HTTP helpers ────────────────────────────────────────────────────────────────

function req(path, method, body, port) {
  return new Promise((resolve, reject) => {
    const p = port || PORT;
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = { hostname: 'localhost', port: +p, path, method, headers: {} };
    if (bodyStr) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = Buffer.byteLength(bodyStr); }
    const r = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

function get(p) { return req(p, 'GET'); }
function post(p, b) { return req(p, 'POST', b); }
function put(p, b) { return req(p, 'PUT', b); }
function del(p) { return req(p, 'DELETE'); }

function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg || ''}: expected ${b}, got ${a}`); }
function assertOk(a, msg) { if (!a) throw new Error(msg || 'assertion failed'); }
function assertContains(a, b, msg) { if (!JSON.stringify(a).includes(b)) throw new Error(`${msg || ''}: expected ${JSON.stringify(a)} to contain ${b}`); }

// ── Poll helper ─────────────────────────────────────────────────────────────────

async function poll(fn, maxMs, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const result = await fn();
    if (result !== undefined && result !== null) return result;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`poll timed out after ${maxMs}ms`);
}

// ── Test suite ─────────────────────────────────────────────────────────────────

async function runTests() {
  let passed = 0, failed = 0;

  function test(name, fn) {
    process.stdout.write(`  ${name}... `);
    Promise.resolve().then(fn).then(() => { process.stdout.write('✓\n'); passed++; }).catch(e => { process.stdout.write(`✗\n    → ${e.message}\n`); failed++; });
  }

  // Verify server is up
  try {
    await get('/api/system/stats');
    process.stdout.write(`Server is up on port ${PORT}\n`);
  } catch (e) {
    process.stdout.write(`✗ Cannot reach server on port ${PORT} — run "openclaw gateway start" first\n`);
    process.exit(1);
  }

  process.stdout.write('\n=== Workflow end-to-end ===\n');

  let projectId, workflowRunId;

  test('POST /api/projects — creates a project', async () => {
    const { status, body } = await post('/api/projects', { title: 'Smoke Test Project', status: 'active', workspace_path: '/tmp/smoke-test' });
    assertEqual(status, 201);
    assertOk(body.id, 'project has id');
    projectId = body.id;
  });

  test('POST /api/projects/:id/workflows — creates a 2-step workflow', async () => {
    const { status, body } = await post(`/api/projects/${projectId}/workflows`, {
      title: 'Smoke Workflow',
      steps: [
        { agent_id: 'writer', task: 'Draft overview', priority: 'high' },
        { agent_id: 'reviewer', task: 'Review draft', priority: 'medium' },
      ],
    });
    assertEqual(status, 201);
    assertOk(body.run_id, 'run_id returned');
    assertEqual(body.status, 'running');
    assertEqual(body.steps_count, 2);
    workflowRunId = body.run_id;
  });

  test('GET /api/projects/:id/workflows/:runId — workflow exists', async () => {
    const { status, body } = await get(`/api/projects/${projectId}/workflows/${workflowRunId}`);
    assertEqual(status, 200);
    assertEqual(body.status, 'running');
    assertEqual(body.current_step, 0);
  });

  test('Workflow reaches step 1 within 30s', async () => {
    const result = await poll(async () => {
      const { body } = await get(`/api/projects/${projectId}/workflows/${workflowRunId}`);
      return body.current_step >= 1 ? body : undefined;
    }, 30000);
    assertOk(result.current_step >= 1, 'current_step should be >= 1');
  });

  test('Workflow completes within 60s', async () => {
    const result = await poll(async () => {
      const { body } = await get(`/api/projects/${projectId}/workflows/${workflowRunId}`);
      if (body.status === 'completed' || body.status === 'failed') return body;
      return undefined;
    }, 60000);
    assertEqual(result.status, 'completed', `expected completed, got ${result.status}: ${JSON.stringify(result.context)}`);
    assertEqual(result.current_step, 2, 'current_step should be 2 after completing 2 steps');
  });

  test('Workflow context has step outputs', async () => {
    const { body } = await get(`/api/projects/${projectId}/workflows/${workflowRunId}`);
    const ctx = typeof body.context === 'string' ? JSON.parse(body.context) : body.context;
    assertOk(ctx.step_0, 'step_0 should be in context');
    assertOk(ctx.step_1, 'step_1 should be in context');
  });

  process.stdout.write('\n=== Task board coordination ===\n');

  let taskId;

  test('POST /api/projects/:id/tasks — creates a task', async () => {
    const { status, body } = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Smoke task',
      priority: 'low',
    });
    assertEqual(status, 201);
    assertOk(body.id, 'task has id');
    taskId = body.id;
  });

  test('GET /api/projects/:id/tasks — task is on board', async () => {
    const { status, body } = await get(`/api/projects/${projectId}/tasks`);
    assertEqual(status, 200);
    assertOk(Array.isArray(body) && body.some(t => t.id === taskId), 'task should appear in list');
  });

  test('PUT /api/tasks/:id — can update task priority', async () => {
    const { status, body } = await put(`/api/tasks/${taskId}`, { priority: 'high' });
    assertEqual(status, 200);
    assertEqual(body.priority, 'high');
  });

  process.stdout.write('\n=== Approvals ===\n');

  test('POST /api/approvals — creates a pending approval', async () => {
    const { status, body } = await post('/api/approvals', { task_id: taskId, status: 'pending', approver: 'admin', notes: 'smoke test' });
    assertEqual(status, 201);
    assertOk(body.id, 'approval has id');
  });

  test('GET /api/approvals?task_id=X — returns approvals for task', async () => {
    const { status, body } = await get(`/api/approvals?task_id=${taskId}`);
    assertEqual(status, 200);
    assertOk(Array.isArray(body) && body.length > 0, 'should have at least one approval');
    assertEqual(body[0].task_id, taskId);
  });

  process.stdout.write('\n=== Tool registry ===\n');

  test('GET /api/tools — returns tool list', async () => {
    const { status, body } = await get('/api/tools');
    assertEqual(status, 200);
    assertOk(Array.isArray(body) && body.length > 0, 'should have tools');
    assertOk(body[0].name && body[0].riskLevel, 'tool should have name and riskLevel');
  });

  test('PATCH /api/tools/:name — can toggle tool enabled', async () => {
    const { status } = await put('/api/tools/read', { enabled: false });
    assertOk(status === 200 || status === 400, 'should return 200 or 400');
    const { status: s2, body: b2 } = await put('/api/tools/read', { enabled: true });
    assertEqual(s2, 200);
    assertEqual(b2.enabled, true);
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  await new Promise(r => setTimeout(r, 100)); // let async tests finish
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(e => { console.error(e); process.exit(1); });
