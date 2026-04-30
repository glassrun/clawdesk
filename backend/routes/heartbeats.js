module.exports = function(router, { db, runHeartbeatCycle }) {

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
    try { const r = await runHeartbeatCycle(); res.json({ ticked: r.length, results: r }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
};