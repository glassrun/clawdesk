# ClawDesk Architecture: Component Reference

**ClawDesk employs a Hierarchical Stigmergic Blackboard Architecture (HSBA).**

> **Note:** ClawDesk was built first, then observed. The pattern names and component labels are post-hoc descriptions of what the system *does*, not prescriptions for what it should be. Every formal term used here was applied after the fact, not derived from a design doc.

---

## Complete System Breakdown

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLAWDESK SYSTEM                                    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  AGENT REGISTRY                    (OpenClaw platform)              │    │
│  │  openclaw agents list --json                                          │    │
│  │  Per-agent: workspace, identity, model, status                        │    │
│  └─────────────────────────────┬───────────────────────────────────────┘    │
│                                │                                              │
│  ┌─────────────────────────────┴───────────────────────────────────────┐    │
│  │  PACEMAKER                    → Heartbeat Engine                       │    │
│  │  (centralized clock signal)    60-second cycle, runsHeartbeatCycle()  │    │
│  │                                                                    │    │
│  │  Functions:                                                          │    │
│  │  • Wakes due agents (last_heartbeat + interval < now)              │    │
│  │  • Parallel heartbeat execution with 200s timeout per agent          │    │
│  │  • Reset stuck tasks (in_progress > 10 min → pending)               │    │
│  │  • Auto-retry failed tasks (15 min cooldown, max 3 attempts)        │    │
│  │  • SSE broadcast of results to /api/stream                          │    │
│  └─────────────────────────────┬───────────────────────────────────────┘    │
│                                │                                              │
│                                ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  SIGNAL CHANNEL (directed)      → Task Queue (SQLite)               │    │
│  │                                                                    │    │
│  │  Formal properties:                                                   │    │
│  │  • Directed — signal addressed to specific agent, not broadcast     │    │
│  │  • Structured — fields: id, title, description, priority, status    │    │
│  │  • Persistent — survives agent lifecycle                             │    │
│  │  • Priority-ordered — high > medium > low                            │    │
│  │                                                                    │    │
│  │  Signal selection formula:                                           │    │
│  │  tasks.filter(t => t.assigned_agent_id === agent.id                  │    │
│  │                 && t.status === 'pending'                            │    │
│  │                 && (!t.dependency_id || deps[dependency_id].done))  │    │
│  │  Sort: priority (high→low), then id (ascending)                     │    │
│  └─────────────────────────────┬───────────────────────────────────────┘    │
│                                │                                              │
│                                ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  EXECUTION UNIT                → Task (per task execution)           │    │
│  │                                                                    │    │
│  │  executeTask(agent, task):                                          │    │
│  │  1. Build prompt (workspace rules + task + tooling)                │    │
│  │  2. Run: runOpenClawAgent(agent.openclaw_agent_id, message, 180s)  │    │
│  │  3. Parse stdout → JSON result                                      │    │
│  │  4. Store result in task_results table                              │    │
│  │  5. Set task status: done | failed                                  │    │
│  │                                                                    │    │
│  │  Prompt injection (tooling awareness):                              │    │
│  │  • "Use your tools: read, write, exec, web_search, web_fetch"       │    │
│  │  • POST /api/projects/:id/tasks/from-agent (subtask creation)       │    │
│  │  • POST /api/agents (agent spawning)                                │    │
│  └─────────────────────────────┬───────────────────────────────────────┘    │
│                                │                                              │
│                                ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ENVIRONMENT                   → Project Workspace (shared dir)     │    │
│  │                                                                    │    │
│  │  Formal: cognitive stigmergy (environmental modification)          │    │
│  │                                                                    │    │
│  │  Structure: ~/clawdesk-projects/{project-slug}-{timestamp}/        │    │
│  │  • Agents read ALL files before starting work                      │    │
│  │  • Agents write artifacts as they work                             │    │
│  │  • Artifacts persist → next agent inherits accumulated state        │    │
│  │                                                                    │    │
│  │  Coordination mechanism: indirect (no direct agent-to-agent)      │    │
│  │  Signal type: durable cognitive artifacts (code, reports, data)    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Mapping Table

| Formal Name | ClawDesk Name | Description |
|---|---|---|
| **Agent** | OpenClaw agent (`openclaw_agent_id`) | Runtime instance with workspace, identity, model |
| **Executor** | `runOpenClawAgent()` | Spawns OpenClaw CLI, passes prompt, parses result |
| **Pacemaker** | Heartbeat Engine | Clock signal, 60s cycle, not a manager |
| **Signal Channel** | Task Queue (`tasks` table) | Directed, structured, persistent |
| **Signal** | Task (`{id, title, assigned_agent_id, priority}`) | Addressed to specific agent |
| **Execution Unit** | `executeTask()` | Builds prompt, runs agent, stores result |
| **Environment** | Project Workspace (filesystem) | Shared directory, cognitive stigmergy |
| **Artifact** | File in project workspace | Written by agent, read by next agent |
| **Result Store** | `task_results` table | Duration, output, timestamps |
| **Orchestration Fabric** | All three layers together | Directed Hybrid Stigmergy |

---

## The Three-Layer Fabric

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   LAYER 1 — ENVIRONMENT (Stigmergy / Cognitive Stigmergy)       │
│                                                                 │
│   What:    Shared filesystem                                     │
│   Signal:  Durable artifacts (files written/read)                │
│   Coord:   Indirect (agent → workspace → agent)               │
│   Formal:  Environmental modification + cognitive traces       │
│                                                                 │
│   ClawDesk: ~/clawdesk-projects/{slug}-{ts}/                   │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   LAYER 2 — SIGNAL CHANNEL (Directed Stigmergy)                │
│                                                                 │
│   What:    Task queue in SQLite                                 │
│   Signal:  Structured task with `assigned_agent_id`            │
│   Coord:   Addressed broadcast (not free-for-all)              │
│   Formal:  Intentional, structured signal addressing            │
│                                                                 │
│   ClawDesk: `tasks` table, filtered by `assigned_agent_id`    │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   LAYER 3 — DIRECT COMMUNICATION (not stigmergy)               │
│                                                                 │
│   What:    REST API for task creation                           │
│   Signal:  Agent A → HTTP POST → Agent B gets task             │
│   Coord:   Direct (no environment intermediary)                │
│   Formal:  Explicit peer-to-peer coordination                   │
│                                                                 │
│   ClawDesk: POST /api/projects/:id/tasks/from-agent            │
│             POST /api/agents (spawn new agent)                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Execution Flow (Annotated)

```
Operator
    │
    ▼
POST /api/projects/:id/tasks
    │
    ▼
┌───────────────────────────────────────┐
│  TASK QUEUE (SQLite)                   │
│  status: pending                      │
│  assigned_agent_id: dev               │
│  priority: high                       │
│  dependency_id: null                  │
└───────────────────┬───────────────────┘
                    │
    Heartbeat Engine (60s cycle)
                    │
                    ▼
┌───────────────────────────────────────┐
│  SIGNAL SELECTION                     │
│  agent.dev.last_heartbeat + 30s < now │
│  → agent is due                       │
│  → filter: assigned=dev, status=pending│
│  → sort: priority DESC, id ASC        │
│  → pick first                         │
└───────────────────┬───────────────────┘
                    │
                    ▼
┌───────────────────────────────────────┐
│  EXECUTE TASK                         │
│  executeTask(dev, task)               │
│    │                                   │
│    ▼                                   │
│  Build prompt with:                   │
│  • Workspace path                     │
│  • Task title + description           │
│  • Tool instructions (read/write/exec)│
│  • Subtask creation endpoint          │
│  • Agent spawning endpoint            │
│    │                                   │
│    ▼                                   │
│  runOpenClawAgent("dev", prompt, 180s)│
│    │                                   │
│    ▼                                   │
│  [Agent dev runs, writes to workspace]│
│    │                                   │
│    ▼                                   │
│  Result stored in task_results        │
│  Task status → done | failed          │
└───────────────────────────────────────┘
                    │
                    ▼
         SSE broadcast → Frontend
```

---

## Formal Terminology Reference

| Term | Definition | ClawDesk |
|---|---|---|
| **Stigmergy** | Indirect coordination via environment modification | Workspace layer |
| **Cognitive Stigmergy** | Stigmergy with abstract/knowledge artifacts | Workspace files (code, reports) |
| **Directed Stigmergy** | Environmental signals intentionally structured/addressed | Task queue with `assigned_agent_id` |
| **Hybrid Stigmergy** | Stigmergy + other coordination mechanisms | All three layers combined |
| **Pacemaker** | Centralized clock that triggers agents | Heartbeat Engine |
| **Signal Channel** | Medium through which signals propagate | Task queue |
| **Signal Strength** | Urgency/priority of a signal | Task `priority` field |
| **Environmental Memory** | Durable state in shared environment | Project workspace |
| **Bottom-up Orchestration** | Workers create work for other workers | Agent → `/from-agent` API |
| **Transient Roles** | Agents adopt roles temporarily, not fixed | Task-scoped execution |

---

*Companion document to `swarm.md`. For architecture overview, see `swarm.md`.*