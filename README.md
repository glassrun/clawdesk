# ClawDesk — AI Agent Orchestration Platform

![ClawDesk](docs/lobsters_working_desk.png)

Manage your OpenClaw agent teams from a single dashboard. Define projects, assign tasks, track progress, and let agents work autonomously on heartbeats.

## Quick Start

```bash
cd clawdesk
npm install
npm start
# → http://localhost:3777
```

Requires [OpenClaw](https://docs.openclaw.ai) installed with the gateway running (`openclaw gateway start`).

## What It Does

ClawDesk is the orchestration layer on top of OpenClaw. It doesn't replace OpenClaw — it coordinates it.

- **Projects** organize work into logical groups with workspace paths
- **Tasks** are individual units of work assigned to OpenClaw agents
- **Heartbeats** dispatch pending tasks to agents automatically every 60 seconds
- **Dependencies** ensure tasks execute in the right order (with circular dependency detection)
- **Agent coordination** — agents can create new tasks and delegate to other agents

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  ClawDesk   │────▶│ openclaw agent│────▶│  OpenClaw Agent  │
│  (control)  │     │   (CLI)      │     │  (execution)     │
└──────┬──────┘     └──────────────┘     └─────────────────┘
       │                                         │
       ▼                                         ▼
  data/*.yaml                            workspace/*.md
  (state)                                (deliverables)
```

1. ClawDesk tracks what needs to be done (projects, tasks, agents)
2. Heartbeat engine picks up pending tasks and dispatches via `openclaw agent`
3. Agents execute tasks in the project workspace, creating real files
4. Results are captured and stored in YAML

## Features

### Agent Management
- Sync agents from OpenClaw (import + mark inactive on deletion)
- Create new agents from the dashboard (creates OpenClaw agent + workspace)
- Reactivate synced-offline agents
- Configure heartbeat intervals per agent (1-1440 minutes)
- Budget tracking per agent
- Per-agent stats: task counts, projects, heartbeat history

### Project & Task Management
- Projects with optional workspace paths — agents `cd` into the project workspace before executing
- Full task lifecycle: create → assign → run → retry → cancel → duplicate → delete
- Task priorities (high/medium/low) — heartbeat picks high-priority first
- Task dependencies with circular dependency detection
- Projects auto-complete when all tasks done; auto-reopen when tasks are un-done
- Agent-created tasks show creator slug (e.g. "✎ by orion")
- Bulk operations: update status/priority/agent for up to 100 tasks
- Task notes for lightweight commentary
- Task dependency chain inspection and dependents lookup

### Heartbeat Scheduling
- Engine ticks every 60 seconds with concurrency guard (no overlapping cycles)
- Each agent has its own heartbeat interval
- Per-agent timeout (200s) — one slow agent doesn't block the cycle
- Stuck tasks (in_progress > 10 min, tracked by `_status_changed_at`) auto-reset with warning log
- Rolling average performance metrics
- Periodic auto-cleanup every 50 cycles

### Agent Task Creation
- Agents can create new tasks via `POST /api/projects/:id/tasks/from-agent`
- Must specify `assigned_to_agent_id` (explicit delegation)
- Supports optional `dependency_id` with validation
- Tracks `created_by_agent_id` — displayed as agent slug (e.g. "✎ by orion")

### Data Integrity
- Atomic YAML writes (write to .tmp, then rename)
- Stale .tmp cleanup on startup
- YAML parse error logging
- Defensive type checking on all loaded files
- Orphan cleanup endpoint: removes orphaned results, heartbeats, stale timestamps
- Periodic auto-cleanup in heartbeat engine

### Observability
- Request logging: `METHOD /path STATUS ms`
- Heartbeat stats: cycle count, rolling avg, per-agent metrics
- Task duration tracking on both success and failure paths
- System stats endpoint: counts, file sizes, uptime

## Data Storage

All state in YAML files under `data/`:

```
data/
├── agents.yaml         # Agent configs, roles, heartbeat settings
├── projects.yaml       # Projects with workspace paths
├── tasks.yaml          # Tasks with status, dependencies, priority, assignments
├── heartbeats.yaml     # Heartbeat activity log (auto-pruned to 1000)
└── task_results.yaml   # Execution results, notes (auto-pruned to 500)
```

Human-readable, git-friendly, no database server required.

## API Reference (44 endpoints)

### Health

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Server status, uptime, heartbeat metrics |
| `/health/ready` | GET | Lightweight readiness probe (no YAML reads) |

### Agents

| Endpoint | Method | Description |
|---|---|---|
| `/api/agents/sync` | POST | Import agents from OpenClaw |
| `/api/agents` | GET/POST | List (with `?status`, `?search`) / create new agent |
| `/api/agents/:id` | GET/PUT/DELETE | Single agent CRUD |
| `/api/agents/:id/heartbeat` | POST | Trigger heartbeat for one agent |
| `/api/agents/:id/reactivate` | POST | Reactivate inactive agent |
| `/api/agents/:id/stats` | GET | Per-agent workload and stats |
| `/api/agents/:id/tasks` | GET | All tasks assigned to agent (`?status`, `?project_id`) |

### Projects

| Endpoint | Method | Description |
|---|---|---|
| `/api/projects` | GET/POST | List (`?status`, includes `completion_pct`) / create |
| `/api/projects/:id` | GET/PUT/DELETE | Single project CRUD |
| `/api/projects/:id/reopen` | POST | Reopen completed/failed project |
| `/api/projects/:id/tasks` | GET/POST | List (`?status`, `?priority`, `?agent_id`, `?search`) / create tasks |
| `/api/projects/:id/tasks/from-agent` | POST | Agent-created task delegation |

### Tasks

| Endpoint | Method | Description |
|---|---|---|
| `/api/tasks` | GET | All tasks with `?status`, `?priority`, `?agent_id`, `?project_id`, `?search`, `?sort_by`, `?sort_dir`, `?page`, `?limit` |
| `/api/tasks/summary` | GET | Aggregate counts by status/priority/project/agent |
| `/api/tasks/bulk` | POST | Bulk update status/priority/agent (max 100) |
| `/api/tasks/:id` | GET/PUT/DELETE | Single task CRUD (delete cleans up deps) |
| `/api/tasks/:id/run` | POST | Execute task via OpenClaw agent |
| `/api/tasks/:id/retry` | POST | Reset failed task to pending (`?immediate=1`) |
| `/api/tasks/:id/cancel` | POST | Cancel in_progress task |
| `/api/tasks/:id/duplicate` | POST | Clone task with new ID |
| `/api/tasks/:id/assign` | POST | Reassign to different agent |
| `/api/tasks/:id/notes` | POST | Append note to task |
| `/api/tasks/:id/results` | GET | Execution results (input + output) |
| `/api/tasks/:id/dependents` | GET | Tasks blocked by this one |
| `/api/tasks/:id/chain` | GET | Full dependency chain backward |
| `/api/tasks/:id/history` | GET | Complete context: results, notes, chain, dependents |

### Heartbeats

| Endpoint | Method | Description |
|---|---|---|
| `/api/heartbeats` | GET | Activity log with `?page`, `?limit` |
| `/api/heartbeats/tick` | POST | Manually trigger heartbeat cycle |

### System

| Endpoint | Method | Description |
|---|---|---|
| `/api/system/stats` | GET | Aggregate overview: counts, file sizes, uptime |
| `/api/system/cleanup` | POST | Remove orphaned results, heartbeats, stale data |
| `/api/dashboard` | GET | Stats, agents with task counts, projects with completion %, recent heartbeats |
| `/api` | GET | Self-documenting route listing |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3777` | Server port |
| `BASE_URL` | `http://localhost:${PORT}` | URL used in agent instruction messages |

## Requirements

- [OpenClaw](https://docs.openclaw.ai) installed and configured
- Gateway running (`openclaw gateway start`)
- Node.js 18+
- `js-yaml` and `express` (installed via `npm install`)

## License

MIT
