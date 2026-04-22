"use client";

import React, { useEffect, useState } from "react";
import { getDashboard, type Dashboard } from "@/lib/api";

function StatCard({ label, value, icon, color }: { label: string; value: number; icon: string; color: string }) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${color}`}>{icon}</div>
      <div className="stat-body">
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await getDashboard();
      setData(res);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  if (loading) return (
    <div className="page-wrap">
      <div className="loading-grid">
        {[1,2,3,4].map(i => <div key={i} className="skeleton-card" />)}
      </div>
    </div>
  );

  const completed = data?.completed_tasks || 0;
  const failed = data?.failed_tasks || 0;
  const total = completed + failed;
  const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="page-wrap">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Overview of your agent orchestration</p>
        </div>
        <button className="btn" onClick={loadData}>↻ Refresh</button>
      </div>

      {/* Stats Grid */}
      <div className="stats-grid">
        <StatCard label="Total Agents" value={data?.agents?.length || 0} icon="⚡" color="blue" />
        <StatCard label="Active Projects" value={data?.projects?.length || 0} icon="📁" color="purple" />
        <StatCard label="Completed Tasks" value={completed} icon="✅" color="green" />
        <StatCard label="Failed Tasks" value={failed} icon="❌" color="red" />
      </div>

      {/* Success Rate */}
      <div className="progress-card">
        <div className="progress-header">
          <span className="progress-title">Task Success Rate</span>
          <span className="progress-pct">{successRate}%</span>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${successRate}%` }} />
        </div>
        <div className="progress-footer">
          <span>{completed} succeeded</span>
          <span>{failed} failed</span>
        </div>
      </div>

      {/* Two-col layout */}
      <div className="two-col">
        {/* Projects */}
        <div className="panel">
          <div className="panel-header">
            <h2>📁 Projects</h2>
          </div>
          <div className="panel-body">
            {data?.projects?.length === 0 ? (
              <div className="empty-state">No projects yet</div>
            ) : (
              data?.projects?.map((p: any) => (
                <div key={p.id} className="list-item">
                  <div className="list-item-info">
                    <div className="list-item-title">{p.title}</div>
                    <div className="list-item-meta">{p.task_done}/{p.task_total} tasks</div>
                  </div>
                  <div className="list-item-badge">
                    {p.task_total > 0 ? (
                      <span className="pct">{p.completion_pct}%</span>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Agents */}
        <div className="panel">
          <div className="panel-header">
            <h2>🤖 Agents</h2>
          </div>
          <div className="panel-body">
            {data?.agents?.length === 0 ? (
              <div className="empty-state">No agents yet</div>
            ) : (
              data?.agents?.map((a: any) => (
                <div key={a.id} className="list-item">
                  <div className="list-item-info">
                    <div className="list-item-title">{a.name}</div>
                    <div className="list-item-meta">{a.tasks_done || 0} tasks done</div>
                  </div>
                  <span className={`status-dot ${a.status === 'active' ? 'active' : 'idle'}`} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
