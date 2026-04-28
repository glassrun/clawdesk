"use client";

import React, { useEffect, useState, useCallback } from "react";
import { getHeartbeats, type Heartbeat } from "@/lib/api";
import { useStream } from "@/lib/useStream";

function timeAgo(dateStr: string) {
  if (!dateStr) return "never";
  const date = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

type FilterStatus = "all" | "ok" | "warning" | "failed";

export default function HeartbeatsPage() {
  const [heartbeats, setHeartbeats] = useState<Heartbeat[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const { lastMessage, connected } = useStream();

  const refreshData = useCallback(async () => {
    try {
      const res = await getHeartbeats({ limit: "500" });
      setHeartbeats(res.data || []);
      setTotal(res.total || res.data?.length || 0);
      setPages(res.pages || 1);
    } catch (e) { console.error(e); }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getHeartbeats({ limit: "500" });
      setHeartbeats(res.data || []);
      setTotal(res.total || res.data?.length || 0);
      setPages(res.pages || 1);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event === "heartbeat" || lastMessage.event === "tasks") refreshData();
  }, [lastMessage, refreshData]);

  const filtered = filter === "all"
    ? heartbeats
    : heartbeats.filter(h => h.status === filter);

  const stats = {
    total: heartbeats.length,
    ok: heartbeats.filter(h => h.status === "ok").length,
    warning: heartbeats.filter(h => h.status === "warning").length,
    failed: heartbeats.filter(h => h.status === "failed").length,
  };

  return (
    <div className="page-wrap">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">Heartbeat Log</h1>
          <p className="text-sm text-muted mt-1">
            {stats.total} shown · {stats.ok} healthy · {stats.warning} warnings · {stats.failed} failed
            {total > stats.total ? ` · ${total} total` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} />
          <button className="btn" onClick={loadData}>🔄 Refresh</button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2 mb-4">
        {(["all", "ok", "warning", "failed"] as FilterStatus[]).map(f => (
          <button
            key={f}
            className={`btn-sm ${filter === f ? "primary" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
            <span className="ml-1 text-xs opacity-60">
              {f === "all" ? stats.total : stats[f as keyof typeof stats]}
            </span>
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-16 gap-3 text-muted">
            <div className="spinner" />
            Loading heartbeats...
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-muted py-16">No heartbeats</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Time</th>
                  <th>Agent</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(h => (
                  <tr key={h.id}>
                    <td className="w-24">
                      <span className={`badge status-${h.status || "ok"}`}>
                        <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                          h.status === "ok" ? "bg-blue-400" :
                          h.status === "warning" ? "bg-amber-400" : "bg-red-400"
                        }`} />
                        {h.status || "ok"}
                      </span>
                    </td>
                    <td className="w-40 text-soft text-sm">
                      <div>{timeAgo(h.triggered_at)}</div>
                      <div className="text-xs text-muted">{new Date(h.triggered_at).toLocaleTimeString()}</div>
                    </td>
                    <td>
                      <div className="font-medium">{h.agent_name}</div>
                      <div className="text-xs text-muted font-mono">#{h.openclaw_agent_id}</div>
                    </td>
                    <td className="max-w-md">
                      <div className="text-xs font-mono text-muted truncate" title={h.action_taken}>
                        {h.action_taken}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
