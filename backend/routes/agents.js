const db = require('../db');

function normalizeTask(t, agents) {
  const a = agents?.find(x => x.id === t.assigned_agent_id);
  return { ...t, priority: t.priority || 'medium', agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id };
}

module.exports = function(router, { db, broadcastSSE, setTaskStatus, nextId }) {
  // Agents CRUD
  router.get('/', (req, res) => {
    let agents = db.loadAgents();
    const tasks = db.loadTasks();
    if (req.query.status) agents = agents.filter(a => a.status === req.query.status);
    if (req.query.search) { const s = req.query.search.toLowerCase(); agents = agents.filter(a => a.name.toLowerCase().includes(s) || a.openclaw_agent_id.toLowerCase().includes(s)); }
    if (!req.query.status) agents = agents.filter(x => x.status === 'active');
    const taskCounts = {};
    for (const t of tasks) {
      if (!taskCounts[t.assigned_agent_id]) taskCounts[t.assigned_agent_id] = {pending: 0, in_progress: 0, done: 0, failed: 0};
      if (t.status === 'pending') taskCounts[t.assigned_agent_id].pending++;
      else if (t.status === 'in_progress') taskCounts[t.assigned_agent_id].in_progress++;
      else if (t.status === 'done') taskCounts[t.assigned_agent_id].done++;
      else if (t.status === 'failed') taskCounts[t.assigned_agent_id].failed++;
    }
    const allResults = db.loadTaskResults();
    const result = agents.map(a => {
      const agentResults = allResults.filter(r => r.agent_id === a.id);
      const totalCost = agentResults.reduce((s, r) => s + (r.cost || 0), 0);
      return {
        ...a,
        tasks_pending: taskCounts[a.id]?.pending || 0,
        tasks_in_progress: taskCounts[a.id]?.in_progress || 0,
        tasks_done: taskCounts[a.id]?.done || 0,
        tasks_failed: taskCounts[a.id]?.failed || 0,
        total_cost_usd: parseFloat(totalCost.toFixed(6)),
      };
    });
    res.json({ agents: result });
  });

  router.post('/', async (req, res) => {
    const { job_title, job_description, openclaw_agent_id, name, status, budget_limit, heartbeat_enabled, heartbeat_interval } = req.body;
    const { createOpenClawAgent } = require('../services/executor');
    const title = job_title || name;
    const desc = job_description || '';
    const agentId = openclaw_agent_id || (title ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '');
    if (!title) return res.status(400).json({ error: 'job_title required' });
    try {
      const agents = db.loadAgents();
      if (agents.find(a => a.openclaw_agent_id === agentId)) return res.status(409).json({ error: 'Agent already exists' });
      const oc = await createOpenClawAgent(agentId, title, null, { vibe: desc });
      const agent = { id: nextId('agents'), openclaw_agent_id: agentId, name: title, status: status || 'idle', budget_limit: budget_limit || 0, budget_spent: 0, heartbeat_enabled: 1, heartbeat_interval: heartbeat_interval || 30, last_heartbeat: null, created_at: new Date().toISOString() };
      agents.push(agent);
      db.saveAgents(agents);
      broadcastSSE('agents', { action: 'created', agent });
      res.status(201).json({ agent, openclaw: oc });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/:id', (req, res) => { const a = db.loadAgents().find(x => x.id === +req.params.id); a ? res.json({ agent: a }) : res.status(404).json({ error: 'not found' }); });

  router.get('/:id/stats', (req, res) => {
    const agent = db.loadAgents().find(x => x.id === +req.params.id);
    if (!agent) return res.status(404).json({ error: 'not found' });
    const tasks = db.loadTasks().filter(t => t.assigned_agent_id === agent.id);
    const projects = db.loadProjects();
    const projectIds = [...new Set(tasks.map(t => t.project_id))];
    const hbs = db.loadHeartbeats().filter(h => h.agent_id === agent.id);
    const lastHb = hbs.reduce((best, h) => (!best || h.id > best.id) ? h : best, null);
    const byStatus = {};
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    // Aggregate usage / cost from task_results for this agent
    const allResults = db.loadTaskResults().filter(r => r.agent_id === agent.id);
    const totalInputTokens    = allResults.reduce((s, r) => s + (r.input_tokens  || 0), 0);
    const totalOutputTokens   = allResults.reduce((s, r) => s + (r.output_tokens || 0), 0);
    const totalCacheRead      = allResults.reduce((s, r) => s + (r.cache_read_tokens || 0), 0);
    const totalCost           = allResults.reduce((s, r) => s + (r.cost || 0), 0);
    res.json({
      agent_id: agent.id, name: agent.name, openclaw_agent_id: agent.openclaw_agent_id,
      status: agent.status, heartbeat_enabled: !!agent.heartbeat_enabled,
      last_heartbeat: agent.last_heartbeat,
      tasks: { total: tasks.length, ...byStatus },
      projects: projectIds.map(pid => { const p = projects.find(x => x.id === pid); return { id: pid, title: p?.title || 'Unknown', tasks: tasks.filter(t => t.project_id === pid).length }; }),
      heartbeat_runs: hbs.length,
      last_heartbeat_action: lastHb ? (() => { try { return JSON.parse(lastHb.action_taken); } catch { return { raw: lastHb.action_taken }; } })() : null,
      usage: {
        total_input_tokens:    totalInputTokens,
        total_output_tokens:   totalOutputTokens,
        total_cache_read_tokens: totalCacheRead,
        total_cost_usd:        parseFloat(totalCost.toFixed(6)),
        task_runs:             allResults.length,
      },
    });
  });

  router.get('/:id/tasks', (req, res) => {
    const agent = db.loadAgents().find(x => x.id === +req.params.id);
    if (!agent) return res.status(404).json({ error: 'not found' });
    let tasks = db.loadTasks().filter(t => t.assigned_agent_id === agent.id);
    if (req.query.status) tasks = tasks.filter(t => t.status === req.query.status);
    if (req.query.project_id) tasks = tasks.filter(t => t.project_id === +req.query.project_id);
    const pri = { high: 0, medium: 1, low: 2 };
    tasks.sort((a, b) => (pri[a.priority] ?? 1) - (pri[b.priority] ?? 1) || a.id - b.id);
    res.json({ agent_id: agent.id, agent_name: agent.name, tasks: tasks.length, data: tasks });
  });

  router.put('/:id', (req, res) => {
    const agents = db.loadAgents();
    const a = agents.find(x => x.id === +req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    const { name, status, budget_limit, budget_spent, heartbeat_enabled, heartbeat_interval } = req.body;
    Object.assign(a, { name: name ?? a.name, status: status ?? a.status, budget_limit: budget_limit ?? a.budget_limit, budget_spent: budget_spent ?? a.budget_spent, heartbeat_enabled: heartbeat_enabled !== undefined ? (heartbeat_enabled ? 1 : 0) : a.heartbeat_enabled, heartbeat_interval: Math.max(1, +(heartbeat_interval ?? a.heartbeat_interval)) });
    db.saveAgents(agents);
    broadcastSSE('agents', { action: 'updated', agent: a });
    res.json({ agent: a });
  });

  router.delete('/:id', async (req, res) => {
    const agents = db.loadAgents();
    const agent = agents.find(x => x.id === +req.params.id);
    if (!agent) return res.status(404).json({ error: 'not found' });
    const tasks = db.loadTasks();
    const agentTasks = tasks.filter(t => t.assigned_agent_id === agent.id && t.status !== 'done');
    if (agentTasks.length > 0 && req.query.force !== '1') {
      return res.status(400).json({ error: 'agent has active pending tasks', pending_tasks: agentTasks.length, hint: 'add ?force=1 to delete anyway' });
    }
    const { deleteOpenClawAgent } = require('../services/executor');
    try {
      await deleteOpenClawAgent(agent.openclaw_agent_id);
    } catch (e) {
      return res.status(500).json({ error: 'CLI delete failed: ' + e.message });
    }
    db.hardDelete('tasks', { assigned_agent_id: agent.id });
    db.hardDelete('agents', { id: agent.id });
    broadcastSSE('agents', { action: 'deleted', agent_id: agent.id });
    res.json({ ok: true, deleted: true });
  });

  router.post('/:id/heartbeat', async (req, res) => {
    const { triggerHeartbeat } = require('../services/heartbeat');
    const agent = db.loadAgents().find(x => x.id === +req.params.id);
    if (!agent) return res.status(404).json({ error: 'not found' });
    try { res.json(await triggerHeartbeat(agent)); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/:id/reactivate', (req, res) => {
    const agents = db.loadAgents();
    const a = agents.find(x => x.id === +req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    if (a.status === 'active') return res.status(400).json({ error: 'agent is already active' });
    a.status = 'active';
    a.heartbeat_enabled = 1;
    db.saveAgents(agents);
    res.json({ agent: { ok: true, id: a.id, name: a.name, status: a.status } });
  });

  // GET /api/agents/:id/capabilities — return tools and skills available to this agent
  router.get('/:id/capabilities', (req, res) => {
    const agent = db.loadAgents().find(x => x.id === +req.params.id);
    if (!agent) return res.status(404).json({ error: 'not found' });

    // Read CAPABILITIES.md from agent's workspace if it exists
    const fs = require('fs');
    const path = require('path');
    const agentWorkspace = path.join(process.env.HOME, '.openclaw', 'agents', agent.openclaw_agent_id);
    const capFile = path.join(agentWorkspace, 'CAPABILITIES.md');

    let capabilities = { tools: [], skills: [], raw: null };

    if (fs.existsSync(capFile)) {
      try {
        const content = fs.readFileSync(capFile, 'utf8');
        capabilities.raw = content;

        // Parse tool entries (simple line-based extraction)
        const toolMatches = content.match(/(?:^|\n)###?\s*(?:tool|skill):?\s*(\w+)/gi);
        if (toolMatches) {
          for (const m of toolMatches) {
            const name = m.replace(/^###?\s*(?:tool|skill):?\s*/i, '').trim();
            const lower = name.toLowerCase();
            if (lower && !capabilities.tools.includes(lower)) capabilities.tools.push(lower);
          }
        }

        // Also collect any lines that just mention tool names at start of line
        const allToolNames = ['read', 'write', 'exec', 'web_search', 'web_fetch', 'image', 'video', 'music'];
        for (const t of allToolNames) {
          const regex = new RegExp(`(^|\n)\s*[-*\u2022]\s*${t}\b`, 'i');
          if (regex.test(content) && !capabilities.tools.includes(t)) {
            capabilities.tools.push(t);
          }
        }
      } catch (e) {
        return res.status(500).json({ error: 'failed to parse CAPABILITIES.md: ' + e.message });
      }
    }

    // Always include the base toolset from tool-registry
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
};