# ClawDesk Architecture: Swarm-Based AI Orchestration

> This document captures the architectural identity of ClawDesk following a design discussion on 2026-04-22. It is the definitive description of what ClawDesk is and how it works.

## What is ClawDesk?

**ClawDesk is a swarm-based AI agent orchestration system.** It is not a manager-worker system. It is not a blackboard architecture. It is stigmergy — agents coordinate through indirect interaction via a shared environment.

---

## The Three Pillars

### 1. Shared Workspace (the environment)

Every agent on a project reads from and writes to the same directory. Before starting any task, every agent is instructed:

> "Use the read tool to open and fully read ALL files in the project workspace folder. Then summarize the key information from them before starting your work."

This means agents don't just receive context — they **inherit the accumulated state of the project** every time they run. They encounter artifacts left by other agents naturally, as part of their working context. Files written by agent-A are read by agent-B before agent-B acts.

This is **environmental modification** — the defining feature of stigmergy.

### 2. Task Queue (the signal channel)

Tasks are posted to a shared queue by any agent. Any agent can pick up a task. The queue is a **signal channel**, not a todo list — it broadcasts work to the collective, not assigns it.

Agents can create tasks for other agents via API. Agents can spawn new agents and immediately create tasks for them. The orchestration is **bottom-up**: workers manage workers.

Priority on tasks serves as the **signal strength / urgency field** — higher priority signals attract earlier attention.

### 3. Heartbeat Engine (the pacemaker, not the manager)

The heartbeat engine is a **clock signal**. It doesn't assign work. It wakes agents and tells them: "the project workspace is available, go read it and pick up anything that needs doing."

This distinguishes ClawDesk from manager-worker: there is no central orchestration. The heartbeat is a pacemaker, not a foreman.

---

## Why "Swarm" is the Right Word

### Stigmergy definition
Agents coordinate through indirect interaction via environment modification. They don't communicate directly — they modify the shared environment and other agents respond to those modifications.

### ClawDesk satisfies every condition

| Stigmergy Requirement | ClawDesk Implementation |
|---|---|
| Indirect coordination | Shared workspace files — agents read what others wrote |
| Environmental modification | Durable artifacts in workspace, not ephemeral signals |
| No central orchestration | Heartbeat is clock, not manager. Agents assign each other |
| Signal channel | Task queue broadcasts work to collective |
| Signal strength / urgency | Task priority field |
| Agent specialization | Different agents have different tools and roles |

### What ClawDesk does NOT have (intentionally)

- **Simultaneous perception of the same signal** — this is correct. Agents specialize and converge on their own tasks. You don't want multiple agents on the same signal.
- **Pheromone decay** — artifacts are durable. This is correct. Nest-building is permanent; trail-marking is ephemeral. ClawDesk artifacts are structural modifications, not signals.
- **Task competition** — not needed because task assignment is cooperative (agents create tasks for each other), not competitive.

---

## Architectural Summary

```
Shared Workspace (project directory)
    ↓ files written by any agent
    ↓ read by all agents entering the workspace
    ↓ agents act on accumulated state

Task Queue (YAML, via API)
    ↓ any agent can post a task
    ↓ any agent can pick up a task
    ↓ priority = signal strength

Heartbeat Engine
    ↓ wakes agents on interval
    ↓ agents read workspace → read queue → act
    ↓ agents can create tasks for other agents
    ↓ agents can spawn new agents mid-execution

Agents
    ↓ no central assignment
    ↓ assign each other via API
    ↓ specialized tools
    ↓ transient roles (not persistent identities)
```

---

## Terminology

| Old Name | Corrected Name |
|---|---|
| Manager-Worker | Swarm / Stigmergy |
| Task assignment | Task signal / broadcast |
| Central orchestrator | Pacemaker (heartbeat engine) |
| Shared inbox | Signal channel |
| Blackboard | Shared workspace (durable artifacts, not notes) |

---

## What Makes ClawDesk Interesting

Most LLM agent frameworks are manager-worker: a central agent delegates to sub-agents. ClawDesk is different — the orchestration is implicit in the environment, not explicit in a hierarchy. Agents discover work by reading the shared workspace and task queue, not by receiving assignments.

This is closer to how ant colonies actually work than to how most "agent teams" are architected.

---

*Captured from conversation between Zava and S on 2026-04-22.*
