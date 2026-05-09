module.exports = function(router, { db }) {

  // List approvals
  router.get('/', (req, res) => {
    let approvals = db.loadApprovals();
    if (req.query.task_id) approvals = approvals.filter(a => String(a.task_id) === String(req.query.task_id));
    if (req.query.status) approvals = approvals.filter(a => a.status === req.query.status);
    approvals.sort((a, b) => b.id - a.id);
    res.json({ approvals });
  });

  // Create an approval request
  router.post('/', (req, res) => {
    const { task_id, notes } = req.body;
    if (!task_id) return res.status(400).json({ error: 'task_id required' });
    const tasks = db.loadTasks();
    const task = tasks.find(t => t.id === +task_id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const id = db.insertApproval({
      id: null,
      task_id: +task_id,
      status: 'pending',
      requested_at: new Date().toISOString(),
      resolved_at: null,
      resolved_by: null,
      notes: notes || '',
    });
    res.status(201).json({ approval: { id, task_id: +task_id, status: 'pending', requested_at: new Date().toISOString() } });
  });

  // Get approval by ID
  router.get('/:id', (req, res) => {
    const approvals = db.loadApprovals();
    const a = approvals.find(x => x.id === +req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    res.json({ approval: a });
  });

  // Approve or reject
  router.put('/:id', (req, res) => {
    const { status, notes, resolved_by } = req.body;
    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved or rejected' });
    }
    const approvals = db.loadApprovals();
    const a = approvals.find(x => x.id === +req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    if (a.status !== 'pending') return res.status(400).json({ error: `approval already ${a.status}` });

    a.status = status;
    a.resolved_at = new Date().toISOString();
    a.resolved_by = resolved_by || null;
    if (notes) a.notes = notes;
    db.saveApprovals(approvals);

    if (status === 'approved') {
      // Re-trigger the task
      const tasks = db.loadTasks();
      const t = tasks.find(x => x.id === a.task_id);
      if (t) {
        t.status = 'pending';
        delete t._status_changed_at;
        db.saveTasks(tasks);
        console.log(`[Approval] Task #${t.id} approved — re-queued for execution`);
      }
    } else {
      // Mark task as failed
      const tasks = db.loadTasks();
      const t = tasks.find(x => x.id === a.task_id);
      if (t) {
        t.status = 'failed';
        t._status_changed_at = new Date().toISOString();
        db.saveTasks(tasks);
        console.log(`[Approval] Task #${t.id} rejected`);
      }
    }

    res.json({ approval: { ok: true, id: a.id, task_id: a.task_id, status: a.status, resolved_at: a.resolved_at } });
  });
};
