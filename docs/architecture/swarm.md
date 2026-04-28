# ClawDesk Architecture

## HSBA: Hierarchical Stigmergic Blackboard Architecture

> This document captures the architectural identity of ClawDesk following design discussions on 2026-04-22 and 2026-04-28. It is the definitive description of what ClawDesk is and how it works.

> **Note:** This architecture was discovered through implementation and observation, not designed top-down from a named pattern. ClawDesk was built, its behavior was observed, and the terminology was derived afterward. The labels (HSBA, Directed Hybrid Stigmergy, mycelium architecture) are descriptive — they name what the system *turned out to be*, not what it was specified to be.

## What is ClawDesk?

**ClawDesk is a Directed Hybrid Stigmergy system. In natural terms: a mycelium architecture.**

It is not a manager-worker system. It is not a pure stigmergy (ant-colony) system either. It blends three coordination mechanisms:

1. **Stigmergy** — shared workspace for environmental memory (agents coordinate via file artifacts, not direct communication)
2. **Directed signals** — task queue with explicit assignment (signals addressed to specific agents, not broadcast to all)
3. **Direct communication** — agents create tasks for each other via API calls

---

**In plain terms:**

A multi-agent orchestration system built around a hierarchical yet collaborative task graph. A Project defines the overall goal. Tasks form a dynamic tree where each task can spawn subtasks and assign them to Agents. Agents themselves can create other agents and share a common workspace for indirect coordination. A heartbeat engine periodically activates eligible tasks and agents, driving execution.

This hybrid model combines explicit delegation through task creation with stigmergic coordination via the shared workspace, enabling both structured workflows and emergent swarm-like behaviors.

In formal terms, ClawDesk employs a **Hierarchical Stigmergic Blackboard Architecture (HSBA)**. In this architecture, a dynamic hierarchy of tasks and agents is constructed through recursive decomposition, where tasks can spawn subtasks and agents can create and assign work to other agents. Coordination and collaboration emerge primarily through a shared workspace that functions as a blackboard. Agents interact indirectly by reading from and writing to this common space, enabling stigmergic behavior — where actions and artifacts left by one agent influence the behavior of others without direct communication. A heartbeat engine drives the periodic activation and execution of tasks and agents, providing the rhythmic pulse that powers the entire system.

---

## The Three Pillars

### 1. Shared Workspace (environmental memory — stigmergy)

Every agent on a project reads from and writes to the same directory. Before starting any task, every agent is instructed:

> "Use the read tool to open and fully read ALL files in the project workspace folder. Then summarize the key information from them before starting your work."

This means agents don't just receive context — they **inherit the accumulated state of the project** every time they run. They encounter artifacts left by other agents naturally, as part of their working context. Files written by agent-A are read by agent-B before agent-B acts.

This is **environmental modification** — the defining feature of stigmergy. The artifacts are **cognitive** (code, reports, structured knowledge) rather than physical traces (pheromones), making this closer to **Cognitive Stigmergy**.

### 2. Task Queue (directed signal channel)

Tasks are posted to a shared queue by any agent. Each task has an **explicit `assigned_agent_id`** — only that agent picks it up. The queue is a **directed signal channel**, not a free-for-all broadcast.

Agents can create tasks for other agents via API. Agents can spawn new agents and immediately create tasks for them. The orchestration is **bottom-up**: workers manage workers.

Priority on tasks serves as the **signal strength / urgency field** — higher priority signals attract earlier attention.

> Note: The task queue is not pure stigmergy. Pheromone-based stigmergy broadcasts to any agent that路过. ClawDesk tasks are **addressed** to specific agents. This is **Directed Stigmergy** — signals are intentionally structured and assigned.

### 3. Heartbeat Engine (centralized pacemaker)

The heartbeat engine is a **clock signal** running on a 60-second cycle. It doesn't assign work — it wakes agents and tells them: "the project workspace is available, go read it and pick up your assigned tasks."

This is **centralized** (one engine, not distributed) but **not managerial** — it doesn't decide what agents do, it just triggers them. The pacemaker pattern distinguishes ClawDesk from manager-worker systems where a central authority delegates tasks.

---

## The Mycelium Metaphor

A natural system that mirrors ClawDesk's architecture more closely than ant colonies: **mycelium** — the network of fungal threads (hyphae) that underlies mushrooms.

### How mycelium works

- No central brain — growth is controlled by local chemical signals
- Tips (apical meristems) grow toward high-concentration nutrient areas
- Adjacent hyphae can **fuse directly** (anastomosis) — direct communication between nodes
- Chemical gradients encode signal strength — stronger trails attract more growth
- Persistent traces: where nutrients were found, the network thickens and remembers
- New growth points (spores) can establish anywhere the network reaches

### Mapping to ClawDesk

| Mycelium | ClawDesk |
|---|---|
| Hyphal network | Agent pool |
| Growth tips (apical dominance) | Heartbeat engine — pacemaker that triggers |
| Chemical gradient (nutrient signal) | Task priority field — signal strength |
| Tip grows toward high-concentration | Agent picks highest-priority task |
| Direct fusion (anastomosis) | Agent creates task for another agent via API |
| Persistent trace (where food was) | Workspace artifacts — durable cognitive modifications |
| Spore → new growth point | Agent spawning mid-execution |
| No central control | Distributed orchestration |

### The three layers as mycelium

```
Mycelium:  Environmental signal (diffusion) + Direct fusion (anastomosis) + Growth tip (pacemaker)
              ↓                                    ↓                                    ↓
ClawDesk:   Workspace (stigmergy)                 API calls (direct)                   Heartbeat engine
```

### Why mycelium fits better than ant colonies

Ant colonies are the classic swarm metaphor, but they rely on **broadcast pheromone signals** — any ant路过 can pick up the trail. ClawDesk doesn't work that way. Tasks are addressed to specific agents, not broadcast.

Mycelium is more precise because:
1. **Directed growth** — tips don't wander randomly, they grow toward specific chemical gradients (like tasks addressed to specific agents)
2. **Three coordination modes** — environmental signal + direct fusion + growth tip exactly match our three layers
3. **Cognitive artifacts** — mycelium leaves physical traces; ClawDesk leaves cognitive traces (code, reports, data)
4. **No competition** — hyphae don't compete for the same nutrient thread; agents don't steal each other's tasks

### Naming

**Mycelium architecture** — the intuitive, build-first name for the system.

**Directed Hybrid Stigmergy** — the formal coordination-theory label.

The natural metaphor for developers building the system. The academic term for papers describing it.

---

## Why "Directed Hybrid Stigmergy" is the Right Label

### Stigmergy definition
Agents coordinate through indirect interaction via environment modification. They don't communicate directly — they modify the shared environment and other agents respond to those modifications.

### ClawDesk has THREE coordination layers

| Layer | Mechanism | Pattern |
|---|---|---|
| Workspace artifacts | Files written by agent A, read by agent B | **Stigmergy** (environmental modification) |
| Task queue | Structured signals with `assigned_agent_id` | **Directed Stigmergy** (intentional signals, not broadcast) |
| Task creation API | Agent A calls POST to create task for Agent B | **Direct communication** (not stigmergy) |

### Cognitive Stigmergy

The workspace modifications in ClawDesk represent **abstract states** (code, reports, data) rather than physical traces (pheromones). This is closer to **Cognitive Stigmergy** — stigmergic principles applied to knowledge-based agents where environmental artifacts are structured knowledge, not simple markers.

### What ClawDesk does NOT have (intentionally)

- **Broadcast signals** — tasks are addressed to specific agents, not broadcast to all. This is the key distinction from pure pheromone stigmergy.
- **Simultaneous perception of the same signal** — agents specialize and converge on their own tasks. You don't want multiple agents on the same signal.
- **Pheromone decay** — artifacts are durable. This is correct. Nest-building is permanent; trail-marking is ephemeral. ClawDesk artifacts are structural modifications, not ephemeral signals.
- **Task competition** — not needed because task assignment is cooperative (agents create tasks for each other), not competitive.
- **Peer-to-peer agent communication** — agents don't message each other directly. Coordination happens via workspace (stigmergy) or task API (directed), not direct chat.

---

## Architectural Summary

```
ClawDesk = Directed Hybrid Stigmergy

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1: Shared Workspace (STIGMERGY)                          │
│                                                                  │
│  /clawdesk-projects/{project-slug}/                             │
│      ↓ files written by any agent                               │
│      ↓ read by all agents before starting                       │
│      ↓ durable artifacts — environmental memory                 │
│  Coordination: indirect via environment                          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2: Task Queue (DIRECTED STIGMERGY)                       │
│                                                                  │
│  Each task: { assigned_agent_id, priority, dependency_id }      │
│      ↓ only the assigned agent picks it up                      │
│      ↓ not broadcast — addressed to specific agent              │
│  Priority = signal strength / urgency field                      │
│  Coordination: intentional, structured, assigned                 │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3: Task Creation API (DIRECT COMMUNICATION)              │
│                                                                  │
│  POST /api/projects/:id/tasks/from-agent                        │
│      Agent A → creates task → assigned to Agent B               │
│  Coordination: direct (not via environment)                     │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  HEARTBEAT ENGINE (centralized pacemaker)                       │
│                                                                  │
│  60-second cycle → wakes agents → agents pick their tasks       │
│  NOT a manager — does not assign or delegate                    │
│  Resets stuck tasks (in_progress > 10 min)                     │
│  Auto-retries failed tasks (15 min cooldown, max 3)             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Terminology

| Old Name | Corrected Name |
|---|---|
| Swarm / Pure Stigmergy | Directed Hybrid Stigmergy |
| Task broadcast | Directed task signal |
| Central orchestrator | Pacemaker (heartbeat engine) |
| Shared inbox | Signal channel (directed) |
| Blackboard | Shared workspace (cognitive stigmergy) |
| Any agent picks up any task | Only assigned agent picks up task |
| Agent-to-agent messaging | Agent-to-agent task creation via API |

---

## What Makes ClawDesk Interesting

Most LLM agent frameworks are manager-worker: a central agent delegates to sub-agents. ClawDesk is different — the orchestration is distributed across three mechanisms (workspace, directed signals, and direct task creation), and the heartbeat is a pacemaker, not a foreman.

Agents discover work by reading the shared workspace and task queue, not by receiving assignments. The coordination is implicit in the environment and the task structure, not explicit in a hierarchy.

This is closer to how insect societies actually work — multiple coordination mechanisms working together — than to how most "agent teams" are architected.

---

*Captured from conversation between Zava and S on 2026-04-22, updated 2026-04-28.*