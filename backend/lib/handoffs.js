const db = require('../db');
const { nextId } = db;

function parseTaskHandoffs(output, projectId) {
  const handoffs = [];
  if (!output || typeof output !== 'string') return handoffs;

  const jsonBlocks = output.match(/\{[^{}]*\}/g) || [];

  for (const block of jsonBlocks) {
    try {
      const parsed = JSON.parse(block);

      if (parsed.handoff && parsed.handoff.title && parsed.handoff.assigned_to_agent_id) {
        const agents = db.loadAgents();
        const targetAgent = agents.find(a => a.openclaw_agent_id === parsed.handoff.assigned_to_agent_id || a.id === +parsed.handoff.assigned_to_agent_id);
        if (targetAgent) {
          const tasks = db.loadTasks();
          const newTask = {
            id: nextId('tasks'),
            project_id: projectId,
            assigned_agent_id: targetAgent.id,
            title: parsed.handoff.title,
            description: parsed.handoff.description || '',
            status: 'pending',
            priority: parsed.handoff.priority || 'medium',
            created_by_agent_id: null,
            created_at: new Date().toISOString()
          };
          tasks.push(newTask);
          db.saveTasks(tasks);
          handoffs.push({ ...newTask, assigned_agent_name: targetAgent.name, from_handoff: true });
        }
      }

      if (parsed.create_task_for && parsed.title) {
        const agents = db.loadAgents();
        const targetAgent = agents.find(a => a.openclaw_agent_id === parsed.create_task_for || a.id === +parsed.create_task_for);
        if (targetAgent) {
          const tasks = db.loadTasks();
          const newTask = {
            id: nextId('tasks'),
            project_id: projectId,
            assigned_agent_id: targetAgent.id,
            title: parsed.title,
            description: parsed.description || '',
            status: 'pending',
            priority: parsed.priority || 'medium',
            created_by_agent_id: null,
            created_at: new Date().toISOString()
          };
          tasks.push(newTask);
          db.saveTasks(tasks);
          handoffs.push({ ...newTask, assigned_agent_name: targetAgent.name, from_create_task_for: true });
        }
      }
    } catch { /* ignore parse errors */ }
  }

  return handoffs;
}

module.exports = { parseTaskHandoffs };