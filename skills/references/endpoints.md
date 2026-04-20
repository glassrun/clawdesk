# ClawDesk API Endpoints

## Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Server health check |
| GET | /health/ready | Readiness check |

## Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/agents | List all agents (?status, ?search) |
| POST | /api/agents | Create agent |
| GET | /api/agents/:id | Get agent by ID |
| PUT | /api/agents/:id | Update agent |
| DELETE | /api/agents/:id | Delete agent |
| GET | /api/agents/:id/stats | Get agent workload stats |
| GET | /api/agents/:id/tasks | Get agent's tasks |
| POST | /api/agents/:id/heartbeat | Trigger heartbeat |
| POST | /api/agents/:id/reactivate | Reactivate agent |
| POST | /api/agents/sync | Sync from OpenClaw |

## Projects

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/projects | List all projects |
| POST | /api/projects | Create project |
| GET | /api/projects/:id | Get project with tasks |
| PUT | /api/projects/:id | Update project |
| DELETE | /api/projects/:id | Delete project |
| GET | /api/projects/:id/stats | Get project stats |
| GET | /api/projects/:id/tasks | List project tasks |
| POST | /api/projects/:id/tasks | Create task in project |
| POST | /api/projects/:id/tasks/from-agent | Create task from agent |
| POST | /api/projects/:id/reopen | Reopen project |

## Tasks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/tasks | List tasks (?status, ?priority, ?agent_id, ?project_id, ?search, ?page, ?limit) |
| GET | /api/tasks/summary | Task count summary |
| GET | /api/tasks/:id | Get task by ID |
| PUT | /api/tasks/:id | Update task |
| DELETE | /api/tasks/:id | Delete task |
| GET | /api/tasks/:id/results | Get task results |
| GET | /api/tasks/:id/history | Get task history |
| GET | /api/tasks/:id/chain | Get task dependency chain |
| GET | /api/tasks/:id/dependents | Get dependent tasks |
| POST | /api/tasks/:id/run | Run task on agent |
| POST | /api/tasks/:id/retry | Retry failed task |
| POST | /api/tasks/:id/cancel | Cancel in-progress task |
| POST | /api/tasks/:id/duplicate | Duplicate task |
| POST | /api/tasks/:id/assign | Assign to agent |
| POST | /api/tasks/:id/notes | Add notes |
| POST | /api/tasks/bulk | Bulk operations |

## Heartbeats

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/heartbeats | List heartbeats |
| POST | /api/heartbeats/tick | Trigger heartbeat cycle |

## System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/system/stats | System statistics |
| POST | /api/system/cleanup | Cleanup old data |

## Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/dashboard | Dashboard data |

## Request Examples

### Create project
```bash
curl -X POST http://localhost:3777/api/projects \
  -H "Content-Type: application/json" \
  -d '{"title":"My Project","description":"Description"}'
```

### Update task status
```bash
curl -X PUT http://localhost:3777/api/tasks/1776619252186 \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'
```

### Filter tasks by status
```bash
curl "http://localhost:3777/api/tasks?status=pending&priority=high"
```

### Get agent stats
```bash
curl http://localhost:3777/api/agents/main/stats
```

## Response Formats

### Task object
```json
{
  "id": 1776619252186,
  "title": "Task name",
  "description": "",
  "status": "pending",
  "priority": "high",
  "assigned_agent_id": "main",
  "project_id": 1776619182108,
  "created_at": "2026-04-20T12:00:00Z"
}
```

### Agent object
```json
{
  "id": "main",
  "openclaw_agent_id": "main",
  "name": "Zava",
  "status": "active",
  "heartbeat_enabled": 1,
  "heartbeat_interval": 1,
  "last_heartbeat": "2026-04-20T18:00:00Z"
}
```

### Project object
```json
{
  "id": 1776619182108,
  "title": "My Project",
  "status": "active",
  "task_total": 5,
  "task_done": 2,
  "completion_pct": 40
}
```