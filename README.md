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
- **Dependencies** ensure tasks execute in the right order
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
- Sync agents from OpenClaw (`POST /api/agents/sync`)
- Create new agents from the dashboard (creates OpenClaw agent + workspace)
- Configure heartbeat intervals per agent (1-1440 minutes)
- Budget tracking per agent

### Project & Task Management
- Projects with workspace paths — agents `cd` into the project workspace before executing
- Tasks with status tracking (pending → in_progress → done/failed)
- Task dependencies — blocked tasks wait for prerequisites
- Inline output viewing — see what agents produced
- Edit projects and tasks via modal forms

### Heartbeat Scheduling
- Engine ticks every 60 seconds
- Each agent has its own heartbeat interval
- Picks oldest ready task with satisfied dependencies
- Stuck tasks (in_progress > 10 min) auto-reset to pending
- Failed tasks revert to pending for retry

### Agent Task Creation
- Agents can create new tasks via `POST /api/projects/:id/tasks/from-agent`
- Must specify `assigned_to_agent_id` (explicit delegation)
- Tracks `created_by_agent_id` for audit trail
- Agents are informed of this capability in every task prompt

### Agent Workspace Integration
- Agents execute in the project workspace (`cd` into workspace_path)
- Read existing files, write new deliverables
- All file operations happen in the shared project directory
- 18+ files created by agents during Q2 campaign testing

## Data Storage

All state in YAML files under `data/`:

```
data/
├── agents.yaml         # Agent configs, roles, heartbeat settings
├── projects.yaml       # Projects with workspace paths
├── tasks.yaml          # Tasks with status, dependencies, assignments
├── heartbeats.yaml     # Heartbeat activity log
└── task_results.yaml   # Execution results (input + output)
```

Human-readable, git-friendly, no database server required.

## API Reference

### Agents

| Endpoint | Method | Description |
|---|---|---|
| `/api/agents/sync` | POST | Import agents from OpenClaw |
| `/api/agents` | GET/POST | List all / create new agent |
| `/api/agents/:id` | GET/PUT/DELETE | Single agent CRUD |
| `/api/agents/:id/heartbeat` | POST | Trigger heartbeat for one agent |

### Projects

| Endpoint | Method | Description |
|---|---|---|
| `/api/projects` | GET/POST | List all / create new project |
| `/api/projects/:id` | GET/PUT/DELETE | Single project CRUD |

### Tasks

| Endpoint | Method | Description |
|---|---|---|
| `/api/projects/:id/tasks` | GET/POST | List / create tasks for project |
| `/api/projects/:id/tasks/from-agent` | POST | Agent-created task (requires `agent_id`, `assigned_to_agent_id`) |
| `/api/tasks/:id` | GET/PUT | Single task get/update |
| `/api/tasks/:id/run` | POST | Execute task via OpenClaw agent |
| `/api/tasks/:id/results` | GET | Execution results (input + output) |

### Heartbeats

| Endpoint | Method | Description |
|---|---|---|
| `/api/heartbeats` | GET | Heartbeat activity log |
| `/api/heartbeats/tick` | POST | Manually trigger heartbeat cycle |

### Dashboard

| Endpoint | Method | Description |
|---|---|---|
| `/api/dashboard` | GET | Stats, agents, projects with task counts |

## Requirements

- [OpenClaw](https://docs.openclaw.ai) installed and configured
- Gateway running (`openclaw gateway start`)
- Node.js 18+
- `js-yaml` and `express` (installed via `npm install`)

## License

MIT
