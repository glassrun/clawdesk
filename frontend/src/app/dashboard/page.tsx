"use client";

import React, { useEffect, useState } from "react";
import { getDashboard, type Dashboard } from "@/lib/api";

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

  if (loading) return <div className="page-wrap"><div className="text-center text-muted py-8">Loading...</div></div>;

  return (
    <div className="page-wrap">
      <h1>Dashboard</h1>

      <div className="flex gap-3 mt-4 flex-wrap">
        <div className="card" style={{flex: '1 1 200px'}}>
          <div className="card-content">
            <div className="text-sm text-muted">Total Agents</div>
            <div className="text-lg font-bold">{data?.agents?.length || 0}</div>
          </div>
        </div>
        <div className="card" style={{flex: '1 1 200px'}}>
          <div className="card-content">
            <div className="text-sm text-muted">Active Projects</div>
            <div className="text-lg font-bold">{data?.projects?.length || 0}</div>
          </div>
        </div>
        <div className="card" style={{flex: '1 1 200px'}}>
          <div className="card-content">
            <div className="text-sm text-muted">Completed Tasks</div>
            <div className="text-lg font-bold">{data?.completed_tasks || 0}</div>
          </div>
        </div>
        <div className="card" style={{flex: '1 1 200px'}}>
          <div className="card-content">
            <div className="text-sm text-muted">Failed Tasks</div>
            <div className="text-lg font-bold">{data?.failed_tasks || 0}</div>
          </div>
        </div>
      </div>

      <div className="card mt-4">
        <div className="card-header"><h3>Projects</h3></div>
        <div className="card-content">
          {data?.projects?.length === 0 ? <div className="text-muted">No projects</div> :
          data?.projects?.map((p: any) => (
            <div key={p.id} className="flex items-center justify-between pb-2 border-b">
              <span>{p.title}</span>
              <span className="text-sm text-muted">{p.task_done}/{p.task_total} tasks</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card mt-4">
        <div className="card-header"><h3>Agents</h3></div>
        <div className="card-content">
          {data?.agents?.length === 0 ? <div className="text-muted">No agents</div> :
          data?.agents?.map((a: any) => (
            <div key={a.id} className="flex items-center justify-between pb-2 border-b">
              <span>{a.name}</span>
              <span className={"badge " + (a.status === 'active' ? 'status-done' : 'status-pending')}>{a.status}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
