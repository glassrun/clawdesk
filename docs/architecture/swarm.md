# ClawDesk Architecture

## HSBA: Hierarchical Stigmergic Blackboard Architecture

> This document captures the architectural identity of ClawDesk following design discussions on 2026-04-22 and 2026-04-28. It is the definitive description of what ClawDesk is and how it works.

> **Note:** This architecture was discovered through implementation and observation, not designed top-down from a named pattern. ClawDesk was built, its behavior was observed, and the terminology was derived afterward. The labels (HSBA, Blackboard, mycelium) are descriptive — they name what the system *turned out to be*, not what it was specified to be.

## What is ClawDesk?

**ClawDesk is a Blackboard Architecture** — the classic multi-agent coordination pattern where agents share a common workspace and coordinate indirectly through artifacts, without direct communication.

It is not a manager-worker system. It is not a pure swarm system either. It blends:

1. **Shared workspace (blackboard)** — agents read from and write to a common filesystem, coordinating through artifacts rather than direct communication
2. **Pull-based scheduling** — a heartbeat engine wakes agents on a tick, agents pull their assigned tasks (not push-based central dispatch)
3. **Direct task delegation** — agents can create tasks for other agents and spawn new agents mid-execution, forming a dynamic task tree

---

**In plain terms:**

A multi-agent orchestration system built around a hierarchical yet collaborative task graph. A Project defines the overall goal. Tasks form a dynamic tree where each task can spawn subtasks and assign them to Agents. Agents themselves can create other agents and share a common workspace for indirect coordination. A heartbeat engine periodically activates eligible tasks and agents, driving execution.

This hybrid model combines explicit delegation through task creation with stigmergic coordination via the shared workspace, enabling both structured workflows and emergent swarm-like behaviors.

In formal terms, ClawDesk employs a **Hierarchical Stigmergic Blackboard Architecture (HSBA)**. In this architecture, a dynamic hierarchy of tasks and agents is constructed through recursive decomposition, where tasks can spawn subtasks and agents can create and assign work to other agents. Coordination and collaboration emerge primarily through a shared workspace that functions as a blackboard. Agents interact indirectly by reading from and writing to this common space, enabling stigmergic behavior — where actions and artifacts left by one agent influence the behavior of others without direct communication. A heartbeat engine drives the periodic activation and execution of tasks and agents, providing the rhythmic pulse that powers the entire system.

---

## The Three Pillars

### 1. Shared Workspace (the blackboard)

Every agent on a project reads from and writes to the same directory. Before starting any task, every agent is instructed:

> "Use the read tool to open and fully read ALL files in the project workspace folder. Then summarize the key information from them before starting your work."

This means agents don't just receive context — they **inherit the accumulated state of the project** every time they run. They encounter artifacts left by other agents naturally, as part of their working context. Files written by agent-A are read by agent-B before agent-B acts.

This is the **blackboard** in its classic sense: a shared repository where agents deposit partial solutions and discoveries that other agents can build upon. No agent needs to know about any other agent — it just reads the board and writes results.

### 2. Task Queue (pull-based scheduling)

Tasks are stored in a shared queue. Each task has an **explicit `assigned_agent_id`** — only that agent picks it up. The heartbeat engine doesn't push work to agents — it wakes them, and agents pull their assigned tasks.

Agents can create tasks for other agents via API. Agents can spawn new agents and immediately create tasks for them. The orchestration is **bottom-up**: workers manage workers.

Priority on tasks serves as the **signal strength / urgency field** — higher priority signals attract earlier attention.

### 3. Heartbeat Engine (pull-scheduling tick)

The heartbeat engine runs every second. It doesn't assign work — it wakes agents and tells them: "the project workspace is available, go read it and pick up your assigned tasks."

This is **pull-based scheduling** — the scheduler doesn't route work to agents. Agents announce their availability on the tick and pull what they're assigned. This is more scalable than push-based scheduling because the scheduler doesn't need to track agent state.

---

## The Three Key Architectural Decisions

### 1. No direct agent communication

Agents coordinate entirely through artifacts. Agent A doesn't need to know Agent B exists — it writes a file and moves on. Agent B reads it later. This decouples producers from consumers completely.

### 2. Pull-based scheduling

The heartbeat tick + task queue means agents are passive until woken. Agents don't get pushed work — they wake on the tick and pull their assigned tasks. The scheduler doesn't track agent state; agents announce their own availability by polling.

### 3. Dynamic task tree

Agents spawning sub-agents and creating subtasks forms a tree at runtime. The scope of work can grow dynamically as agents discover what needs doing. This is sometimes called a **hierarchical blackboard** or **recursive task network**.

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
| Growth tips (apical dominance) | Heartbeat engine — tick that triggers |
| Chemical gradient (nutrient signal) | Task priority field — signal strength |
| Tip grows toward high-concentration | Agent picks highest-priority task |
| Direct fusion (anastomosis) | Agent creates task for another agent via API |
| Persistent trace (where food was) | Workspace artifacts — durable cognitive modifications |
| Spore → new growth point | Agent spawning mid-execution |
| No central control | Distributed orchestration |

### Why mycelium fits better than ant colonies

Ant colonies rely on **broadcast pheromone signals** — any ant路过 can pick up the trail. ClawDesk doesn't work that way. Tasks are addressed to specific agents, not broadcast.

Mycelium is more precise because:
1. **Directed growth** — tips don't wander randomly, they grow toward specific chemical gradients (like tasks addressed to specific agents)
2. **Three coordination modes** — environmental signal + direct fusion + growth tip match the three layers
3. **Cognitive artifacts** — mycelium leaves physical traces; ClawDesk leaves cognitive traces (code, reports, data)
4. **No competition** — hyphae don't compete for the same nutrient thread; agents don't steal each other's tasks

### Naming

**Mycelium architecture** — the intuitive, build-first name for the system.

**Hierarchical Stigmergic Blackboard Architecture (HSBA)** — the formal label.

The natural metaphor for developers building the system. The academic term for papers describing it.

---

## Architectural Summary

```
ClawDesk = Hierarchical Stigmergic Blackboard Architecture (HSBA)

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1: Shared Workspace (BLACKBOARD)                          │
│                                                                  │
│  ~/clawdesk-projects/{project-slug}/                           │
│      ↓ files written by any agent                               │
│      ↓ read by all agents before starting                       │
│      ↓ durable artifacts — the board                           │
│  Coordination: indirect via shared workspace                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2: Task Queue (PULL-BASED SCHEDULING)                    │
│                                                                  │
│  Each task: { assigned_agent_id, priority, dependency_id }      │
│      ↓ only the assigned agent picks it up                      │
│      ↓ not broadcast — addressed to specific agent               │
│      ↓ agents pull on heartbeat tick, not pushed by dispatcher  │
│  Priority = signal strength / urgency field                     │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3: Task Creation API (DIRECT DELEGATION)                 │
│                                                                  │
│  POST /api/projects/:id/tasks/from-agent                        │
│      Agent A → creates task → assigned to Agent B               │
│  Agents can spawn new agents at runtime (dynamic task tree)     │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  HEARTBEAT ENGINE (pull-scheduling tick)                       │
│                                                                  │
│  1-second cycle → wakes agents → agents pull their tasks        │
│  NOT a manager — does not assign or dispatch                    │
│  Resets stuck tasks (in_progress > 10 min → pending)          │
│  Auto-retries failed tasks (15 min cooldown, max 3)            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Tradeoffs

**Coherence vs cost:** Because there's no direct messaging, agents must read the full workspace before working to reconstruct shared context. The more accumulated state, the more each new agent must parse. This is the fundamental tradeoff of the blackboard pattern.

**Scalability of pull scheduling:** Because the scheduler doesn't track agent state — it just ticks and agents pull — this scales better than push-based dispatch where the orchestrator must know what every agent is doing.

---

## Terminology

| Old Name | Corrected Name |
|---|---|
| Swarm / Pure Stigmergy | Blackboard Architecture |
| Task broadcast | Directed task signal |
| Central dispatcher | Pull-scheduling heartbeat (tick) |
| Shared inbox | Blackboard (shared workspace) |
| Manager-Worker | HSBA (hierarchical blackboard with stigmergic coordination) |
| Any agent picks up any task | Only assigned agent pulls their tasks |
| Agent-to-agent messaging | Agent-to-agent task creation via API |

---

## What Makes ClawDesk Interesting

Most LLM agent frameworks are manager-worker: a central agent delegates to sub-agents. ClawDesk is different — it has no direct agent-to-agent communication, no central dispatcher pushing work. Agents coordinate entirely through a shared workspace (blackboard) and a pull-based task queue. The heartbeat tick is a clock, not a manager.

This is the classic blackboard pattern, updated with modern pull-scheduling and the ability for agents to dynamically grow the task tree by spawning sub-agents. Classic blackboard systems were designed for problems too complex for a single solver — where partial solutions from specialized agents accumulate into a full answer. ClawDesk applies the same pattern to LLM agent orchestration.

---

*Captured from conversation between Zava and S on 2026-04-22, updated 2026-04-28. Labeling validated against Claude Sonnet 4.6, which independently identified ClawDesk as a Blackboard Architecture.*