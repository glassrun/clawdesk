module.exports = function(router, { db, broadcastSSE, heartbeatStats, heartbeatRunning }) {

  // Heartbeats
  router.get('/', (req, res) => {
    const agents = db.loadAgents();
    let all = db.loadHeartbeats().sort((a, b) => b.id - a.id);
    if (req.query.status) all = all.filter(h => h.status === req.query.status);
    if (req.query.agent_id) all = all.filter(h => String(h.agent_id) === String(req.query.agent_id));
    const page = Math.max(1, +(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, +(req.query.limit) || 50));
    const total = all.length;
    const offset = (page - 1) * limit;
    const hbs = all.slice(offset, offset + limit);
    res.json({ data: hbs.map(h => { const a = agents.find(x => x.id === h.agent_id); return { ...h, agent_name: a?.name, openclaw_agent_id: a?.openclaw_agent_id }; }), total, page, limit, pages: Math.ceil(total / limit) });
  });

  router.post('/tick', async (req, res) => {
    const { runHeartbeatCycle } = require('../services/heartbeat');
    try { const r = await runHeartbeatCycle(); res.json({ ticked: r.length, results: r }); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // System stats
  router.get('/stats', (req, res) => {
    const stats = db.getDbStats();
    stats.uptime_seconds = Math.round(process.uptime());
    stats.node_version = process.version;
    stats.timestamp = new Date().toISOString();
    res.json(stats);
  });

  // Cleanup
  router.post('/cleanup', (req, res) => {
    const tasks = db.loadTasks();
    let clearedDates = 0;
    for (const t of tasks) {
      if (t.status !== 'done' && t.completed_at) { t.completed_at = null; clearedDates++; }
    }
    if (clearedDates > 0) db.saveTasks(tasks);
    const dt = db.clearDeleted('tasks');
    const dp = db.clearDeleted('projects');
    res.json({ ok: true, stale_completed_at_cleared: clearedDates, hard_deleted_tasks: dt, hard_deleted_projects: dp });
  });

  // Vacuum
  router.post('/vacuum', (req, res) => {
    db.vacuumDb();
    res.json({ ok: true });
  });

  // Health checks
  router.get('/health', (req, res) => {
    const agents = db.loadAgents();
    const tasks = db.loadTasks();
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      agents: agents.length,
      active_tasks: tasks.filter(t => ['pending', 'in_progress'].includes(t.status)).length,
      failed_tasks: tasks.filter(t => t.status === 'failed').length,
      heartbeat: {
        cycles: heartbeatStats.cycles,
        avgMs: heartbeatStats.cycles > 0 ? Math.round(heartbeatStats.totalMs / heartbeatStats.cycles) : 0,
        lastMs: heartbeatStats.lastCycleMs,
        recentAvgMs: heartbeatStats.last10Ms.length > 0 ? Math.round(heartStats.last10Ms.reduce((a,b) => a+b, 0) / heartbeatStats.last10Ms.length) : 0,
        agentsProcessed: heartbeatStats.agentsProcessed,
        errors: heartbeatStats.errors,
        running: heartbeatRunning
      },
      timestamp: new Date().toISOString()
    });
  });

  // Dashboard
  router.get('/dashboard', (req, res) => {
    const agents = db.loadAgents();
    const tasks = db.loadTasks();
    const projects = db.loadProjects();
    const hbs = db.loadHeartbeats();
    const recentHbs = hbs.sort((a, b) => b.id - a.id).slice(0, 10);
    res.json({
      total_agents: agents.length,
      active_tasks: tasks.filter(t => ['pending', 'in_progress'].includes(t.status)).length,
      completed_tasks: tasks.filter(t => t.status === 'done').length,
      failed_tasks: tasks.filter(t => t.status === 'failed').length,
      total_spent: agents.reduce((s, a) => s + (a.budget_spent || 0), 0),
      agents: agents.map(a => {
        const at = tasks.filter(t => t.assigned_agent_id === a.id);
        return {
          ...a,
          tasks_pending: at.filter(t => t.status === 'pending').length,
          tasks_in_progress: at.filter(t => t.status === 'in_progress').length,
          tasks_done: at.filter(t => t.status === 'done').length,
          tasks_failed: at.filter(t => t.status === 'failed').length,
          tasks_total: at.length
        };
      }),
      projects: projects.map(p => {
        const pt = tasks.filter(t => t.project_id === p.id);
        const done = pt.filter(t => t.status === 'done').length;
        return { ...p, task_total: pt.length, task_done: done, completion_pct: pt.length > 0 ? Math.round(done / pt.length * 100) : 0 };
      }),
      recent_heartbeats: recentHbs.map(h => {
        const a = agents.find(x => x.id === h.agent_id);
        let action; try { action = JSON.parse(h.action_taken); } catch { action = {}; }
        return { id: h.id, triggered_at: h.triggered_at, status: h.status, agent_name: a?.name || 'System', action_summary: action.action || 'unknown' };
      })
    });
  });
};