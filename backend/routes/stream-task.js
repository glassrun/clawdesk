module.exports = function(router, { taskSseClients }) {
  // GET /api/stream/task/:id — SSE stream for a specific task's output
  router.get('/:id', (req, res) => {
    const taskId = +req.params.id;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send immediate connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ task_id: taskId, ts: Date.now() })}\n\n`);

    // Register this response in the task-specific set
    if (!taskSseClients.has(taskId)) {
      taskSseClients.set(taskId, new Set());
    }
    taskSseClients.get(taskId).add(res);

    req.on('close', () => {
      const clients = taskSseClients.get(taskId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) taskSseClients.delete(taskId);
      }
    });
  });
};