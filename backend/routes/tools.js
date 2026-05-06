const express = require('express');
const { getAllTools, getTool, updateTool } = require('../services/tool-registry');

module.exports = function(router, ctx) {
  // GET /api/tools — list all tools
  router.get('/', (req, res) => {
    res.json(getAllTools());
  });

  // GET /api/tools/:name — get a specific tool
  router.get('/:name', (req, res) => {
    const tool = getTool(req.params.name);
    if (!tool) return res.status(404).json({ error: 'tool not found' });
    res.json(tool);
  });

  // PATCH /api/tools/:name — update tool metadata (enable/disable, rate limits)
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
};
