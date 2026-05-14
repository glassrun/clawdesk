const fs = require('fs');
let content = fs.readFileSync('./services/executor.js', 'utf8');

const old = `  message += \`\\n--- TOOLS ---\`;
  message += \`\\nYou can create new tasks for this project via HTTP POST:\`;
  message += \`\\nURL: \${BASE_URL}/api/projects/\${task.project_id}/tasks/from-agent\`;
  message += \`\\nBody (JSON): { agent_id: \"\${agent.openclaw_agent_id}\", title: \"task title\", description: \"details\", assigned_to_agent_id: \"target-agent\", priority: \"medium\", dependency_ids: [task_id_1, task_id_2], status: \"pending\", scheduled_at: null, repeat: false, requires_approval: false }\`;
  message += \`\\nValid agent IDs: \${db.loadAgents().map(a => a.openclaw_agent_id).join(', ')}\`;
  message += \`\\nIMPORTANT: assigned_to_agent_id is REQUIRED. Pick the agent who should do the work.\`;
  message += \`\\ndependency_ids is optional — pass IDs of tasks that must complete before this new task runs (blocks execution until all deps are done).\`;
  message += \`\\nOptional fields: status (default \"pending\"), scheduled_at (ISO datetime, null = run ASAP), repeat (true/false, auto-reschedule after done), requires_approval (true/false, pauses for human approval before running).\`;
  message += \`\\nTo create MULTIPLE tasks, make MULTIPLE calls - one endpoint call per task.\`;
  message += \`\\nResponse: on success returns {id, title, status, ...}. Use the returned id to chain dependencies into subsequent tasks. Errors return { error: \"message\" } — if creation fails, log the error and do not assume the task was created. Use Content-Type: application/json header.\`;
  message += \`\\n\`;
  message += \`\\nYou can create new agents for this project via HTTP POST:\`;
  message += \`\\nURL: \${BASE_URL}/api/agents\`;
  message += \`\\nBody (JSON): { job_title: \"Senior Security Engineer\", job_description: \"Penetration testing, audits...\" }\`;
  message += \`\\nThis creates the agent, its workspace, identity files, and registers it with OpenClaw.\`;
  message += \`\\nAfter creating an agent, you can assign tasks to it using the task creation endpoint above.\`;`;

const replacement = `  message += \`\\n--- TOOLS ---\`;
  message += \`\\nYou can create new tasks for this project via HTTP POST:\`;
  message += \`\\nURL: \${BASE_URL}/api/projects/\${task.project_id}/tasks/from-agent\`;
  message += \`\\nBody (JSON): { agent_id: \"\${agent.openclaw_agent_id}\", title: \"task title\", description: \"details\", assigned_to_agent_id: \"target-agent\", priority: \"medium\", dependency_ids: [task_id_1, task_id_2], status: \"pending\", scheduled_at: null, repeat: false, requires_approval: false }\`;
  message += \`\\nValid agent IDs: \${db.loadAgents().map(a => a.openclaw_agent_id).join(', ')}\`;
  message += \`\\nIMPORTANT: assigned_to_agent_id value must EXACTLY match one of the listed agent IDs (no nicknames or aliases). Use GET \${BASE_URL}/api/projects/\${task.project_id}/tasks to discover IDs before creating dependency chains.\`;
  message += \`\\nTitle is required and max 500 chars. description is optional but recommended.\`;
  message += \`\\ndependency_ids is optional — pass IDs of tasks that must complete before this new task runs (blocks execution until all deps are done). Call GET on the project task board first to get IDs.\`;
  message += \`\\nOptional fields: status (default \"pending\"), scheduled_at (ISO datetime, null = run ASAP), repeat (true/false, auto-reschedule after done), requires_approval (true/false, pauses for human approval before running).\`;
  message += \`\\nTo create MULTIPLE tasks, make MULTIPLE calls - one endpoint call per task.\`;
  message += \`\\nResponse: on success returns {id, title, status, ...}. Use the returned id to chain dependencies into subsequent tasks. Errors return { error: \"message\" } — if creation fails, log the error and do not assume the task was created. Use Content-Type: application/json header.\`;
  message += \`\\nAfter creation, tasks enter a pending queue and are picked up asynchronously by the heartbeat engine — do not expect immediate execution.\`;
  message += \`\\n\`;
  message += \`\\nYou can create new agents for this project via HTTP POST:\`;
  message += \`\\nURL: \${BASE_URL}/api/agents\`;
  message += \`\\nBody (JSON): { job_title: \"Senior Security Engineer\", job_description: \"Penetration testing, audits...\" }\`;
  message += \`\\nThis creates the agent, its workspace, identity files, and registers it with OpenClaw.\`;
  message += \`\\nAfter creating an agent, you can assign tasks to it using the task creation endpoint above.\`;`;

if (!content.includes(old)) { console.log('NOT FOUND'); process.exit(1); }
content = content.replace(old, replacement);
fs.writeFileSync('./services/executor.js', content);
console.log('Done');