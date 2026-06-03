const path = require('path');
const fs = require('fs');

module.exports = function(router, { db, broadcastSSE, setTaskStatus, nextId }) {

  router.get('/', (req, res) => {
    let projects = db.loadProjects();
    if (req.query.status) projects = projects.filter(p => p.status === req.query.status);
    if (req.query.template === '1') projects = projects.filter(p => p.is_template);
    const tasks = db.loadTasks();
    res.json({ projects: projects.map(p => {
      const pt = tasks.filter(t => t.project_id === p.id);
      const done = pt.filter(t => t.status === 'done').length;
      return { ...p, task_total: pt.length, task_done: done, completion_pct: pt.length > 0 ? Math.round(done / pt.length * 100) : 0 };
    }) });
  });

  router.post('/', (req, res) => {
    const { title, description, workspace_path, status, is_template, creates_agent } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200 chars)' });
    if (status && !['active', 'completed', 'failed'].includes(status)) return res.status(400).json({ error: 'status must be active, completed, or failed' });
    let finalWorkspace = workspace_path?.trim();
    if (!finalWorkspace) {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      finalWorkspace = path.join(process.env.HOME, `clawdesk-projects/${slug}-${Date.now()}`);
    }
    fs.mkdirSync(finalWorkspace, { recursive: true, mode: 0o755 });
    const projects = db.loadProjects();
    const p = { id: nextId('projects'), title, description: description || '', workspace_path: finalWorkspace, status: status || 'active', is_template: is_template ? 1 : 0, template_source_id: null, creates_agent: creates_agent || null, created_at: new Date().toISOString() };
    projects.push(p);
    db.saveProjects(projects);
    broadcastSSE('projects', { action: 'created', project: p });
    res.status(201).json({ project: p });
  });

  router.get('/:id', (req, res) => {
    const p = db.loadProjects().find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const agents = db.loadAgents();
    const allTasks = db.loadTasks();
    const tasks = allTasks.filter(t => t.project_id === p.id).map(t => {
      const a = agents.find(x => x.id === t.assigned_agent_id);
      const cb = agents.find(x => x.id === t.created_by_agent_id);
      const safeDeps = (s) => { try { const p = JSON.parse(s); return Array.isArray(p) ? p : []; } catch { return []; } };
      const deps = safeDeps(t.dependency_ids);
      const dep = deps.length ? allTasks.find(d => d.id === deps[0]) : null;
      return { ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id, created_by_agent_slug: cb?.openclaw_agent_id, dep_title: dep?.title };
    });
    const done = tasks.filter(t => t.status === 'done').length;
    res.json({ ...p, tasks, task_total: tasks.length, task_done: done, completion_pct: tasks.length > 0 ? Math.round(done / tasks.length * 100) : 0 });
  });

  router.get('/:id/stats', (req, res) => {
    const p = db.loadProjects().find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const agents = db.loadAgents();
    const tasks = db.loadTasks().filter(t => t.project_id === p.id);
    const allTaskIds = new Set(tasks.map(t => t.id));
    const byStatus = {}; const byPriority = {}; const byAgent = {};
    let oldestPending = null; let oldestInProgress = null;
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      byPriority[t.priority || 'medium'] = (byPriority[t.priority || 'medium'] || 0) + 1;
      if (t.assigned_agent_id) {
        if (!byAgent[t.assigned_agent_id]) byAgent[t.assigned_agent_id] = { pending: 0, in_progress: 0, done: 0, failed: 0, total: 0 };
        byAgent[t.assigned_agent_id][t.status] = (byAgent[t.assigned_agent_id][t.status] || 0) + 1;
        byAgent[t.assigned_agent_id].total++;
      }
      if (t.status === 'pending' && (!oldestPending || t.created_at < oldestPending)) oldestPending = t.created_at;
      if (t.status === 'in_progress' && (!oldestInProgress || (t._status_changed_at || t.created_at) < oldestInProgress)) oldestInProgress = t._status_changed_at || t.created_at;
    }
    const agentBreakdown = Object.entries(byAgent).map(([aid, counts]) => {
      const a = agents.find(x => x.id === +aid);
      return { agent_id: +aid, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id, ...counts };
    }).sort((a, b) => b.total - a.total);
    // Cost aggregation from task_results for tasks in this project
    const allResults = db.loadTaskResults().filter(r => allTaskIds.has(r.task_id));
    const totalCost = allResults.reduce((s, r) => s + (r.cost || 0), 0);
    const costByAgent = {};
    for (const r of allResults) {
      if (!costByAgent[r.agent_id]) costByAgent[r.agent_id] = 0;
      costByAgent[r.agent_id] += r.cost || 0;
    }
    const costBreakdown = Object.entries(costByAgent).map(([aid, cost]) => {
      const a = agents.find(x => x.id === +aid);
      return { agent_id: +aid, agent_name: a?.name, cost_usd: parseFloat(cost.toFixed(6)) };
    }).sort((a, b) => b.cost_usd - a.cost_usd);
    res.json({
      project_id: p.id, title: p.title, status: p.status,
      total_tasks: tasks.length, completion_pct: tasks.length > 0 ? Math.round((byStatus.done || 0) / tasks.length * 100) : 0,
      by_status: byStatus, by_priority: byPriority,
      agent_breakdown: agentBreakdown,
      oldest_pending: oldestPending, oldest_in_progress: oldestInProgress,
      total_cost_usd: parseFloat(totalCost.toFixed(6)),
      cost_breakdown: costBreakdown,
    });
  });

  router.put('/:id', (req, res) => {
    const projects = db.loadProjects();
    const p = projects.find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const { title, description, workspace_path, status, is_template, creates_agent } = req.body;
    if (workspace_path === '') return res.status(400).json({ error: 'workspace_path cannot be empty string (use null or omit to keep existing)' });
    Object.assign(p, { title: title ?? p.title, description: description ?? p.description, workspace_path: workspace_path ?? p.workspace_path, status: status ?? p.status, is_template: is_template !== undefined ? (is_template ? 1 : 0) : p.is_template, creates_agent: creates_agent !== undefined ? (creates_agent || null) : p.creates_agent });
    db.saveProjects(projects);
    broadcastSSE('projects', { action: 'updated', project: p });
    res.json({ project: p });
  });

  router.post('/:id/reopen', (req, res) => {
    const projects = db.loadProjects();
    const p = projects.find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.status === 'active') return res.status(400).json({ error: 'project is already active' });
    p.status = 'active';
    db.saveProjects(projects);
    broadcastSSE('projects', { action: 'updated', project: p });
    res.json({ ok: true, id: p.id, title: p.title, status: p.status });
  });

  router.post('/:id/clone', (req, res) => {
    const projects = db.loadProjects();
    const source = projects.find(x => x.id === +req.params.id);
    if (!source) return res.status(404).json({ error: 'not found' });
    const allTasks = db.loadTasks();
    const sourceTasks = allTasks.filter(t => t.project_id === source.id);

    // Create new project
    const newId = nextId('projects');
    const slug = (source.title + '-clone').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let ws = path.join(process.env.HOME, `clawdesk-projects/${slug}-${Date.now()}`);
    fs.mkdirSync(ws, { recursive: true, mode: 0o755 });
    const now = new Date().toISOString();
    const newProject = {
      ...source,
      id: newId,
      title: source.title + ' (clone)',
      status: 'active',
      is_template: source.is_template,
      template_source_id: source.id,
      created_at: now,
      workspace_path: ws,
      creates_agent: null,
    };
    projects.push(newProject);
    db.saveProjects(projects);

    // Clone tasks with all reset to pending
    const newTasks = allTasks.filter(t => t.project_id !== source.id);
    const idMap = {}; // old id -> new id
    for (const t of sourceTasks) {
      const newTaskId = nextId('tasks');
      idMap[t.id] = newTaskId;
      newTasks.push({
        ...t,
        id: newTaskId,
        project_id: newId,
        status: 'pending',
        assigned_agent_id: null,
        created_at: now,
        completed_at: null,
        run_count: 0,
        _retry_count: 0,
        _status_changed_at: null,
      });
    }
    // Remap dependency ids in cloned tasks
    for (const t of newTasks) {
      if (t.dependency_ids) {
        try {
          const ids = JSON.parse(t.dependency_ids);
          const remapped = ids.map(id => idMap[id] || id).filter(x => x);
          if (remapped.length) t.dependency_ids = JSON.stringify(remapped);
        } catch {}
      }
    }
    db.saveTasks(newTasks);
    broadcastSSE('projects', { action: 'created', project: newProject });
    res.status(201).json({ project: { ...newProject, task_total: sourceTasks.length, task_done: 0, completion_pct: 0 } });
  });

  router.delete('/:id', (req, res) => {
    const projects = db.loadProjects();
    const p = projects.find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    db.remove('projects', { id: p.id });
    db.remove('tasks', { project_id: p.id });
    broadcastSSE('projects', { action: 'deleted', project_id: p.id });
    res.json({ ok: true, soft_deleted: true });
  });

  router.get('/:id/tasks', (req, res) => {
    const agents = db.loadAgents();
    let tasks = db.loadTasks().filter(t => t.project_id === +req.params.id);
    if (req.query.status) tasks = tasks.filter(t => t.status === req.query.status);
    if (req.query.priority) tasks = tasks.filter(t => t.priority === req.query.priority);
    if (req.query.agent_id) tasks = tasks.filter(t => t.assigned_agent_id === +req.query.agent_id);
    if (req.query.search) { const s = req.query.search.toLowerCase(); tasks = tasks.filter(t => (t.title || '').toLowerCase().includes(s)); }
    const allTasks = db.loadTasks();
    res.json(tasks.map(t => {
      const a = agents.find(x => x.id === t.assigned_agent_id);
      const cb = agents.find(x => x.id === t.created_by_agent_id);
      const safeDeps = (s) => { try { const p = JSON.parse(s); return Array.isArray(p) ? p : []; } catch { return []; } };
      const deps = safeDeps(t.dependency_ids);
      const dep = deps.length ? allTasks.find(d => d.id === deps[0]) : null;
      return { ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id, created_by_agent_slug: cb?.openclaw_agent_id, dep_title: dep?.title || null };
    }));
  });

  router.post('/:id/tasks', (req, res) => {
    if (!db.loadProjects().find(p => p.id === +req.params.id)) return res.status(404).json({ error: 'project not found' });
    const project = db.loadProjects().find(p => p.id === +req.params.id);
    const { assigned_agent_id, title, description, status, dependency_ids, creates_agent, created_by_agent_id, priority, repeat } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    if (title.length > 500) return res.status(400).json({ error: 'title too long (max 500 chars)' });
    if (priority && !['low', 'medium', 'high'].includes(priority)) return res.status(400).json({ error: 'priority must be low, medium, or high' });
    const toNum = (v) => (v === '' || v === null || v === undefined) ? null : +v || null;
    const toNumArr = (v) => {
      if (!v) return null;
      if (Array.isArray(v)) return v.map(x => +x).filter(x => x);
      if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(x => +x).filter(x => x) : null; } catch { return null; } }
      return null;
    };
    const assignId = toNum(assigned_agent_id);
    if (assignId) {
      const allAgents = db.loadAgents();
      if (!allAgents.find(a => a.id === assignId)) return res.status(400).json({ error: `agent #${assignId} not found` });
    }
    const depIds = toNumArr(dependency_ids);
    if (depIds) {
      const allTasks = db.loadTasks();
      for (const id of depIds) {
        const dep = allTasks.find(t => t.id === id);
        if (!dep) return res.status(400).json({ error: `dependency task #${id} not found` });
        if (dep.project_id !== +req.params.id) return res.status(400).json({ error: `dependency task #${id} belongs to a different project` });
      }
    }
    const tasks = db.loadTasks();
    const t = {
      id: nextId('tasks'),
      project_id: +req.params.id,
      assigned_agent_id: toNum(assigned_agent_id),
      title,
      description: description || '',
      status: status || 'pending',
      dependency_ids: depIds ? JSON.stringify(depIds) : null,
      creates_agent: (creates_agent && project.creates_agent) ? creates_agent : null,
      created_by_agent_id: toNum(created_by_agent_id),
      priority: priority || 'medium',
      created_at: new Date().toISOString(),
      completed_at: null,
      scheduled_at: req.body.scheduled_at || null,
      requires_approval: req.body.requires_approval ? 1 : 0,
    };
    tasks.push(t);
    db.saveTasks(tasks);
    const agents = db.loadAgents();
    const a = agents.find(x => x.id === t.assigned_agent_id);
    res.status(201).json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id });
  });

  router.post('/:id/tasks/from-agent', (req, res) => {
    if (!db.loadProjects().find(p => p.id === +req.params.id)) return res.status(404).json({ error: 'project not found' });
    const { agent_id, title, description, assigned_to_agent_id, priority, dependency_ids } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    if (!agent_id) return res.status(400).json({ error: 'agent_id required (the agent creating this task)' });
    if (priority && !['low', 'medium', 'high'].includes(priority)) return res.status(400).json({ error: 'priority must be low, medium, or high' });
    const agents = db.loadAgents();
    const creatorAgent = agents.find(a => a.openclaw_agent_id === agent_id || a.id === agent_id);
    if (!creatorAgent) return res.status(404).json({ error: 'creator agent not found' });
    let assignedId = null;
    if (assigned_to_agent_id) {
      const assigned = agents.find(a => a.openclaw_agent_id === assigned_to_agent_id || a.id === +assigned_to_agent_id);
      if (assigned) assignedId = assigned.id;
    }
    if (!assignedId) return res.status(400).json({ error: 'assigned_to_agent_id is required (the agent who will do the work)' });
    const tasks = db.loadTasks();
    const toNumArr = (v) => {
      if (!v) return null;
      if (Array.isArray(v)) return v.map(x => +x).filter(x => x);
      if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(x => +x).filter(x => x) : null; } catch { return null; } }
      return null;
    };
    const depIds = toNumArr(dependency_ids);
    if (depIds) {
      for (const id of depIds) {
        const dep = tasks.find(t => t.id === id);
        if (!dep) return res.status(400).json({ error: `dependency task #${id} not found` });
        if (dep.project_id !== +req.params.id) return res.status(400).json({ error: `dependency task #${id} belongs to a different project` });
      }
    }
    const t = {
      id: nextId('tasks'), project_id: +req.params.id,
      assigned_agent_id: assignedId,
      title, description: description || '',
      status: 'pending', dependency_ids: depIds ? JSON.stringify(depIds) : null,
      creates_agent: null,
      created_by_agent_id: creatorAgent.id,
      priority: priority || 'medium',
      created_at: new Date().toISOString(), completed_at: null,
      scheduled_at: req.body.scheduled_at || null,
      requires_approval: req.body.requires_approval ? 1 : 0,
    };
    tasks.push(t);
    db.saveTasks(tasks);
    const a = agents.find(x => x.id === t.assigned_agent_id);
    res.status(201).json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id, created_by: creatorAgent.name });
  });

  // ===================== Scheduled Tasks =====================

  router.get('/:id/tasks/scheduled', (req, res) => {
    if (!db.loadProjects().find(p => p.id === +req.params.id)) return res.status(404).json({ error: 'project not found' });
    const tasks = db.loadTasks().filter(t => t.project_id === +req.params.id && t.scheduled_at);
    if (req.query.upcoming === '1') {
      const now = new Date();
      return res.json(tasks.filter(t => new Date(t.scheduled_at) > now).sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at)));
    }
    res.json(tasks.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at)));
  });

  // ===================== Trigger Rules =====================

  router.get('/:id/trigger-rules', (req, res) => {
    const p = db.loadProjects().find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    let rules = p.trigger_rules;
    if (typeof rules === 'string') { try { rules = JSON.parse(rules); } catch { rules = []; } }
    res.json({ project_id: p.id, trigger_rules: rules || [] });
  });

  router.put('/:id/trigger-rules', (req, res) => {
    const { trigger_rules } = req.body;
    if (trigger_rules !== undefined && !Array.isArray(trigger_rules)) return res.status(400).json({ error: 'trigger_rules must be an array' });
    const projects = db.loadProjects();
    const p = projects.find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    p.trigger_rules = Array.isArray(trigger_rules) ? JSON.stringify(trigger_rules) : (p.trigger_rules || '[]');
    db.saveProjects(projects);
    let rules = p.trigger_rules;
    if (typeof rules === 'string') { try { rules = JSON.parse(rules); } catch { rules = []; } }
    res.json({ ok: true, project_id: p.id, trigger_rules: rules });
  });

  // ── Capability registry ─────────────────────────────────────────────
  // Returns all agent CAPABILITY.md profiles for agents that have worked on this project.
  router.get('/:id/agents/capabilities', (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const tasks = db.loadTasks().filter(t => t.project_id === +req.params.id);
    const agentIds = [...new Set(tasks.map(t => t.assigned_agent_id).filter(Boolean))];
    const agents = db.loadAgents().filter(a => agentIds.includes(a.id));
    const profileRoot = process.env.AGENT_WORKSPACE_ROOT || path.join(process.env.HOME, '.openclaw', 'agents');
    const result = [];
    for (const agent of agents) {
      const capFile = path.join(profileRoot, agent.openclaw_agent_id, 'CAPABILITY.md');
      try {
        if (fs.existsSync(capFile)) {
          result.push({ agent_id: agent.id, openclaw_agent_id: agent.openclaw_agent_id, name: agent.name, capability_md: fs.readFileSync(capFile, 'utf8') });
        } else {
          result.push({ agent_id: agent.id, openclaw_agent_id: agent.openclaw_agent_id, name: agent.name, capability_md: null });
        }
      } catch {
        result.push({ agent_id: agent.id, openclaw_agent_id: agent.openclaw_agent_id, name: agent.name, capability_md: null });
      }
    }
    res.json(result);
  });
};