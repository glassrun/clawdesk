const path = require('path');
const fs = require('fs');

module.exports = function(router, { db, broadcastSSE, setTaskStatus, nextId }) {

  router.get('/', (req, res) => {
    let projects = db.loadProjects();
    if (req.query.status) projects = projects.filter(p => p.status === req.query.status);
    const tasks = db.loadTasks();
    res.json(projects.map(p => {
      const pt = tasks.filter(t => t.project_id === p.id);
      const done = pt.filter(t => t.status === 'done').length;
      return { ...p, task_total: pt.length, task_done: done, completion_pct: pt.length > 0 ? Math.round(done / pt.length * 100) : 0 };
    }));
  });

  router.post('/', (req, res) => {
    const { title, description, workspace_path, status } = req.body;
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
    const p = { id: nextId('projects'), title, description: description || '', workspace_path: finalWorkspace, status: status || 'active', created_at: new Date().toISOString() };
    projects.push(p);
    db.saveProjects(projects);
    res.status(201).json(p);
  });

  router.get('/:id', (req, res) => {
    const p = db.loadProjects().find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const agents = db.loadAgents();
    const allTasks = db.loadTasks();
    const tasks = allTasks.filter(t => t.project_id === p.id).map(t => {
      const a = agents.find(x => x.id === t.assigned_agent_id);
      const cb = agents.find(x => x.id === t.created_by_agent_id);
      const dep = allTasks.find(d => d.id === t.dependency_id);
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
    res.json({
      project_id: p.id, title: p.title, status: p.status,
      total_tasks: tasks.length, completion_pct: tasks.length > 0 ? Math.round((byStatus.done || 0) / tasks.length * 100) : 0,
      by_status: byStatus, by_priority: byPriority,
      agent_breakdown: agentBreakdown,
      oldest_pending: oldestPending, oldest_in_progress: oldestInProgress
    });
  });

  router.put('/:id', (req, res) => {
    const projects = db.loadProjects();
    const p = projects.find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const { title, description, workspace_path, status } = req.body;
    if (workspace_path === '') return res.status(400).json({ error: 'workspace_path cannot be empty string (use null or omit to keep existing)' });
    Object.assign(p, { title: title ?? p.title, description: description ?? p.description, workspace_path: workspace_path ?? p.workspace_path, status: status ?? p.status });
    db.saveProjects(projects);
    res.json(p);
  });

  router.post('/:id/reopen', (req, res) => {
    const projects = db.loadProjects();
    const p = projects.find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.status === 'active') return res.status(400).json({ error: 'project is already active' });
    p.status = 'active';
    db.saveProjects(projects);
    res.json({ ok: true, id: p.id, title: p.title, status: p.status });
  });

  router.delete('/:id', (req, res) => {
    const projects = db.loadProjects();
    const p = projects.find(x => x.id === +req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    db.remove('projects', { id: p.id });
    db.remove('tasks', { project_id: p.id });
    res.json({ ok: true, soft_deleted: true });
  });

  router.get('/:id/tasks', (req, res) => {
    const agents = db.loadAgents();
    let tasks = db.loadTasks().filter(t => t.project_id === +req.params.id);
    if (req.query.status) tasks = tasks.filter(t => t.status === req.query.status);
    if (req.query.priority) tasks = tasks.filter(t => t.priority === req.query.priority);
    if (req.query.agent_id) tasks = tasks.filter(t => t.assigned_agent_id === +req.query.agent_id);
    if (req.query.search) { const s = req.query.search.toLowerCase(); tasks = tasks.filter(t => t.title.toLowerCase().includes(s)); }
    const allTasks = db.loadTasks();
    res.json(tasks.map(t => {
      const a = agents.find(x => x.id === t.assigned_agent_id);
      const cb = agents.find(x => x.id === t.created_by_agent_id);
      const dep = allTasks.find(d => d.id === t.dependency_id);
      return { ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id, created_by_agent_slug: cb?.openclaw_agent_id, dep_title: dep?.title || null };
    }));
  });

  router.post('/:id/tasks', (req, res) => {
    if (!db.loadProjects().find(p => p.id === +req.params.id)) return res.status(404).json({ error: 'project not found' });
    const { assigned_agent_id, title, description, status, dependency_id, dependency_ids, creates_agent, created_by_agent_id, priority, repeat } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    if (title.length > 500) return res.status(400).json({ error: 'title too long (max 500 chars)' });
    if (priority && !['low', 'medium', 'high'].includes(priority)) return res.status(400).json({ error: 'priority must be low, medium, or high' });
    const toNum = (v) => (v === '' || v === null || v === undefined) ? null : +v || null;
    const toNumArr = (v) => {
      if (!v) return null;
      if (Array.isArray(v)) return v.map(x => +x).filter(x => x);
      if (typeof v === 'string') return JSON.parse(v);
      return null;
    };
    const assignId = toNum(assigned_agent_id);
    if (assignId) {
      const allAgents = db.loadAgents();
      if (!allAgents.find(a => a.id === assignId)) return res.status(400).json({ error: `agent #${assignId} not found` });
    }
    const depId = toNum(dependency_id);
    const depIds = toNumArr(dependency_ids);
    if (depId) {
      const allTasks = db.loadTasks();
      const dep = allTasks.find(t => t.id === depId);
      if (!dep) return res.status(400).json({ error: `dependency task #${depId} not found` });
      if (dep.project_id !== +req.params.id) return res.status(400).json({ error: `dependency task #${depId} belongs to a different project` });
    }
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
      dependency_id: depId,
      dependency_ids: depIds ? JSON.stringify(depIds) : null,
      creates_agent: creates_agent || null,
      created_by_agent_id: toNum(created_by_agent_id),
      priority: priority || 'medium',
      created_at: new Date().toISOString(),
      completed_at: null
    };
    tasks.push(t);
    db.saveTasks(tasks);
    const agents = db.loadAgents();
    const a = agents.find(x => x.id === t.assigned_agent_id);
    res.status(201).json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id });
  });

  router.post('/:id/tasks/from-agent', (req, res) => {
    if (!db.loadProjects().find(p => p.id === +req.params.id)) return res.status(404).json({ error: 'project not found' });
    const { agent_id, title, description, assigned_to_agent_id, priority, dependency_id } = req.body;
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
    const depId = dependency_id ? +dependency_id : null;
    if (depId) {
      const dep = tasks.find(t => t.id === depId);
      if (!dep) return res.status(400).json({ error: `dependency task #${depId} not found` });
      if (dep.project_id !== +req.params.id) return res.status(400).json({ error: `dependency task #${depId} belongs to a different project` });
    }
    const t = {
      id: nextId('tasks'), project_id: +req.params.id,
      assigned_agent_id: assignedId,
      title, description: description || '',
      status: 'pending', dependency_id: depId,
      creates_agent: null,
      created_by_agent_id: creatorAgent.id,
      priority: priority || 'medium',
      created_at: new Date().toISOString(), completed_at: null
    };
    tasks.push(t);
    db.saveTasks(tasks);
    const a = agents.find(x => x.id === t.assigned_agent_id);
    res.status(201).json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id, created_by: creatorAgent.name });
  });
};