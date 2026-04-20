---
name: clawdesk-api
description: ClawDesk API integration for managing agents, projects, and tasks. Use when interacting with ClawDesk backend at http://localhost:3777 for (1) Listing/creating/updating/deleting agents, (2) Managing projects and tasks, (3) Running tasks on agents, (4) Syncing agents from OpenClaw, (5) Viewing system stats and dashboard.
---

# ClawDesk API Skill

Base URL: `http://localhost:3777`

## Quick Reference

| Resource | Endpoints |
|----------|----------|
| Health | `GET /health` |
| Agents | `GET/POST /api/agents`, `GET/PUT/DELETE /api/agents/:id` |
| Projects | `GET/POST /api/projects`, `GET/PUT/DELETE /api/projects/:id` |
| Tasks | `GET /api/tasks`, `GET/PUT/DELETE /api/tasks/:id` |
| Run | `POST /api/tasks/:id/run` |
| Assign | `POST /api/tasks/:id/assign` |

## Authentication

No authentication required for local development.

## Common Workflows

### List all agents
```bash
curl http://localhost:3777/api/agents
```

### Sync agents from OpenClaw
```bash
curl -X POST http://localhost:3777/api/agents/sync
```

### Create a task
```bash
curl -X POST http://localhost:3777/api/projects/:id/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Task name","priority":"high"}'
```

### Assign task to agent
```bash
curl -X PUT http://localhost:3777/api/tasks/:id \
  -H "Content-Type: application/json" \
  -d '{"assigned_agent_id":"main"}'
```

### Run task on agent
```bash
curl -X POST http://localhost:3777/api/tasks/:id/run
```

## Task Filters

Use query params: `?status`, `?priority`, `?agent_id`, `?project_id`, `?search`, `?page`, `?limit`

```bash
curl "http://localhost:3777/api/tasks?status=pending&priority=high"
```

## Notes

- Agent IDs are strings: `"main"`, `"project-manager"`, etc.
- Task IDs are numbers: `1776619252186`
- Project IDs are numbers: `1776619182108`

For detailed endpoint documentation, see [ENDPOINTS.md](references/endpoints.md).