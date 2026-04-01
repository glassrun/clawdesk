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
