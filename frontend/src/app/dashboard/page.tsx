"use client";

import React, { useEffect, useState, useCallback } from "react";
import { getDashboard, getSystemStats, type Dashboard, type SystemStats } from "@/lib/api";
import { useStream } from "@/lib/useStream";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function timeAgo(iso: string): string {
  if (!iso) return "—";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function uptimeFromMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

function getSuccessColor(pct: number): string {
  if (pct >= 80) return "var(--success)";
  if (pct >= 50) return "var(--warning)";
  return "var(--danger)";
}

function getProgressGradient(pct: number): string {
  if (pct >= 80) return "linear-gradient(90deg, var(--success), #34d399)";
  if (pct >= 50) return "linear-gradient(90deg, var(--warning), #fbbf24)";
  return "linear-gradient(90deg, var(--danger), #f87171)";
}

function statusLabel(s: string | undefined): string {
  if (!s) return "—";
  return s.replace(/_/g, " ");
}

// ── StatCard ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon, colorClass }: {
  label: string; value: string | number; icon: string; colorClass: string;
}) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${colorClass}`}>{icon}</div>
      <div className="stat-body">
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  );
}

// ── AgentRow ─────────────────────────────────────────────────────────────────

function AgentRow({ agent }: { agent: any }) {
  const isActive = agent.status === "active";
  return (
    <tr>
      <td>
        <div className="flex items-center gap-2">
          <span className={`status-dot ${isActive ? "active" : "idle"}`} />
          <span className="font-medium">{agent.name}</span>
        </div>
      </td>
      <td className="text-mono text-xs text-muted">{agent.openclaw_agent_id}</td>
      <td>
        <span className={`badge ${isActive ? "status-in_progress" : "status-pending"}`}>
          {agent.status}
        </span>
      </td>
      <td className="text-muted text-sm">{agent.heartbeat_interval ? `${agent.heartbeat_interval}s` : "—"}</td>
      <td className="text-muted text-sm">{timeAgo(agent.last_heartbeat)}</td>
      <td className="text-center">
        <span className="text-green text-sm font-medium">{agent.tasks_done ?? 0}</span>
      </td>
      <td className="text-center">
        <span className="text-red text-sm font-medium">{agent.tasks_failed ?? 0}</span>
      </td>
      <td className="text-right">
        <span className="text-sm">
          {agent.budget_spent != null
            ? `$${agent.budget_spent.toFixed(2)}`
            : "—"}
        </span>
      </td>
    </tr>
  );
}

// ── ProjectRow ───────────────────────────────────────────────────────────────

function ProjectRow({ project }: { project: any }) {
  const pct = project.completion_pct ?? 0;
  return (
    <tr>
      <td>
        <div className="project-title" title={project.title}>{project.title}</div>
      </td>
      <td>
        {project.status ? (
          <span className={`badge status-${project.status}`}>{statusLabel(project.status)}</span>
        ) : "—"}
      </td>
      <td style={{ minWidth: 120 }}>
        <div className="progress-bar" style={{ height: 6 }}>
          <div
            className="progress-fill"
            style={{
              width: `${pct}%`,
              background: getProgressGradient(pct),
            }}
          />
        </div>
        <div className="text-xs text-muted mt-1">{pct}%</div>
      </td>
      <td className="text-muted text-sm">
        {project.task_done ?? 0}/{project.task_total ?? 0}
      </td>
      <td className="text-mono text-xs text-soft truncate" style={{ maxWidth: 160 }} title={project.workspace_path}>
        {project.workspace_path ?? "—"}
      </td>
    </tr>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [startTime] = useState(() => Date.now());
  const { lastMessage, connected } = useStream();

  const refreshAll = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([getDashboard(), getSystemStats()]);
      setDash(d);
      setStats(s);
    } catch (e) { console.error(e); }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try { await refreshAll(); } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [refreshAll]);

  useEffect(() => { loadData(); }, []);

  // Re-render every 30s for "X ago" freshness + uptime ticker
  useEffect(() => {
    const id = setInterval(() => refreshAll(), 30_000);
    return () => clearInterval(id);
  }, [refreshAll]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event === "tasks" || lastMessage.event === "heartbeat") {
      refreshAll();
    }
  }, [lastMessage, refreshAll]);

  const completed = dash?.completed_tasks ?? 0;
  const failed = dash?.failed_tasks ?? 0;
  const total = completed + failed;
  const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
  const uptimeMs = Date.now() - startTime;

  if (loading) return (
    <div className="page-wrap">
      <div className="loading-grid">
        {[1,2,3,4,5,6,7,8].map(i => <div key={i} className="skeleton-card" />)}
      </div>
    </div>
  );

  const recentHeartbeats = (dash?.recent_heartbeats ?? []).slice(0, 12);

  return (
    <div className="page-wrap">

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Agent orchestration overview</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-sm text-muted">
            <span className={`w-2 h-2 rounded-full ${connected ? "live-dot" : "bg-red-400"}`} />
            {connected ? "Live" : "Disconnected"}
          </span>
          <button className="btn" onClick={loadData}>↻ Refresh</button>
        </div>
      </div>

      {/* ── Row 1: Main stats ── */}
      <div className="stats-grid">
        <StatCard label="Total Agents"   value={stats?.agents   ?? dash?.agents?.length   ?? 0} icon="⚡" colorClass="blue"   />
        <StatCard label="Active Tasks"   value={dash?.active_tasks    ?? 0}                     icon="🔴" colorClass="red"    />
        <StatCard label="Completed"      value={completed}           icon="✅" colorClass="green"  />
        <StatCard label="Failed"         value={failed}              icon="❌" colorClass="red"    />
      </div>

      {/* ── Row 2: Secondary stats ── */}
      <div className="stats-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <StatCard
          label="DB Size"
          value={stats?.db_size_bytes != null ? formatBytes(stats.db_size_bytes) : "—"}
          icon="💾" colorClass="purple"
        />
        <StatCard
          label="Uptime"
          value={uptimeFromMs(uptimeMs)}
          icon="🕐" colorClass="blue"
        />
        <StatCard
          label="Success Rate"
          value={`${successRate}%`}
          icon="📊" colorClass={successRate >= 80 ? "green" : successRate >= 50 ? "purple" : "red"}
        />
        <StatCard
          label="Schema Version"
          value={stats?.schema_version ?? "—"}
          icon="🔧" colorClass="blue"
        />
      </div>

      {/* ── Success rate bar (full width) ── */}
      <div className="progress-card">
        <div className="progress-header">
          <span className="progress-title">Task Success Rate</span>
          <span className="progress-pct" style={{ color: getSuccessColor(successRate) }}>
            {successRate}%
          </span>
        </div>
        <div className="progress-bar">
          <div
            className="progress-fill"
            style={{
              width: `${successRate}%`,
              background: getProgressGradient(successRate),
            }}
          />
        </div>
        <div className="progress-footer">
          <span className="text-green">{completed} succeeded</span>
          <span className="text-muted">{total} total</span>
          <span className="text-red">{failed} failed</span>
        </div>
      </div>

      {/* ── Charts row ── */}
      <div className="charts-row">

        {/* Task status breakdown */}
        <div className="chart-card">
          <div className="chart-title">Task Status Breakdown</div>
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

        {/* Agent throughput bars */}
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
      </div>

      {/* ── Project completion visual bars ── */}
      {(dash?.projects ?? []).length > 0 && (
        <div className="chart-card" style={{ margin: '20px 0' }}>
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

      {/* ── Two column: Projects + Agents ── */}
      <div className="two-col">

        {/* Projects */}
        <div className="panel">
          <div className="panel-header">
            <h2>📁 Projects <span className="text-muted text-sm font-normal">({dash?.projects?.length ?? 0})</span></h2>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Completion</th>
                  <th>Tasks</th>
                  <th>Workspace</th>
                </tr>
              </thead>
              <tbody>
                {dash?.projects?.length === 0 && (
                  <tr><td colSpan={5} className="empty-state">No projects yet</td></tr>
                )}
                {dash?.projects?.map((p: any) => <ProjectRow key={p.id} project={p} />)}
              </tbody>
            </table>
          </div>
        </div>

        {/* Agents */}
        <div className="panel">
          <div className="panel-header">
            <h2>🤖 Agents <span className="text-muted text-sm font-normal">({dash?.agents?.length ?? 0})</span></h2>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Agent ID</th>
                  <th>Status</th>
                  <th>HB Int.</th>
                  <th>Last HB</th>
                  <th className="text-center">Done</th>
                  <th className="text-center">Fail</th>
                  <th className="text-right">Budget</th>
                </tr>
              </thead>
              <tbody>
                {dash?.agents?.length === 0 && (
                  <tr><td colSpan={8} className="empty-state">No agents yet</td></tr>
                )}
                {dash?.agents?.map((a: any) => <AgentRow key={a.id} agent={a} />)}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Live Activity Feed ── */}
      <div className="panel">
        <div className="panel-header">
          <h2>📡 Live Activity <span className="flex items-center gap-1 text-sm font-normal text-green">
            <span className="live-dot" />Live
          </span></h2>
        </div>
        <div className="activity-feed">
          {recentHeartbeats.length === 0 && (
            <div className="empty-state">No recent activity</div>
          )}
          {recentHeartbeats.map((hb: any) => {
            let icon = '💓';
            let iconClass = 'heartbeat';
            let title = hb.agent_name ?? hb.openclaw_agent_id ?? '—';
            let meta = '';
            try {
              const action = typeof hb.action_taken === 'string' ? JSON.parse(hb.action_taken) : hb.action_taken;
              if (action?.action === 'executed') { icon = '⚡'; iconClass = 'heartbeat'; title = `${hb.agent_name ?? '—'} executed task`; meta = action.task_title ? `→ ${action.task_title}` : ''; }
              else if (action?.action === 'error') { icon = '❌'; iconClass = 'failed'; title = `${hb.agent_name ?? '—'} error`; meta = action.error ? `${action.error}`.substring(0, 60) : ''; }
              else if (action?.action === 'stuck_reset') { icon = '🔄'; iconClass = 'pending'; title = `${hb.agent_name ?? '—'} stuck task reset`; meta = action.title ? `${action.title}` : ''; }
              else if (action?.action === 'auto_retry') { icon = '↺'; iconClass = 'pending'; title = `${hb.agent_name ?? '—'} auto-retry`; meta = `${action.title ?? ''} (${action.attempt ?? ''}/3)`; }
              else if (action?.action === 'handoff') { icon = '🔀'; iconClass = 'agent'; title = `${hb.agent_name ?? '—'} handoff`; meta = `→ ${action.to}: ${action.title ?? ''}`; }
              else if (action?.raw) { icon = '📋'; iconClass = 'heartbeat'; title = hb.agent_name ?? '—'; meta = action.raw.substring(0, 80); }
              else { icon = '💓'; iconClass = 'heartbeat'; title = hb.agent_name ?? '—'; meta = typeof hb.action_taken === 'string' ? hb.action_taken.substring(0, 80) : ''; }
            } catch {
              title = hb.agent_name ?? hb.openclaw_agent_id ?? '—';
              meta = typeof hb.action_taken === 'string' ? hb.action_taken.substring(0, 80) : '';
            }
            return (
              <div key={hb.id} className="activity-item">
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

      {/* ── System health footer ── */}
      <div className="system-health">
        <div className="health-item">
          <span className="text-soft text-xs">DB Size</span>
          <span className="text-sm">{stats?.db_size_bytes != null ? formatBytes(stats.db_size_bytes) : "—"}</span>
        </div>
        <div className="health-sep" />
        <div className="health-item">
          <span className="text-soft text-xs">Schema</span>
          <span className="text-sm">v{stats?.schema_version ?? "?"}</span>
        </div>
        <div className="health-sep" />
        <div className="health-item">
          <span className="text-soft text-xs">Deleted Tasks</span>
          <span className="text-sm">{stats?.deleted_tasks ?? 0}</span>
        </div>
        <div className="health-sep" />
        <div className="health-item">
          <span className="text-soft text-xs">Audit Entries</span>
          <span className="text-sm">{stats?.audit_entries ?? 0}</span>
        </div>
        <div className="health-sep" />
        <div className="health-item">
          <span className="text-soft text-xs">Total Spent</span>
          <span className="text-sm text-green">
            {dash?.total_spent != null ? `$${dash.total_spent.toFixed(2)}` : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}