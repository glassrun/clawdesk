"use client";

import React, { useCallback, useEffect, useState } from "react";
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

function actionBadge(action: string) {
  const a = action.toLowerCase();
  if (a.includes("error") || a.includes("fail")) return <span className="badge status-failed">{action}</span>;
  if (a.includes("executed") || a.includes("run")) return <span className="badge status-done">{action}</span>;
  if (a.includes("retry") || a.includes("auto")) return <span className="badge status-in_progress">{action}</span>;
  if (a.includes("cancel") || a.includes("cancelled")) return <span className="badge" style={{ background: "var(--warning)", color: "#000" }}>{action}</span>;
  if (a.includes("stuck")) return <span className="badge" style={{ background: "#9333ea", color: "#fff" }}>{action}</span>;
  if (a.includes("handoff")) return <span className="badge status-pending">{action}</span>;
  if (a.includes("note")) return <span className="badge" style={{ background: "var(--border)", color: "var(--fg)" }}>{action}</span>;
  return <span className="badge">{action}</span>;
}

function parseActionType(actionTaken: string): string {
  const a = actionTaken.toLowerCase();
  if (a.includes("error") || a.includes("fail")) return "error";
  if (a.includes("executed") || a.includes("run")) return "executed";
  if (a.includes("retry") || a.includes("auto_retry")) return "auto_retry";
  if (a.includes("cancel")) return "task_cancelled";
  if (a.includes("stuck")) return "stuck_reset";
  if (a.includes("handoff")) return "handoff";
  if (a.includes("note")) return "note";
  return "executed";
}

export default function AuditPage() {
  const [heartbeats, setHeartbeats] = useState<Heartbeat[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [filterType, setFilterType] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const { lastMessage, connected } = useStream();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getHeartbeats({ limit: "500" });
      setHeartbeats(res.data || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event === "heartbeat" || lastMessage.event === "tasks") loadData();
  }, [lastMessage, loadData]);

  const agents = [...new Map(heartbeats.map(h => [h.agent_id, { id: h.agent_id, name: h.agent_name || h.openclaw_agent_id }])).values()];

  const filtered = heartbeats.filter(h => {
    if (filterAgent && h.agent_id !== filterAgent) return false;
    if (filterType) {
      const type = parseActionType(h.action_taken);
      if (type !== filterType) return false;
    }
    if (dateFrom && new Date(h.triggered_at) < new Date(dateFrom)) return false;
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      if (new Date(h.triggered_at) > to) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      if (!h.action_taken.toLowerCase().includes(q) &&
          !(h.agent_name || "").toLowerCase().includes(q) &&
          !(h.openclaw_agent_id || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const exportCSV = () => {
    const headers = ["Timestamp", "Agent", "OpenClaw ID", "Status", "Action"];
    const rows = filtered.map(h => [
      new Date(h.triggered_at).toISOString(),
      h.agent_name || "",
      h.openclaw_agent_id || "",
      h.status || "",
      h.action_taken
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page-wrap">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">Audit Log</h1>
          <p className="text-sm text-muted mt-1">
            {filtered.length} of {heartbeats.length} events
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} />
          <button className="btn" onClick={loadData} disabled={loading}>🔄 Refresh</button>
          <button className="btn" onClick={exportCSV}>📥 Export CSV</button>
        </div>
      </div>

      {/* Filters */}
      <div className="card mb-4">
        <div className="card-content">
          <div className="flex gap-3 items-center flex-wrap">
            <input
              placeholder="Search actions, agents..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-52"
            />
            <select value={filterAgent} onChange={(e) => setFilterAgent(e.target.value)} className="w-40">
              <option value="">All Agents</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="w-40">
              <option value="">All Types</option>
              <option value="executed">executed</option>
              <option value="error">error</option>
              <option value="stuck_reset">stuck_reset</option>
              <option value="auto_retry">auto_retry</option>
              <option value="handoff">handoff</option>
              <option value="task_cancelled">task_cancelled</option>
              <option value="note">note</option>
            </select>
            <div className="flex gap-1 items-center text-sm text-muted">
              <span>From</span>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-36" />
              <span>To</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-36" />
            </div>
            {(search || filterAgent || filterType || dateFrom || dateTo) && (
              <button className="btn-sm text-muted" onClick={() => { setSearch(""); setFilterAgent(""); setFilterType(""); setDateFrom(""); setDateTo(""); }}>
                ✕ Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-16 gap-3 text-muted">
            <div className="spinner" />
            Loading...
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-muted py-16">No events match your filters</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="p-3 text-left">Time</th>
                  <th className="p-3 text-left">Relative</th>
                  <th className="p-3 text-left">Agent</th>
                  <th className="p-3 text-left">Type</th>
                  <th className="p-3 text-left">Details</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(h => (
                  <tr key={h.id} className="border-b border-[var(--border)]">
                    <td className="p-3 text-sm text-soft">
                      <div>{new Date(h.triggered_at).toLocaleDateString()}</div>
                      <div className="text-xs">{new Date(h.triggered_at).toLocaleTimeString()}</div>
                    </td>
                    <td className="p-3 text-sm text-muted">{timeAgo(h.triggered_at)}</td>
                    <td className="p-3">
                      <div className="font-medium text-sm">{h.agent_name || "—"}</div>
                      <div className="text-xs text-muted font-mono">#{h.openclaw_agent_id}</div>
                    </td>
                    <td className="p-3">{actionBadge(parseActionType(h.action_taken))}</td>
                    <td className="p-3 max-w-lg">
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
