function normalizeTask(t, agents) {
  const a = agents?.find(x => x.id === t.assigned_agent_id);
  return { ...t, priority: t.priority || 'medium', agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id };
}

module.exports = function(router, { db, broadcastSSE, setTaskStatus, nextId }) {

  // Task summary - lightweight aggregate counts
  router.get('/summary', (req, res) => {
    let tasks = db.loadTasks();
    if (req.query.project_id) tasks = tasks.filter(t => String(t.project_id) === String(req.query.project_id));
    if (req.query.agent_id) tasks = tasks.filter(t => String(t.assigned_agent_id) === String(req.query.agent_id));
    const byStatus = {}; const byPriority = {}; const byProject = {}; const byAgent = {};
    let totalRetries = 0;
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      byPriority[t.priority || 'medium'] = (byPriority[t.priority || 'medium'] || 0) + 1;
      byProject[t.project_id] = (byProject[t.project_id] || 0) + 1;
      if (t.assigned_agent_id) byAgent[t.assigned_agent_id] = (byAgent[t.assigned_agent_id] || 0) + 1;
      if (t._retry_count) totalRetries += t._retry_count;
    }
    res.json({ total: tasks.length, by_status: byStatus, by_priority: byPriority, by_project: byProject, by_agent: byAgent, total_retries: totalRetries });
  });

  // Bulk task update
  router.post('/bulk', (req, res) => {
    const { task_ids, status, priority, assigned_agent_id } = req.body;
    if (!Array.isArray(task_ids) || task_ids.length === 0) return res.status(400).json({ error: 'task_ids must be a non-empty array' });
    if (task_ids.length > 100) return res.status(400).json({ error: 'max 100 tasks per bulk update' });
    if (priority && !['low', 'medium', 'high'].includes(priority)) return res.status(400).json({ error: 'priority must be low, medium, or high' });
    if (assigned_agent_id !== undefined && assigned_agent_id) {
      const allAgents = db.loadAgents();
      if (!allAgents.find(a => a.id === +assigned_agent_id)) return res.status(400).json({ error: `agent #${assigned_agent_id} not found` });
    }
    const tasks = db.loadTasks();
    const updated = [];
    const affectedProjects = new Set();
    for (const tid of task_ids) {
      const t = tasks.find(x => x.id === +tid);
      if (!t) continue;
      const oldStatus = t.status;
      if (status) { t.status = status; if (status !== oldStatus) t._status_changed_at = new Date().toISOString(); if (status === 'done') { if (!t.completed_at) t.completed_at = new Date().toISOString(); affectedProjects.add(t.project_id); } }
      if (priority) t.priority = priority;
      if (assigned_agent_id !== undefined) t.assigned_agent_id = assigned_agent_id ? +assigned_agent_id : null;
      updated.push(t.id);
    }
    db.saveTasks(tasks);
    if (status === 'done') {
      const projects = db.loadProjects();
      let changed = false;
      for (const pid of affectedProjects) {
        const projectTasks = tasks.filter(x => x.project_id === pid);
        if (projectTasks.length > 0 && projectTasks.every(x => x.status === 'done')) {
          const p = projects.find(x => x.id === pid);
          if (p && p.status === 'active') { p.status = 'completed'; changed = true; console.log(`[Auto] Project "${p.title}" marked completed - all tasks done`); }
        }
      }
      if (changed) db.saveProjects(projects);
    }
    res.json({ ok: true, updated: updated.length, task_ids: updated });
  });

  // Batch task creation
  router.post('/batch', (req, res) => {
    const { tasks } = req.body;
    if (!Array.isArray(tasks) || tasks.length === 0) return res.status(400).json({ error: 'tasks must be a non-empty array' });
    if (tasks.length > 200) return res.status(400).json({ error: 'max 200 tasks per batch' });
    const ids = db.insertTaskBatch(tasks);
    broadcastTaskUpdate(db.loadTasks());
    res.json({ ok: true, count: ids.length, ids });
  });

  // Dashboard task listing
  router.get('/', (req, res) => {
    const agents = db.loadAgents();
    let tasks = db.loadTasks();
    if (req.query.status) tasks = tasks.filter(t => t.status === req.query.status);
    if (req.query.agent_id) tasks = tasks.filter(t => String(t.assigned_agent_id) === String(req.query.agent_id));
    if (req.query.priority) tasks = tasks.filter(t => t.priority === req.query.priority);
    if (req.query.project_id) tasks = tasks.filter(t => String(t.project_id) === String(req.query.project_id));
    if (req.query.search) { const s = req.query.search.toLowerCase(); tasks = tasks.filter(t => t.title.toLowerCase().includes(s)); }
    const sortBy = req.query.sort_by || 'priority';
    const sortDir = req.query.sort_dir === 'desc' ? -1 : 1;
    const pri = { high: 0, medium: 1, low: 2 };
    const sortFns = {
      priority: (a, b) => ((pri[a.priority] ?? 1) - (pri[b.priority] ?? 1)) * sortDir,
      created_at: (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) * sortDir,
      title: (a, b) => a.title.localeCompare(b.title) * sortDir,
      status: (a, b) => a.status.localeCompare(b.status) * sortDir,
      id: (a, b) => (a.id - b.id) * sortDir
    };
    tasks.sort(sortFns[sortBy] || sortFns.priority);
    const page = Math.max(1, +(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, +(req.query.limit) || 50));
    const total = tasks.length;
    const offset = (page - 1) * limit;
    const paged = tasks.slice(offset, offset + limit);
    res.json({ data: paged.map(t => normalizeTask(t, agents)), total, page, limit, pages: Math.ceil(total / limit) });
  });

  // Task by ID
  router.get('/:id', (req, res) => {
    const t = db.loadTasks().find(x => x.id === +req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const agents = db.loadAgents();
    const resp = normalizeTask(t, agents);
    if (t.status === 'in_progress' && t._status_changed_at) {
      resp.in_progress_seconds = Math.round((Date.now() - new Date(t._status_changed_at)) / 1000);
    }
    res.json(resp);
  });

  router.put('/:id', (req, res) => {
    const tasks = db.loadTasks();
    const taskId = +req.params.id;
    const t = tasks.find(x => x.id === taskId);
    if (!t) return res.status(404).json({ error: 'not found' });
    const { assigned_agent_id, title, description, status, dependency_id, creates_agent, created_by_agent_id, priority, repeat } = req.body;
    const resolveAgent = (v) => (v === '' || v === null || v === undefined) ? null : (typeof v === 'string' ? v : +v || null);
    const resolveDep = (v) => (v === '' || v === null || v === undefined) ? null : +v || null;
    if (priority && !['low', 'medium', 'high'].includes(priority)) return res.status(400).json({ error: 'priority must be low, medium, or high' });
    const newDepId = dependency_id !== undefined ? resolveDep(dependency_id) : t.dependency_id;
    if (newDepId && newDepId !== t.dependency_id) {
      const allTasks = db.loadTasks();
      const dep = allTasks.find(d => d.id === newDepId);
      if (!dep) return res.status(400).json({ error: `dependency task #${newDepId} not found` });
      if (dep.project_id !== t.project_id) return res.status(400).json({ error: `dependency task #${newDepId} belongs to a different project` });
      const visited = new Set();
      let current = newDepId;
      while (current && !visited.has(current)) {
        if (current === t.id) return res.status(400).json({ error: 'circular dependency detected' });
        visited.add(current);
        const parent = allTasks.find(d => d.id === current);
        current = parent?.dependency_id;
      }
    }
    const oldStatus = t.status;
    Object.assign(t, { assigned_agent_id: assigned_agent_id !== undefined ? resolveAgent(assigned_agent_id) : t.assigned_agent_id, title: title ?? t.title, description: description ?? t.description, status: status ?? t.status, dependency_id: dependency_id !== undefined ? resolveDep(dependency_id) : t.dependency_id, creates_agent: creates_agent !== undefined ? creates_agent : t.creates_agent, created_by_agent_id: created_by_agent_id !== undefined ? created_by_agent_id : t.created_by_agent_id, priority: priority ?? t.priority, repeat: repeat !== undefined ? repeat : t.repeat });
    if (status && status !== oldStatus) {
      t._status_changed_at = new Date().toISOString();
      if (status === 'done') { if (!t.completed_at) t.completed_at = new Date().toISOString(); }
      else if (oldStatus === 'done') { t.completed_at = null; }
      if (status === 'done') {
        const projectTasks = tasks.filter(x => x.project_id === t.project_id);
        if (projectTasks.length > 0 && projectTasks.every(x => x.status === 'done')) {
          const projects = db.loadProjects();
          const p = projects.find(x => x.id === t.project_id);
          if (p && p.status === 'active') { p.status = 'completed'; db.saveProjects(projects); console.log(`[Auto] Project "${p.title}" marked completed - all tasks done`); }
        }
      }
      if (oldStatus === 'done' && status !== 'done') {
        const projects = db.loadProjects();
        const p = projects.find(x => x.id === t.project_id);
        if (p && p.status === 'completed') { p.status = 'active'; db.saveProjects(projects); console.log(`[Auto] Project "${p.title}" reopened - task #${t.id} un-completed`); }
      }
    }
    db.saveTasks(tasks);
    const a = db.loadAgents().find(x => x.id === t.assigned_agent_id);
    res.json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id });
  });

  router.delete('/:id', (req, res) => {
    const tasks = db.loadTasks();
    const t = tasks.find(x => x.id === +req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    let cleared = 0;
    for (const task of tasks) {
      if (task.dependency_id === t.id) { task.dependency_id = null; cleared++; }
    }
    if (cleared > 0) db.saveTasks(tasks);
    db.remove('tasks', { id: t.id });
    broadcastTaskUpdate(db.loadTasks());
    res.json({ ok: true, soft_deleted: true, dependency_references_cleared: cleared });
  });

  router.get('/:id/results', (req, res) => { res.json(db.loadTaskResults().filter(r => r.task_id === +req.params.id).sort((a, b) => b.id - a.id)); });

  router.get('/:id/history', (req, res) => {
    const allTasks = db.loadTasks();
    const task = allTasks.find(x => x.id === +req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    const agents = db.loadAgents();
    const results = db.loadTaskResults().filter(r => r.task_id === task.id).sort((a, b) => b.id - a.id);
    const hbs = db.loadHeartbeats().filter(h => {
      try { const a = JSON.parse(h.action_taken); return a.task_id === task.id || (a.title && a.title === task.title); } catch { return false; }
    }).sort((a, b) => b.id - a.id);
    const chain = [];
    let current = task.dependency_id;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      const dep = allTasks.find(t => t.id === current);
      if (!dep) { chain.push({ id: current, title: '[deleted]' }); break; }
      chain.push({ id: dep.id, title: dep.title, status: dep.status });
      current = dep.dependency_id;
    }
    const dependents = allTasks.filter(t => t.dependency_id === task.id).map(t => ({ id: t.id, title: t.title, status: t.status }));
    res.json({
      task: { id: task.id, title: task.title, status: task.status, priority: task.priority, assigned_agent_id: task.assigned_agent_id, created_at: task.created_at, completed_at: task.completed_at, retry_count: task._retry_count || 0 },
      executions: results.filter(r => r.type !== 'note').map(r => ({ id: r.id, status: r.output?.startsWith('Error:') ? 'failed' : 'completed', duration_ms: r.duration_ms, executed_at: r.executed_at, output_preview: (r.output || '').substring(0, 200) })),
      notes: results.filter(r => r.type === 'note').map(r => ({ id: r.id, note: r.output, agent_id: r.agent_id, created_at: r.executed_at })),
      heartbeat_entries: hbs.map(h => { const a = agents.find(x => x.id === h.agent_id); return { id: h.id, triggered_at: h.triggered_at, status: h.status, agent_name: a?.name, action: (() => { try { return JSON.parse(h.action_taken); } catch { return { raw: h.action_taken }; } })() }; }),
      dependency_chain: chain,
      dependents,
      total_executions: results.filter(r => r.type !== 'note').length,
      total_notes: results.filter(r => r.type === 'note').length,
      total_heartbeat_entries: hbs.length
    });
  });

  router.get('/:id/chain', (req, res) => {
    const tasks = db.loadTasks();
    const task = tasks.find(x => x.id === +req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    const chain = [];
    const visited = new Set();
    let current = task.dependency_id;
    while (current && !visited.has(current)) {
      visited.add(current);
      const dep = tasks.find(t => t.id === current);
      if (!dep) { chain.push({ id: current, title: '[deleted]', status: 'missing' }); break; }
      chain.push({ id: dep.id, title: dep.title, status: dep.status, priority: dep.priority });
      current = dep.dependency_id;
    }
    res.json({ task_id: task.id, title: task.title, status: task.status, chain_length: chain.length, chain, blocked: chain.some(c => c.status !== 'done') });
  });

  router.get('/:id/dependents', (req, res) => {
    const task = db.loadTasks().find(x => x.id === +req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    const agents = db.loadAgents();
    const dependents = db.loadTasks().filter(t => t.dependency_id === task.id).map(t => {
      const a = agents.find(x => x.id === t.assigned_agent_id);
      return { id: t.id, title: t.title, status: t.status, priority: t.priority, agent_name: a?.name };
    });
    res.json({ task_id: task.id, task_title: task.title, blocked_by_this: dependents, count: dependents.length });
  });

  router.post('/:id/duplicate', (req, res) => {
    const tasks = db.loadTasks();
    const orig = tasks.find(x => x.id === +req.params.id);
    if (!orig) return res.status(404).json({ error: 'not found' });
    if (orig.assigned_agent_id) {
      const agents = db.loadAgents();
      if (!agents.find(a => a.id === orig.assigned_agent_id)) return res.status(400).json({ error: 'assigned agent no longer exists - reassign before duplicating' });
    }
    const t = {
      id: nextId('tasks'), project_id: orig.project_id,
      assigned_agent_id: orig.assigned_agent_id,
      title: req.body.title || (orig.title + ' (copy)'),
      description: orig.description, status: 'pending',
      dependency_id: orig.dependency_id,
      creates_agent: orig.creates_agent,
      created_by_agent_id: orig.created_by_agent_id,
      priority: orig.priority,
      created_at: new Date().toISOString(), completed_at: null
    };
    tasks.push(t);
    db.saveTasks(tasks);
    const a = db.loadAgents().find(x => x.id === t.assigned_agent_id);
    res.status(201).json({ ...t, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id });
  });

  router.post('/:id/run', async (req, res) => {
    const { executeTask } = require('../services/executor');
    const task = db.loadTasks().find(x => x.id === +req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (!task.assigned_agent_id) return res.status(400).json({ error: 'no assigned agent' });
    const agent = db.loadAgents().find(x => x.id === task.assigned_agent_id);
    if (!agent) return res.status(400).json({ error: 'agent not found' });
    setTaskStatus(task.id, 'in_progress');
    try { res.json(await executeTask(agent, task)); } catch (e) {
      console.log("[TASK ERROR]", e);
      setTaskStatus(task.id, 'pending');
      const hbs = db.loadHeartbeats();
      hbs.push({ id: nextId('heartbeats'), agent_id: agent.id, triggered_at: new Date().toISOString(), action_taken: JSON.stringify({ action: 'run_error', task_id: task.id, task_title: task.title, error: e.message }), status: 'error' });
      db.saveHeartbeats(hbs);
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/:id/retry', async (req, res) => {
    const { executeTask } = require('../services/executor');
    const tasks = db.loadTasks();
    const task = tasks.find(x => x.id === +req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.status !== 'failed') return res.status(400).json({ error: `task status is "${task.status}", can only retry failed tasks` });
    if (!task.assigned_agent_id) return res.status(400).json({ error: 'no assigned agent' });
    const agent = db.loadAgents().find(x => x.id === task.assigned_agent_id);
    if (!agent) return res.status(400).json({ error: 'agent not found' });
    task._retry_count = (task._retry_count || 0) + 1;
    task.status = 'pending';
    delete task._status_changed_at;
    db.saveTasks(tasks);
    if (req.query.immediate === '1' || req.query.immediate === 'true') {
      setTaskStatus(task.id, 'in_progress');
      try { res.json({ retried: true, immediate: true, ...await executeTask(agent, task) }); } catch (e) {
        setTaskStatus(task.id, 'failed');
        res.json({ retried: true, immediate: true, action: 'failed', error: e.message, retry_count: task._retry_count });
      }
    } else {
      res.json({ retried: true, immediate: false, task_id: task.id, status: 'pending', retry_count: task._retry_count, message: 'Task reset to pending. Heartbeat engine will pick it up.' });
    }
  });

  router.post('/:id/cancel', (req, res) => {
    const tasks = db.loadTasks();
    const t = tasks.find(x => x.id === +req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    if (t.status !== 'in_progress') return res.status(400).json({ error: `task status is "${t.status}", can only cancel in_progress tasks` });
    t.status = 'pending';
    delete t._status_changed_at;
    db.saveTasks(tasks);
    const hbs = db.loadHeartbeats();
    hbs.push({ id: nextId('heartbeats'), agent_id: null, triggered_at: new Date().toISOString(), action_taken: JSON.stringify({ action: 'task_cancelled', task_id: t.id, title: t.title }), status: 'warning' });
    db.saveHeartbeats(hbs);
    res.json({ ok: true, task_id: t.id, title: t.title, status: 'pending' });
  });

  router.post('/:id/notes', (req, res) => {
    const { note, agent_id } = req.body;
    if (!note) return res.status(400).json({ error: 'note required' });
    const task = db.loadTasks().find(x => x.id === +req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    const results = db.loadTaskResults();
    results.push({ id: nextId('task_results'), task_id: task.id, agent_id: agent_id || null, input: '[note]', output: note, type: 'note', executed_at: new Date().toISOString() });
    db.saveTaskResults(results);
    res.json({ ok: true, task_id: task.id, note });
  });

  router.post('/:id/assign', (req, res) => {
    const { agent_id } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
    const tasks = db.loadTasks();
    const t = tasks.find(x => x.id === +req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const agents = db.loadAgents();
    const agent = agents.find(a => a.id === agent_id || a.openclaw_agent_id === agent_id);
    if (!agent) return res.status(400).json({ error: 'agent not found' });
    const oldAgentId = t.assigned_agent_id;
    t.assigned_agent_id = agent.id;
    db.saveTasks(tasks);
    res.json({ ok: true, task_id: t.id, title: t.title, old_agent_id: oldAgentId, new_agent_id: agent.id, new_agent_name: agent.name });
  });
};