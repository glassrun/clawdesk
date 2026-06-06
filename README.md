# ClawDesk — AI Agent Orchestration Platform

![ClawDesk](docs/lobsters_working_desk.png)

Manage your OpenClaw agent teams from a single dashboard. Define projects, assign tasks, track progress, and let agents work autonomously on heartbeats. Works on desktop and mobile.

![ClawDesk Screenshot](docs/screenshot.png)

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/glassrun/clawdesk.git
cd clawdesk
```

### 2. Backend

```bash
cd backend && npm install && npm start
# → http://localhost:3777
```

### 3. Frontend

```bash
cd frontend && npm install
cp .env.local.example .env.local   # edit IP if needed
npm run dev
# → http://localhost:3000
```

### 4. Start OpenClaw gateway

```bash
openclaw gateway start
```

Requires [OpenClaw](https://docs.openclaw.ai) installed.

## Frontend Configuration

The frontend reads two values from `frontend/.env.local`:

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend API URL (e.g. `http://192.168.1.100:3777`) |
| `ALLOWED_ORIGINS` | Comma-separated hosts allowed to access the dev server (e.g. `192.168.1.100,localhost`) |

Copy `.env.local.example` to `.env.local` and update the IP to match your machine. This avoids hardcoding IPs in `next.config.js`.

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
  frontend/          # Next.js dashboard (responsive, mobile-friendly)
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

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  LAYER 1: Shared Workspace                                     │
│  ~/clawdesk-projects/{project-slug}/                          │
│  Agents read/write shared files — no direct communication      │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│  LAYER 2: Task Queue (pull-based scheduling)                   │
│  Tasks addressed to specific agents — not broadcast             │
│  Agents pull their own tasks on heartbeat tick                 │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│  LAYER 3: Heartbeat Engine (1-second tick)                     │
│  Wakes agents — does not assign or dispatch                     │
│  Auto-resets stuck tasks, auto-retries failed tasks            │
└────────────────────────────────────────────────────────────────┘
```

### Key design decisions

1. **No direct agent communication** — agents coordinate through artifacts in the shared workspace. Agent A writes a file, Agent B reads it later. No agent needs to know about any other agent.

2. **Pull-based scheduling** — the heartbeat tick wakes agents, agents pull their assigned tasks. The scheduler doesn't track agent state or push work.

3. **Dynamic task tree** — agents can spawn sub-agents and create tasks for other agents at runtime, growing the work graph dynamically.

### Heartbeat behavior

- Runs every 1 second
- Wakes agents — does not assign or dispatch
- Auto-resets stuck tasks (in_progress > 10 minutes → pending)
- Auto-retries failed tasks (15 minute cooldown, max 3 attempts)
- Recurring tasks respawn automatically after completion
