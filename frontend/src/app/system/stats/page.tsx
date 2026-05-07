"use client";

import React, { useCallback, useEffect, useState } from 'react';
import { getSystemStats, type SystemStats } from '@/lib/api';
import { useStream } from '@/lib/useStream';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function SystemStatsPage() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [vacuuming, setVacuuming] = useState(false);
  const [cleanResult, setCleanResult] = useState<any>(null);
  const [vacuumResult, setVacuumResult] = useState<any>(null);
  const { connected } = useStream();

  const loadStats = useCallback(async () => {
    try {
      const s = await getSystemStats();
      setStats(s);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  const handleCleanup = async () => {
    if (!confirm('Run cleanup? This will clear stale completed_at dates and hard-delete soft-deleted tasks/projects.')) return;
    setCleaning(true);
    setCleanResult(null);
    try {
      const res = await fetch('/api/system/cleanup', { method: 'POST' });
      const data = await res.json();
      setCleanResult(data);
      await loadStats();
    } catch (e) { console.error(e); }
    finally { setCleaning(false); }
  };

  const handleVacuum = async () => {
    if (!confirm('Run VACUUM? This will rebuild the database file to reclaim disk space. May take a moment.')) return;
    setVacuuming(true);
    setVacuumResult(null);
    try {
      const res = await fetch('/api/system/vacuum', { method: 'POST' });
      const data = await res.json();
      setVacuumResult(data);
      await loadStats();
    } catch (e) { console.error(e); }
    finally { setVacuuming(false); }
  };

  return (
    <div className="page-wrap">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">⚙️ System</h1>
          <p className="text-sm text-muted mt-1">Database stats, health, and maintenance</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
          <button className="btn" onClick={loadStats} disabled={loading}>🔄 Refresh</button>
        </div>
      </div>

      {/* ── Stats Grid ── */}
      {loading ? (
        <div className="flex items-center justify-center py-16 gap-3 text-muted">
          <div className="spinner" />Loading…
        </div>
      ) : stats && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 24 }}>
            <div className="card">
              <div className="card-content py-4">
                <div className="text-xs text-muted uppercase tracking-wide">Tasks</div>
                <div className="text-2xl font-mono font-bold">{stats.tasks}</div>
                <div className="text-xs text-muted mt-1">{stats.deleted_tasks} soft-deleted</div>
              </div>
            </div>
            <div className="card">
              <div className="card-content py-4">
                <div className="text-xs text-muted uppercase tracking-wide">Projects</div>
                <div className="text-2xl font-mono font-bold">{stats.projects}</div>
              </div>
            </div>
            <div className="card">
              <div className="card-content py-4">
                <div className="text-xs text-muted uppercase tracking-wide">Agents</div>
                <div className="text-2xl font-mono font-bold">{stats.agents}</div>
              </div>
            </div>
            <div className="card">
              <div className="card-content py-4">
                <div className="text-xs text-muted uppercase tracking-wide">Heartbeats</div>
                <div className="text-2xl font-mono font-bold">{stats.heartbeats}</div>
              </div>
            </div>
            <div className="card">
              <div className="card-content py-4">
                <div className="text-xs text-muted uppercase tracking-wide">Task Results</div>
                <div className="text-2xl font-mono font-bold">{stats.task_results}</div>
              </div>
            </div>
            <div className="card">
              <div className="card-content py-4">
                <div className="text-xs text-muted uppercase tracking-wide">Audit Entries</div>
                <div className="text-2xl font-mono font-bold">{stats.audit_entries}</div>
              </div>
            </div>
            <div className="card">
              <div className="card-content py-4">
                <div className="text-xs text-muted uppercase tracking-wide">DB Size</div>
                <div className="text-2xl font-mono font-bold">{formatBytes(stats.db_size_bytes)}</div>
              </div>
            </div>
            <div className="card">
              <div className="card-content py-4">
                <div className="text-xs text-muted uppercase tracking-wide">Schema Version</div>
                <div className="text-2xl font-mono font-bold">v{stats.schema_version}</div>
              </div>
            </div>
          </div>

          {/* ── Maintenance ── */}
          <div className="card">
            <div className="card-content">
              <h2 className="mb-4">🧹 Maintenance</h2>
              <div className="flex gap-3 flex-wrap">
                <button
                  className="btn"
                  onClick={handleCleanup}
                  disabled={cleaning}
                  style={{ background: 'var(--warning)', color: '#000' }}
                >
                  {cleaning ? '⏳ Running…' : '🧹 Run Cleanup'}
                </button>
                <button
                  className="btn"
                  onClick={handleVacuum}
                  disabled={vacuuming}
                  style={{ background: 'var(--danger)', color: '#fff' }}
                >
                  {vacuuming ? '⏳ Running…' : '💾 Run VACUUM'}
                </button>
              </div>

              {cleanResult && (
                <div className="mt-4 p-4 rounded" style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}>
                  <div className="text-sm font-semibold mb-2">✅ Cleanup Result</div>
                  <div className="text-sm text-muted">
                    Stale completed_at cleared: <span className="font-mono">{cleanResult.stale_completed_at_cleared}</span> &nbsp;|&nbsp;
                    Hard-deleted tasks: <span className="font-mono">{cleanResult.hard_deleted_tasks}</span> &nbsp;|&nbsp;
                    Hard-deleted projects: <span className="font-mono">{cleanResult.hard_deleted_projects}</span>
                  </div>
                </div>
              )}

              {vacuumResult && (
                <div className="mt-4 p-4 rounded" style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}>
                  <div className="text-sm font-semibold mb-2">✅ VACUUM Complete</div>
                  <div className="text-sm text-muted">Database file has been rebuilt and optimized.</div>
                </div>
              )}
            </div>
          </div>

          {/* ── System Info ── */}
          <div className="card mt-4">
            <div className="card-content">
              <h2 className="mb-3">ℹ️ System Info</h2>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Node Version</span>
                  <span className="font-mono">{stats.node_version || '—'}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Uptime</span>
                  <span className="font-mono">{stats.uptime_seconds != null ? formatUptime(stats.uptime_seconds) : '—'}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Timestamp</span>
                  <span className="font-mono text-xs">{stats.timestamp ? new Date(stats.timestamp).toLocaleString() : '—'}</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
