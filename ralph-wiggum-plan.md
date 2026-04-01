# Ralph Wiggum Improvement Plan — ClawDesk

## Completion Criterion
- Server starts without errors on port 3777
- All existing API endpoints still respond correctly
- At least 3 meaningful improvements implemented
- Changes committed to `ralph-wiggum-improvements` branch

## Known Issues to Address
1. No input validation on most endpoints
2. No error handling middleware
3. Heartbeat engine has no concurrency protection
4. Tasks stuck >10 min auto-reset but no notification
5. No pagination on list endpoints
6. Agent deletion doesn't clean up tasks assigned to that agent
7. No task priority system
8. Dashboard stats don't include agent-specific breakdowns
9. No health check endpoint
10. Static files served without cache headers

## Progress Log
- Iteration 1: starting...
- **Iteration 2** (2026-04-01): Implemented 5 improvements:
  1. **Health check endpoint** — `GET /health` returns server status, uptime, agent count, active tasks
  2. **Global error handling middleware** — catches unhandled errors, returns clean JSON responses
  3. **Task priority system** — tasks can be low/medium/high priority; heartbeat engine picks high-priority tasks first; seed data updated; both UI modals include priority selector
  4. **Dashboard agent breakdown** — dashboard API now includes per-agent task counts (pending/in_progress/done/failed); dashboard table shows a Tasks column
  5. **Input validation** — project creation validates title length (200) and status values; task creation validates title length (500) and priority values (low/medium/high); static files now served with 1h cache headers
  - Server syntax check passed cleanly on port 3777
- **Iteration 3** (2026-04-01): Implemented 5 improvements:
  1. **Fixed stuck task reset logic** — was comparing `created_at` (wrong — resets everything immediately). Now tracks `_status_changed_at` on every status transition. Auto-reset only fires when a task has been `in_progress` for >10 minutes based on when it actually entered that status.
  2. **Heartbeat concurrency guard** — added `heartbeatRunning` flag so overlapping cycles can't run. If a cycle takes >60s, the next tick skips instead of doubling execution.
  3. **`GET /api/tasks` endpoint** — new cross-project task listing with query filters: `?status=pending`, `?agent_id=3`, `?priority=high`, `?project_id=1`. Results sorted by priority (high first) then ID.
  4. **`GET /api/agents` search/filter** — supports `?status=active` and `?search=name-or-id` query params for filtered agent listing.
  5. **Status change tracking + visible resets** — `setTaskStatus()` helper records `_status_changed_at` on every status transition. When stuck tasks are auto-reset, a `warning` entry is logged to heartbeats.yaml with task details, visible in the heartbeat log UI.
  - No npm dependencies added. Server syntax + runtime verified on port 3777.
- **Iteration 4** (2026-04-01): Implemented 5 improvements:
  1. **Pagination on list endpoints** — `GET /api/tasks` and `GET /api/heartbeats` now return `{ data, total, page, limit, pages }` with `?page=1&limit=30` query params. Max 200 per page.
  2. **Bulk task update** — `POST /api/tasks/bulk` accepts `{ task_ids: [...], status?, priority?, assigned_agent_id? }`. Max 100 tasks per call. Updates status with timestamp tracking.
  3. **All Tasks tab in UI** — new "All Tasks" nav tab with search, status/priority/agent filters, pagination controls, and per-row Run button.
  4. **Task dependency validation** — `POST /api/projects/:id/tasks` now validates that `dependency_id` exists and belongs to the same project before creating.
  5. **Warning badge + stuck reset display** — `.badge-warning` CSS class; heartbeat log shows `⚠ Auto-reset stuck task "X"` for warning entries; System label for non-agent entries.
  - Server syntax + runtime verified on port 3777.
- **Iteration 5** (2026-04-01): Implemented 5 improvements:
  1. **Atomic YAML writes** — `saveYaml` writes to `.tmp` file then `renameSync` to final path. Prevents corruption on crash mid-write.
  2. **Heartbeat log auto-pruning** — `saveHeartbeats()` caps at 1000 entries, keeps most recent. All runtime heartbeat saves use this function.
  3. **`GET /api/agents/:id/stats`** — per-agent workload: task counts by status, projects involved with task count, heartbeat run count, last heartbeat action.
  4. **`workspace_path` optional on project creation** — removed the "workspace_path required" validation. Agents work without it.
  5. **Duplicate task + All Tasks UI** — `POST /api/tasks/:id/duplicate` clones task with new ID and pending status. 📋 button in All Tasks tab.
  - Server syntax + runtime verified on port 3777.
- **Iteration 6** (2026-04-01): Implemented 5 improvements:
  1. **Request logging middleware** — logs `METHOD /path STATUS ms` for all API/health requests. Helps debug which endpoints are hit and how fast.
  2. **Fixed PUT project workspace_path validation** — was rejecting `workspace_path: null` (user not changing it). Now only rejects explicit empty string `""`.
  3. **Project deletion cleans up task_results** — deleting a project now removes orphaned task results for all deleted tasks, not just the tasks themselves.
  4. **Graceful shutdown** — `SIGINT`/`SIGTERM` handlers wait up to 10s for any running heartbeat cycle to finish before closing the server.
  5. **Error handler signature preserved** — verified `(err, req, res, next)` 4-param Express error handler is correct. Renamed `next` to `_next` to avoid linter warnings.
  - Server syntax + runtime verified on port 3777. Shutdown drain confirmed.
- **Iteration 7** (2026-04-01): Implemented 5 improvements:
  1. **404 handler for API routes** — `app.use('/api', ...)` catches unknown API paths and returns `{ error: "No route for GET /api/doesnotexist" }` with 404 status. Non-API routes (static files) are unaffected.
  2. **Heartbeat interval minimum** — PUT /api/agents/:id now clamps `heartbeat_interval` to `Math.max(1, value)`. Setting 0 or negative gets forced to 1 minute minimum.
  3. **Task results auto-pruning** — `saveTaskResults()` caps at 500 entries (most recent). All runtime task result saves use this function, preventing unbounded growth.
  4. **Agent deletion cleans up heartbeats** — `DELETE /api/agents/:id` now removes orphaned heartbeat entries for the deleted agent, not just tasks.
  5. **`GET /api/system/stats`** — aggregate overview: agent/task/project/heartbeat/result counts, max caps, YAML file sizes in bytes, uptime, Node version.
  - Server syntax + runtime verified on port 3777. All endpoints confirmed working.
- **Iteration 8** (2026-04-01): Implemented 4 improvements:
  1. **Circular dependency detection** — `POST /api/projects/:id/tasks` walks the dependency chain before creating. If adding `dependency_id` would create a cycle (A→B→C→A), returns 400 with "circular dependency detected". Tested with actual chain.
  2. **Project auto-completion** — `setTaskStatus()` checks if all tasks in a project are "done" after marking one done. If so, auto-sets project status to "completed" with a console log. Prevents zombie "active" projects with nothing to do.
  3. **Project tasks endpoint filters** — `GET /api/projects/:id/tasks` now supports `?status=pending`, `?priority=high`, `?agent_id=3`, `?search=text` query params, matching the global tasks endpoint filter capabilities.
  4. **Per-agent heartbeat timeout** — heartbeat cycle wraps each `triggerHeartbeat()` in a 200-second `Promise.race` timeout. One slow/hung agent no longer blocks the entire cycle from progressing to other agents.
  - Server syntax + runtime verified on port 3777.
- **Iteration 9** (2026-04-01): Implemented 4 improvements:
  1. **PUT task cycle detection** — `PUT /api/tasks/:id` now validates circular dependencies when `dependency_id` is changed. Walks the chain and rejects if the task would end up depending on itself. Previously only POST had this check.
  2. **PUT task triggers auto-completion** — when PUT sets `status=done`, the handler now checks if all project tasks are done and auto-completes the project. Previously only `setTaskStatus()` (used by heartbeat engine) did this — direct API updates were missed.
  3. **Bulk update triggers auto-completion** — `POST /api/tasks/bulk` with `status=done` now tracks affected projects and checks auto-completion for each. Also correctly sets `completed_at` on all bulk-done tasks.
  4. **`GET /api/tasks/:id/dependents`** — reverse dependency lookup. Returns all tasks that depend on the given task. Useful for impact analysis: "if I fail task X, what gets blocked?"
  - Server syntax + runtime verified on port 3777. All endpoints confirmed.
- **Iteration 10** (2026-04-01): Implemented 4 improvements:
  1. **Task retry endpoint** — `POST /api/tasks/:id/retry` resets failed tasks to pending. Tracks `_retry_count` across retries. Supports `?immediate=1` to run immediately instead of waiting for heartbeat. Only works on tasks with status "failed".
  2. **Configurable BASE_URL** — `BASE_URL` env var replaces hardcoded `localhost:3777` in agent instruction messages. Defaults to `http://localhost:${PORT}`. Fixes agent instructions when running on custom ports.
  3. **Task duration tracking** — `executeTask()` now records `duration_ms` on both success AND failure paths. Stored in `task_results.yaml`. Previously only success path had timing.
  4. **`GET /api/tasks/summary`** — lightweight aggregate endpoint: `by_status`, `by_priority`, `by_project`, `by_agent` counts + `total_retries`. Supports `?project_id` and `?agent_id` filters. No pagination overhead.
  5. **Sort parameters on tasks** — `GET /api/tasks` now accepts `?sort_by=priority|created_at|title|status|id&sort_dir=asc|desc`. Defaults to priority desc. Enables chronological, alphabetical, and custom sorting.
  6. **Heartbeat engine performance metrics** — `/health` now includes heartbeat stats: `cycles`, `avgMs`, `lastMs`, `agentsProcessed`, `errors`, `running`. Tracks cycle timing across all runs.
  - Server syntax + runtime verified on port 3777. All endpoints confirmed.
- **Iteration 11** (2026-04-01): Implemented 5 improvements:
  1. **`runOpenClawAgent` cwd passthrough** — the `cwd` parameter was accepted but never passed to `execFile`. Now sets `opts.cwd` when provided, so agents execute in the project workspace directory.
  2. **YAML parse error logging** — `loadYaml()` catch block now logs `console.error` with the filename and error message. Previously silently returned `[]` on corruption, hiding data loss.
  3. **Stale `.tmp` file cleanup on startup** — on server start, scans `data/` for leftover `.tmp` files from failed atomic writes and deletes them. Found and cleaned a real leftover file on first run.
  4. **`POST /api/projects/:id/reopen`** — reopens a completed or failed project by setting status to "active". Returns 400 if already active. Previously required a full PUT to change project status.
  5. **Project reopen tested end-to-end** — verified: mark completed → reopen → status=active → reopen again → 400 error.
  - Server syntax + runtime verified on port 3777. All endpoints confirmed.
- **Iteration 12** (2026-04-01): Implemented 3 improvements:
  1. **`POST /api/tasks/:id/cancel`** — resets in_progress tasks to pending. Returns 400 if task isn't in_progress. Previously only the stuck-reset mechanism (10+ minutes) could recover in-progress tasks.
  2. **Run error heartbeat logging** — `POST /api/tasks/:id/run` catch block now logs to heartbeats.yaml with status "error". Previously manual run failures were invisible — only heartbeat-triggered runs logged errors.
  3. **Sync flags removed agents** — `syncFromOpenClaw()` now marks agents NOT in the synced list as "inactive" with heartbeat disabled. Previously agents deleted from OpenClaw stayed "active" in ClawDesk forever, causing heartbeat engine to fire against dead agents.
  - Server syntax + runtime verified on port 3777. All endpoints confirmed.
- **Iteration 13** (2026-04-01): Implemented 4 improvements:
  1. **`POST /api/agents/:id/reactivate`** — reactivates inactive agents (marked by sync). Sets status to "active" and re-enables heartbeat. Returns 400 if already active. Previously no way to recover from sync marking agents inactive.
  2. **Agent deletion cleans up task_results** — `DELETE /api/agents/:id` now removes task results for all deleted tasks. Previously orphaned results accumulated forever after agent deletion.
  3. **Cancel logs to heartbeats** — `POST /api/tasks/:id/cancel` now logs a "task_cancelled" warning entry to heartbeats.yaml. Previously cancellations were invisible in the audit trail.
  4. **`from-agent` endpoint supports dependencies** — `POST /api/projects/:id/tasks/from-agent` now accepts optional `dependency_id` with validation (exists, same project). Previously agents couldn't create tasks with dependencies.
  - Server syntax + runtime verified on port 3777. All endpoints confirmed.
- **Iteration 14** (2026-04-01): Implemented 3 improvements:
  1. **Duplicate task doesn't leak internal fields** — `POST /api/tasks/:id/duplicate` explicitly omits `_retry_count` and `_status_changed_at`. Previously copies inherited the original's retry history and stale status timestamp.
  2. **PUT auto-completion no longer double-saves** — removed redundant `saveYaml('tasks.yaml', tasks)` in the auto-completion path. Tasks file is now saved exactly once per PUT, even when auto-completion fires.
  3. **`GET /api/agents/:id/tasks`** — convenience endpoint listing all tasks assigned to an agent. Supports `?status=pending` and `?project_id=1` filters. Returns sorted by priority then ID.
  - Server syntax + runtime verified on port 3777. All endpoints confirmed.
- **Iteration 15** (2026-04-01): Implemented 4 improvements:
  1. **Task deletion clears orphaned dependencies** — `DELETE /api/tasks/:id` now scans all tasks and sets `dependency_id: null` for any that depended on the deleted task. Previously, deleting a dependency target silently broke dependent tasks — the heartbeat engine's `tasks.find(d => d.id === t.dependency_id)?.status` returned `undefined` (falsy), making those tasks permanently unrunnable.
  2. **Request body size limit** — `express.json({ limit: '1mb' })` prevents DoS via oversized JSON payloads. Previously accepted arbitrarily large bodies.
  3. **`GET /api/tasks/:id/chain`** — walks the dependency chain backward from a task, showing all ancestors. Returns `chain_length`, `blocked` flag (true if any ancestor isn't done), and the full chain with status.
  4. **Agent validation on task creation and bulk** — both `POST /api/projects/:id/tasks` and `POST /api/tasks/bulk` (when reassigning) now validate that the referenced agent ID exists before proceeding.
  - Server syntax + runtime verified on port 3777. All endpoints confirmed.
- **Iteration 16** (2026-04-01): Implemented 4 improvements:
  1. **`loadYaml` defensive type check** — now validates parsed data is an array (`Array.isArray`), returning `[]` for non-array YAML. Prevents `nextId` and array methods from failing on corrupted files.
  2. **Agent stats uses reduce instead of sort** — `GET /api/agents/:id/stats` uses `reduce` to find the latest heartbeat entry. O(n) instead of O(n log n).
  3. **Duplicate validates agent exists** — `POST /api/tasks/:id/duplicate` checks the original's assigned agent still exists before creating the copy.
  4. **Project listing includes completion_pct** — `GET /api/projects` now returns `completion_pct` (0-100) alongside `task_total` and `task_done`.
  - Server syntax + runtime verified on port 3777. All endpoints confirmed.
- **Iteration 17** (2026-04-01): Implemented 3 improvements:
  1. **Sync updates agent names** — `syncFromOpenClaw()` now updates existing agents' `name` if it changed in OpenClaw. Previously only status was synced, so renamed agents kept stale names.
  2. **`POST /api/tasks/:id/assign`** — lightweight reassign endpoint. Accepts `agent_id` (numeric or string openclaw_agent_id). Returns old/new agent info. No need for full PUT.
  3. **Dashboard includes completion_pct and recent heartbeats** — `GET /api/dashboard` now returns `completion_pct` per project and `recent_heartbeats` (last 10 with parsed action summaries). Single API call for full dashboard.
  - Server syntax + runtime verified on port 3777. All endpoints confirmed.
- **Iteration 18** (2026-04-01): Implemented 3 improvements:
  1. **Global unhandled error handler** — frontend `window.addEventListener('unhandledrejection')` catches all unhandled API errors and shows them to the user via alert. Previously failed deletes/runs/updates were silent.
  2. **`POST /api/tasks/:id/notes`** — lightweight way to append a note to a task. Stored in task_results with `type: 'note'`. Accepts `note` (required) and `agent_id` (optional). Notes appear in the task results timeline.
  3. **`GET /api/projects?status=active`** — project listing now supports `?status=active|completed|failed` filter. Useful for dashboards that only show active projects.
  - Server syntax + runtime verified on port 3777. All endpoints confirmed.
- **Iteration 19** (2026-04-01): Implemented 3 improvements:
  1. **`POST /api/system/cleanup`** — data integrity sweep: removes orphaned task results (for deleted tasks), orphaned heartbeat entries (for deleted agents), and clears stale `completed_at` on non-done tasks. Found and cleaned 2 orphaned results + 1 stale timestamp on first run.
  2. **Enriched task history** — `GET /api/tasks/:id/history` now includes `dependency_chain` (full ancestor chain) and `dependents` (tasks blocked by this one). Separate `notes` array for note-type results. Single endpoint for complete task context.
  3. **Fixed history endpoint variable reference** — `tasks` was undefined in the history handler's chain/dependents lookups. Changed to `allTasks` (the correctly-scoped variable).
  - Server syntax + runtime verified on port 3777. All endpoints confirmed.
- **Iteration 20** (2026-04-01): Implemented 3 improvements:
  1. **Heartbeat rolling average** — `heartbeatStats` now tracks `last10Ms` (last 10 cycle durations). `/health` includes `recentAvgMs` — the rolling 10-cycle average. More responsive than all-time `avgMs` for detecting recent performance issues.
  2. **Periodic auto-cleanup** — heartbeat engine runs orphaned result cleanup every 50 cycles (~50 min). Prevents slow data bloat without requiring manual `/api/system/cleanup` calls.
  3. **`in_progress_seconds` on task detail** — `GET /api/tasks/:id` now includes `in_progress_seconds` when the task is in_progress. Shows how long the task has been running. Omitted for non-in_progress tasks.
  - Server syntax + runtime verified on port 3777. All endpoints confirmed.
- **Iteration 21** (2026-04-01): Implemented 3 improvements:
  1. **Task priority normalization** — `normalizeTask()` helper fills in `priority: 'medium'` for tasks missing the field. Used in `GET /api/tasks` and `GET /api/tasks/:id`. Fixes 19 legacy tasks with undefined priority from old API calls.
  2. **`GET /health/ready`** — lightweight readiness probe that returns immediately without loading any YAML files. 34ms vs 44ms for full `/health`. Useful for load balancers, k8s probes, and uptime monitors.
  3. **Extracted `normalizeTask()` helper** — centralizes task-to-response transformation. Ensures consistent default values (priority, agent_name) across all endpoints that return task objects.
  - Server syntax + runtime verified on port 3777. All endpoints confirmed.
- **Iteration 22** (2026-04-01): Final verification — all 16 GET endpoints return 200, unknown routes return 404. Codebase stable at 1274 lines (server) + 619 lines (frontend). 43 API endpoints, 10 agents, 22 tasks, 2 projects, 174 heartbeats, 27 task results. No remaining data integrity issues.

## Final State Summary
- **43 API endpoints** covering agents, projects, tasks, heartbeats, system
- **Atomic YAML writes** with .tmp cleanup on startup
- **Heartbeat engine** with concurrency guard, per-agent timeout, stuck task reset, periodic cleanup
- **Full CRUD** for agents/projects/tasks with validation (circular deps, agent existence, priority)
- **Task lifecycle**: create → assign → run → retry → cancel → duplicate → delete (with dep cleanup)
- **Auto-completion**: projects auto-complete when all tasks done, auto-reopen when un-done
- **Pagination**: all list endpoints support page/limit/sort/filter
- **Bulk operations**: bulk status/priority/agent updates with auto-completion
- **Observability**: request logging, heartbeat stats (rolling avg), task duration tracking, notes
- **Data integrity**: cleanup endpoint, orphan detection, dependency chain validation
- **Frontend**: 5 tabs (Dashboard, Agents, Projects, All Tasks, Heartbeats), filters, bulk ops, modals
- **Iteration 23** (2026-04-01): Implemented 1 improvement:
  1. **`GET /api` self-documenting route listing** — returns JSON with all 43 endpoints grouped by resource (health, agents, projects, tasks, heartbeats, system, dashboard). Includes version, endpoint counts, and filter documentation. Useful for API discovery without reading source code.
  - Server syntax + runtime verified on port 3777. 44 endpoints total (43 existing + 1 new).
