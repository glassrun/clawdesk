'use strict';
/**
 * smoke.test.js — end-to-end smoke tests for the ClawDesk backend
 *
 * Run: node tests/smoke.test.js [port]
 * Defaults to port 3777.
 */

const http = require('http');

const PORT = process.argv[2] || 3777;

// ── HTTP helpers ────────────────────────────────────────────────────────────────

function req(path, method, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = { hostname: 'localhost', port: +PORT, path, method, headers: {} };
    if (bodyStr) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = Buffer.byteLength(bodyStr); }
    const r = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

const get    = p  => req(p, 'GET');
const post   = (p, b) => req(p, 'POST', b);
const put    = (p, b) => req(p, 'PUT', b);
const patch  = (p, b) => req(p, 'PATCH', b);

// ── Poll helper ─────────────────────────────────────────────────────────────────

async function pollAsync(fn, maxMs, intervalMs = 500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== undefined && result !== null) return result;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// ── Assertions ─────────────────────────────────────────────────────────────────

function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg || ''}: expected ${b}, got ${a}`); }
function assertOk(a, msg)       { if (!a)    throw new Error(msg || 'assertion failed'); }

// ── Main ───────────────────────────────────────────────────────────────────────

async function runTests() {
  let passed = 0, failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      process.stdout.write(`  ${name}... ✓\n`);
      passed++;
    } catch (e) {
      process.stdout.write(`  ${name}... ✗ → ${e.message}\n`);
      failed++;
    }
  }

  // Verify server is up
  try {
    await get('/api/system/stats');
    process.stdout.write(`Server is up on port ${PORT}\n`);
  } catch (e) {
    process.stdout.write(`✗ Cannot reach server on port ${PORT}\n`);
    process.exit(1);
  }

  // ── Phase 1: workflow end-to-end ────────────────────────────────────────────

  process.stdout.write('\n=== Workflow end-to-end ===\n');

  let projectId, workflowRunId;

  await test('POST /api/projects — creates a project', async () => {
    const { status, body } = await post('/api/projects', {
      title: 'Smoke Test Project',
      status: 'active',
      workspace_path: '/tmp/smoke-test',
    });
    assertEqual(status, 201);
    assertOk(body.id, 'project has id');
    projectId = body.id;
  });

  await test('POST /api/projects/:id/workflows — creates a 2-step workflow', async () => {
    const { status, body } = await post(`/api/projects/${projectId}/workflows`, {
      title: 'Smoke Workflow',
      steps: [
        { agent_id: 'writer',   task: 'Draft overview', priority: 'high' },
        { agent_id: 'reviewer', task: 'Review draft',   priority: 'medium' },
      ],
    });
    assertEqual(status, 201);
    assertOk(body.run_id, 'run_id returned');
    assertEqual(body.status, 'running');
    assertEqual(body.steps_count, 2);
    workflowRunId = body.run_id;
  });

  await test('GET /api/projects/:id/workflows/:runId — workflow exists', async () => {
    const { status, body } = await get(`/api/projects/${projectId}/workflows/${workflowRunId}`);
    assertEqual(status, 200);
    assertEqual(body.status, 'running');
    assertEqual(body.current_step, 0);
  });

  await test('Workflow reaches step 1 within 30s', async () => {
    const result = await pollAsync(async () => {
      const { body } = await get(`/api/projects/${projectId}/workflows/${workflowRunId}`);
      return body.current_step >= 1 ? body : undefined;
    }, 30000);
    assertOk(result, 'step 1 never reached within 30s');
  });

  await test('Workflow completes within 120s', async () => {
    const result = await pollAsync(async () => {
      const { body } = await get(`/api/projects/${projectId}/workflows/${workflowRunId}`);
      if (body.status === 'completed' || body.status === 'failed') return body;
      return undefined;
    }, 120000);
    assertOk(result, 'workflow did not complete within 120s');
    assertEqual(result.status, 'completed', `workflow ${result.status}`);
  });

  await test('Workflow context has step outputs', async () => {
    const { body } = await get(`/api/projects/${projectId}/workflows/${workflowRunId}`);
    const ctx = typeof body.context === 'string' ? JSON.parse(body.context) : (body.context || {});
    assertOk(ctx.step_0, 'step_0 in context');
    assertOk(ctx.step_1, 'step_1 in context');
  });

  // ── Phase 2: task board coordination ───────────────────────────────────────

  process.stdout.write('\n=== Task board coordination ===\n');

  let taskId;

  await test('POST /api/projects/:id/tasks — creates a task', async () => {
    const { status, body } = await post(`/api/projects/${projectId}/tasks`, {
      title: 'Smoke task',
      priority: 'low',
    });
    assertEqual(status, 201);
    assertOk(body.id, 'task has id');
    taskId = body.id;
  });

  await test('GET /api/projects/:id/tasks — task is on board', async () => {
    const { status, body } = await get(`/api/projects/${projectId}/tasks`);
    assertEqual(status, 200);
    assertOk(Array.isArray(body) && body.some(t => t.id === taskId), 'task should appear in list');
  });

  await test('PUT /api/tasks/:id — can update task priority', async () => {
    const { status, body } = await put(`/api/tasks/${taskId}`, { priority: 'high' });
    assertEqual(status, 200);
    assertEqual(body.priority, 'high', 'priority updated');
  });

  // ── Phase 3: approvals ─────────────────────────────────────────────────────

  process.stdout.write('\n=== Approvals ===\n');

  let approvalId;

  await test('POST /api/approvals — creates a pending approval', async () => {
    const { status, body } = await post('/api/approvals', {
      task_id: taskId,
      status: 'pending',
      approver: 'admin',
      notes: 'smoke test',
    });
    assertEqual(status, 201);
    assertOk(body.id, 'approval has id');
    approvalId = body.id;
  });

  await test('GET /api/approvals?task_id=X — returns approvals for task', async () => {
    const { status, body } = await get(`/api/approvals?task_id=${taskId}`);
    assertEqual(status, 200);
    assertOk(Array.isArray(body) && body.length > 0, 'should have at least one approval');
    assertEqual(body[0].task_id, taskId, 'approval task_id matches');
  });

  // ── Phase 4: tool registry ─────────────────────────────────────────────────

  process.stdout.write('\n=== Tool registry ===\n');

  await test('GET /api/tools — returns tool list', async () => {
    const { status, body } = await get('/api/tools');
    assertEqual(status, 200);
    assertOk(Array.isArray(body) && body.length > 0, 'tools returned');
    assertOk(body[0].name && body[0].riskLevel, 'tool has name and riskLevel');
  });

  await test('PATCH /api/tools/read (disable) — tool can be disabled', async () => {
    const { status, body } = await patch('/api/tools/read', { enabled: false });
    assertOk(status === 200 || status === 400, `expected 200 or 400, got ${status}`);
    if (status === 200) assertEqual(body.enabled, false, 'tool disabled');
  });

  await test('PATCH /api/tools/read (re-enable) — tool can be re-enabled', async () => {
    const { status, body } = await patch('/api/tools/read', { enabled: true });
    assertEqual(status, 200, 're-enable returned 200');
    assertEqual(body.enabled, true, 'tool re-enabled');
  });

  // ── Summary ────────────────────────────────────────────────────────────────

  process.stdout.write(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(e => { console.error('Fatal:', e.message); process.exit(1); });