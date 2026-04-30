# ClawDesk — AI Agent Orchestration Platform

![ClawDesk](docs/lobsters_working_desk.png)

Manage your OpenClaw agent teams from a single dashboard. Define projects, assign tasks, track progress, and let agents work autonomously on heartbeats.

## Quick Start

```bash
cd clawdesk
cd backend && npm install && npm start
# → http://localhost:3777

cd frontend && npm install && npm run dev
# → http://localhost:3778
```

Requires [OpenClaw](https://docs.openclaw.ai) installed with the gateway running (`openclaw gateway start`).

## Project Structure

```
clawdesk/
  backend/           # Node.js + Express API server
    server.js        # Entry point
    db.js            # SQLite with migrations
    routes/          # API route handlers
    services/        # Heartbeat engine, task executor
    lib/             # Task handoff parsing
    data/            # SQLite database file
    public/          # Static files
  frontend/          # Next.js dashboard
  docs/              # Architecture docs
  skills/            # OpenClaw skill references
```

## What It Does

ClawDesk is the orchestration layer on top of OpenClaw. It doesn't replace OpenClaw — it coordinates it.

- **Projects** organize work into logical groups with workspace paths
- **Tasks** are individual units of work assigned to OpenClaw agents
- **Heartbeats** dispatch pending tasks to agents automatically every second
- **Dependencies** ensure tasks execute in the right order (with circular dependency detection)
- **Agent coordination** — agents can create new tasks and delegate to other agents

## Architecture: HSBA

ClawDesk uses a **Hierarchical Stigmergic Blackboard Architecture (HSBA)** — a multi-agent coordination pattern where agents share a common workspace and coordinate indirectly through artifacts.

```
┌────────────────────────────────────────────────────────────────┐
│  LAYER 1: Shared Workspace (BLACKBOARD)                        │
│  ~/clawdesk-projects/{project-slug}/                          │
│  Agents read/write shared files — no direct communication      │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│  LAYER 2: Task Queue (PULL-BASED SCHEDULING)                   │
│  Tasks addressed to specific agents — not broadcast             │
│  Agents pull their own tasks on heartbeat tick                 │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│  LAYER 3: Heartbeat Engine (1-second tick)                     │
│  Wakes agents — does not assign or dispatch                    │
│  Auto-resets stuck tasks, auto-retries failed tasks            │
└────────────────────────────────────────────────────────────────┘
```

See `docs/architecture/blackboard.md` for the full architectural deep-dive including the mycelium metaphor.

## Features

### Agent Management
- Sync agents from OpenClaw CLI
- Create new agents (creates OpenClaw agent + workspace)
- Reactivate synced-offline agents
- Per-agent heartbeat interval (1–1440 seconds)
- Budget tracking per agent
- Per-agent stats: task counts, projects, heartbeat history

### Project & Task Management
- Projects with optional workspace paths
- Full task lifecycle: create → assign → run → retry → cancel → duplicate → delete
- Task priorities (high/medium/low) — heartbeat picks high-priority first
- Task dependencies with circular dependency detection
- Projects auto-complete when all tasks done; auto-reopen when tasks are un-done
- Agent-created tasks show creator slug
- Bulk operations: update status/priority/agent for up to 100 tasks
- Task notes for lightweight commentary
- Task dependency chain inspection and dependents lookup

### Heartbeat Scheduling
- Engine ticks every 1 second
- Each agent has its own heartbeat interval
- Per-agent timeout (600s) — one slow agent doesn't block the cycle
- Stuck tasks (in_progress > 10 min) auto-reset with warning log
- Auto-retry failed tasks after 15 minutes (max 3 attempts)
- Rolling average performance metrics
- Periodic auto-cleanup every 50 cycles

### Agent Task Creation
- Agents can create new tasks via `POST /api/projects/:id/tasks/from-agent`
- Must specify `assigned_to_agent_id` (explicit delegation)
- Supports optional `dependency_id` with validation
- Tracks `created_by_agent_id`

### Observability
- SSE streaming for live dashboard updates
- Request logging: `METHOD /path STATUS ms`
- Heartbeat stats: cycle count, rolling avg, per-agent metrics
- System stats endpoint: counts, file sizes, uptime

## API Reference (44 endpoints)

### Health

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Server status, uptime, heartbeat metrics |
| `/health/ready` | GET | Lightweight readiness probe |

### Agents

| Endpoint | Method | Description |
|---|---|---|
| `/api/agents/sync` | POST | Import agents from OpenClaw |
| `/api/agents` | GET/POST | List (with `?status`, `?search`) / create new agent |
| `/api/agents/:id` | GET/PUT/DELETE | Single agent CRUD |
| `/api/agents/:id/heartbeat` | POST | Trigger heartbeat for one agent |
| `/api/agents/:id/reactivate` | POST | Reactivate inactive agent |
| `/api/agents/:id/stats` | GET | Per-agent workload and stats |
| `/api/agents/:id/tasks` | GET | All tasks assigned to agent |

### Projects

| Endpoint | Method | Description |
|---|---|---|
| `/api/projects` | GET/POST | List / create |
| `/api/projects/:id` | GET/PUT/DELETE | Single project CRUD |
| `/api/projects/:id/reopen` | POST | Reopen completed project |
| `/api/projects/:id/tasks` | GET/POST | List / create tasks |
| `/api/projects/:id/tasks/from-agent` | POST | Agent-created task delegation |

### Tasks

| Endpoint | Method | Description |
|---|---|---|
| `/api/tasks` | GET | All tasks with filters |
| `/api/tasks/summary` | GET | Aggregate counts by status/priority/project/agent |
| `/api/tasks/bulk` | POST | Bulk update (max 100) |
| `/api/tasks/:id` | GET/PUT/DELETE | Single task CRUD |
| `/api/tasks/:id/run` | POST | Execute task via OpenClaw agent |
| `/api/tasks/:id/retry` | POST | Reset failed task to pending |
| `/api/tasks/:id/cancel` | POST | Cancel in_progress task |
| `/api/tasks/:id/duplicate` | POST | Clone task with new ID |
| `/api/tasks/:id/assign` | POST | Reassign to different agent |
| `/api/tasks/:id/notes` | POST | Append note to task |
| `/api/tasks/:id/results` | GET | Execution results |
| `/api/tasks/:id/dependents` | GET | Tasks blocked by this one |
| `/api/tasks/:id/chain` | GET | Full dependency chain backward |
| `/api/tasks/:id/history` | GET | Complete context: results, notes, chain, dependents |

### Heartbeats

| Endpoint | Method | Description |
|---|---|---|
| `/api/heartbeats` | GET | Activity log |
| `/api/heartbeats/tick` | POST | Manually trigger heartbeat cycle |

### System

| Endpoint | Method | Description |
|---|---|---|
| `/api/system/stats` | GET | Aggregate overview |
| `/api/system/cleanup` | POST | Remove orphaned data |
| `/api/system/vacuum` | POST | Vacuum SQLite database |
| `/api/dashboard` | GET | Stats, agents, projects, recent heartbeats |
| `/api` | GET | Self-documenting route listing |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3777` | Server port |
| `BASE_URL` | `http://localhost:${PORT}` | URL used in agent instruction messages |
| `OPENCLAW_CLI` | `/home/openclaw/.npm-global/bin/openclaw` | OpenClaw CLI path |

## Requirements

- [OpenClaw](https://docs.openclaw.ai) installed and configured
- Gateway running (`openclaw gateway start`)
- Node.js 18+

## License

MIT