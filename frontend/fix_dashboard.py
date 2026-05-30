#!/usr/bin/env python3
# Fix dashboard layout: 3-column row 4, 2-column row 5, project completion row 6

with open('src/app/dashboard/page.tsx', 'r') as f:
    content = f.read()

# 1. Fix return page-wrap -> inline padding
content = content.replace(
    '  return (\n    <div className="page-wrap">',
    '  return (\n    <div style={{ padding: "0 24px 28px" }}>',
    1
)

# 2. Fix Row 1 stats-grid
content = content.replace(
    '      {/* ── Row 1: Main stats ── */}\n      <div className="stats-grid">',
    '      {/* ── Row 1: Main stats (4 columns) ── */}\n      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 20 }}>',
    1
)

# 3. Fix Row 2 stats-grid
content = content.replace(
    '      {/* ── Row 2: Secondary stats ── */}\n      <div className="stats-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>',
    '      {/* ── Row 2: Secondary stats (4 columns) ── */}\n      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 20 }}>',
    1
)

# 4. Get exact text of lines 267-372 (Task Status Breakdown + charts-row + project completion + two-col + live activity + system-health header)
# from the file and replace with new layout
with open('src/app/dashboard/page.tsx', 'r') as f:
    lines = f.readlines()

# The old section: Task Status Breakdown through system-health comment
old_start = None
old_end = None
for i, l in enumerate(lines):
    if '{/* ── Task Status Breakdown (own row) ── */}' in l:
        old_start = i
    if '<div className="system-health">' in l:
        old_end = i
        break

print(f"Old section: lines {old_start+1} to {old_end} (1-indexed)")

# Build replacement
new_section = '''      {/* ── Row 4: Task Status | Projects | Live Activity (3 columns) ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, alignItems: "start", marginBottom: 20 }}>

        {/* Task Status */}
        <div className="chart-card">
          <div className="chart-title">Task Status</div>
          {(() => {
            const byStatus = dash?.agents?.reduce((acc: any, a: any) => {
              acc.pending = (acc.pending || 0) + (a.tasks_pending || 0);
              acc.in_progress = (acc.in_progress || 0) + (a.tasks_in_progress || 0);
              acc.done = (acc.done || 0) + (a.tasks_done || 0);
              acc.failed = (acc.failed || 0) + (a.tasks_failed || 0);
              return acc;
            }, { pending: 0, in_progress: 0, done: 0, failed: 0 });
            const sTotal = (byStatus?.pending || 0) + (byStatus?.in_progress || 0) + (byStatus?.done || 0) + (byStatus?.failed || 0);
            const pct = (n: number) => sTotal > 0 ? `${Math.round((n / sTotal) * 100)}%` : '0%';
            return (
              <>
                <div className="task-bar-chart">
                  {byStatus?.pending > 0 && (
                    <div className="task-bar-segment pending" style={{ flex: byStatus.pending }} title={`Pending: ${byStatus.pending}`}>{pct(byStatus.pending)}</div>
                  )}
                  {byStatus?.in_progress > 0 && (
                    <div className="task-bar-segment in_progress" style={{ flex: byStatus.in_progress }} title={`In Progress: ${byStatus.in_progress}`}>{pct(byStatus.in_progress)}</div>
                  )}
                  {byStatus?.done > 0 && (
                    <div className="task-bar-segment done" style={{ flex: byStatus.done }} title={`Done: ${byStatus.done}`}>{pct(byStatus.done)}</div>
                  )}
                  {byStatus?.failed > 0 && (
                    <div className="task-bar-segment failed" style={{ flex: byStatus.failed }} title={`Failed: ${byStatus.failed}`}>{pct(byStatus.failed)}</div>
                  )}
                  {sTotal === 0 && <div className="task-bar-segment" style={{ flex: 1, background: 'var(--bg-hover)' }} />}
                </div>
                <div className="task-bar-legend">
                  <div className="legend-item"><div className="legend-dot" style={{background:'var(--text-soft)'}}/>Pending {byStatus?.pending ?? 0}</div>
                  <div className="legend-item"><div className="legend-dot" style={{background:'var(--warning)'}}/>In Progress {byStatus?.in_progress ?? 0}</div>
                  <div className="legend-item"><div className="legend-dot" style={{background:'var(--success)'}}/>Done {byStatus?.done ?? 0}</div>
                  <div className="legend-item"><div className="legend-dot" style={{background:'var(--danger)'}}/>Failed {byStatus?.failed ?? 0}</div>
                </div>
              </>
            );
          })()}
        </div>

        {/* Projects */}
        <div className="panel">
          <div className="panel-header">
            <h2>📁 Projects <span className="text-muted text-sm font-normal">({dash?.projects?.length ?? 0})</span></h2>
          </div>
          <div className="table-wrap" style={{ maxHeight: 280, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Tasks</th>
                  <th>Done</th>
                </tr>
              </thead>
              <tbody>
                {dash?.projects?.length === 0 && (
                  <tr><td colSpan={3} className="empty-state">No projects yet</td></tr>
                )}
                {dash?.projects?.map((p: any) => (
                  <tr key={p.id}>
                    <td className="font-medium truncate" style={{ maxWidth: 120 }} title={p.title}>{p.title}</td>
                    <td className="text-center text-sm">{p.tasks_total ?? 0}</td>
                    <td className="text-center text-green text-sm">{p.tasks_done ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Live Activity */}
        <div className="panel">
          <div className="panel-header">
            <h2>📡 Live <span className="flex items-center gap-1 text-sm font-normal text-green"><span className="live-dot" />Live</span></h2>
          </div>
          <div className="activity-feed">
            {recentHeartbeats.length === 0 && <div className="empty-state">No recent activity</div>}
            {recentHeartbeats.map((hb: any, idx: number) => {
              let icon = '💓', iconClass = 'heartbeat', title = hb.agent_name ?? '—', meta = '';
              const raw = (hb.action_taken || hb.action_summary || '') as string;
              try {
                const action: any = raw.startsWith('{') ? JSON.parse(raw) : { action: raw };
                if (action?.action === 'executed') { icon = '⚡'; iconClass = 'heartbeat'; title = `${hb.agent_name ?? '—'} executed task`; meta = action.task_title ? `→ ${action.task_title}` : ''; }
                else if (action?.action === 'error') { icon = '❌'; iconClass = 'failed'; title = `${hb.agent_name ?? '—'} error`; meta = action.error ? `${action.error}`.substring(0, 60) : ''; }
                else if (action?.action === 'stuck_reset') { icon = '🔄'; iconClass = 'pending'; title = `${hb.agent_name ?? '—'} reset`; meta = action.title ?? ''; }
                else if (action?.action === 'auto_retry') { icon = '↺'; iconClass = 'pending'; title = `${hb.agent_name ?? '—'} retry`; meta = `${action.title ?? ''} (${action.attempt ?? ''}/3)`; }
                else if (action?.action === 'handoff') { icon = '🔀'; iconClass = 'agent'; title = `${hb.agent_name ?? '—'} handoff`; meta = `→ ${action.to}: ${action.title ?? ''}`; }
                else { title = hb.agent_name ?? '—'; meta = typeof raw === 'string' ? raw.substring(0, 80) : ''; }
              } catch { title = hb.agent_name ?? '—'; meta = typeof raw === 'string' ? raw.substring(0, 80) : ''; }
              return (
                <div key={`hb-${hb.id ?? idx}`} className="activity-item">
                  <div className={`activity-icon ${iconClass}`}>{icon}</div>
                  <div className="activity-body">
                    <div className="activity-title">{title}</div>
                    {meta && <div className="activity-meta">{meta}</div>}
                  </div>
                  <div className="activity-time">{timeAgo(hb.triggered_at)}</div>
                </div>
              );
            })}
          </div>
        </div>

      </div>

      {/* ── Row 5: Agent Throughput | Agents (2 columns) ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>

        {/* Agent Throughput */}
        <div className="chart-card">
          <div className="chart-title">Agent Throughput</div>
          <div className="throughput-bars">
            {dash?.agents?.length === 0 && <div className="empty-state text-sm">No agents yet</div>}
            {(dash?.agents ?? []).map((a: any) => {
              const done = a.tasks_done ?? 0;
              const failed = a.tasks_failed ?? 0;
              const total = done + failed;
              const maxVal = Math.max(total, 1);
              return (
                <div key={a.id} className="throughput-row">
                  <div className="throughput-label" title={a.name}>{a.name}</div>
                  <div className="throughput-track">
                    <div className="throughput-done-fill" style={{ width: `${(done / maxVal) * 100}%` }}>
                      {done > 0 && done}
                    </div>
                    {failed > 0 && (
                      <div className="throughput-fail-fill" style={{ width: `${(failed / maxVal) * 100}%` }} />
                    )}
                  </div>
                  <div className="throughput-count">{total > 0 ? `${done}/${failed}` : '—'}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Agents */}
        <div className="panel">
          <div className="panel-header">
            <h2>🤖 Agents <span className="text-muted text-sm font-normal">({dash?.agents?.length ?? 0})</span></h2>
          </div>
          <div className="table-wrap" style={{ maxHeight: 280, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Done</th>
                  <th>Fail</th>
                </tr>
              </thead>
              <tbody>
                {dash?.agents?.length === 0 && (
                  <tr><td colSpan={4} className="empty-state">No agents yet</td></tr>
                )}
                {dash?.agents?.map((a: any) => (
                  <tr key={a.id}>
                    <td className="font-medium">{a.name}</td>
                    <td><span className={`badge status-${a.status}`}>{a.status}</span></td>
                    <td className="text-center text-green text-sm">{a.tasks_done ?? 0}</td>
                    <td className="text-center text-red text-sm">{a.tasks_failed ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      {/* ── Row 6: Project Completion (full width) ── */}
      {(dash?.projects ?? []).length > 0 && (
        <div className="chart-card" style={{ marginBottom: 20 }}>
          <div className="chart-title">Project Completion</div>
          <div className="completion-bars">
            {dash?.projects?.map((p: any) => {
              const pct = p.completion_pct ?? 0;
              const color = pct >= 80 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--danger)';
              return (
                <div key={p.id} className="completion-row">
                  <div className="completion-label" title={p.title}>{p.title}</div>
                  <div className="completion-track">
                    <div className="completion-fill" style={{ width: `${pct}%`, background: color }} />
                  </div>
                  <div className="completion-pct" style={{ color }}>{pct}%</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

'''

# Replace lines[old_start:old_end] with new_section
new_lines = lines[:old_start] + [new_section] + lines[old_end:]

with open('src/app/dashboard/page.tsx', 'w') as f:
    f.writelines(new_lines)
print(f"Done, total lines: {len(new_lines)}")