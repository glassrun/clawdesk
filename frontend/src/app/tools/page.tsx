"use client";

import React, { useEffect, useState } from "react";
import { getTools, patchTool } from "@/lib/api";

interface Tool {
  name: string;
  description?: string;
  enabled: boolean;
  riskLevel?: string;
  rateLimit?: number;
}

const RISK_COLORS: Record<string, string> = {
  high: "var(--danger)",
  medium: "var(--warning)",
  low: "var(--success)",
};

const RISK_BADGE: Record<string, string> = {
  high: "status-failed",
  medium: "status-pending",
  low: "status-done",
};

export default function ToolsPage() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterRisk, setFilterRisk] = useState("");
  const [search, setSearch] = useState("");
  const [toggling, setToggling] = useState<string | null>(null);

  const loadTools = async () => {
    setLoading(true);
    try {
      const data = await getTools();
      setTools(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTools();
  }, []);

  const handleToggle = async (name: string, currentEnabled: boolean) => {
    setToggling(name);
    try {
      await patchTool(name, { enabled: !currentEnabled });
      setTools((prev) =>
        prev.map((t) => (t.name === name ? { ...t, enabled: !currentEnabled } : t))
      );
    } catch (e) {
      console.error(e);
    } finally {
      setToggling(null);
    }
  };

  const filtered = tools.filter((t) => {
    if (filterRisk && t.riskLevel !== filterRisk) return false;
    if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="page-wrap">
      <div className="flex items-center justify-between">
        <h1>🔧 Tools Registry</h1>
        <button className="btn-sm" onClick={loadTools}>🔄 Refresh</button>
      </div>

      <div className="card mt-4">
        <div className="card-content">
          <div className="flex gap-2 items-center flex-wrap">
            <input
              placeholder="Search tools..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-40"
            />
            <select value={filterRisk} onChange={(e) => setFilterRisk(e.target.value)} className="w-28">
              <option value="">All risk levels</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card mt-4">
        <div className="card-content">
          {loading ? (
            <div className="text-center text-muted py-8">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center text-muted py-8">No tools found</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="p-3">Name</th>
                    <th className="p-3">Description</th>
                    <th className="p-3">Risk</th>
                    <th className="p-3">Rate Limit</th>
                    <th className="p-3">Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => (
                    <tr key={t.name}>
                      <td className="p-3 font-mono text-sm">{t.name}</td>
                      <td className="p-3 text-sm text-muted max-w-xs truncate">{t.description || "—"}</td>
                      <td className="p-3">
                        <span className={`badge ${RISK_BADGE[t.riskLevel || ""] || "badge"}`}>
                          {t.riskLevel || "unknown"}
                        </span>
                      </td>
                      <td className="p-3 text-sm text-muted">
                        {t.rateLimit != null ? `${t.rateLimit}/min` : "—"}
                      </td>
                      <td className="p-3">
                        <button
                          className={`btn-sm ${t.enabled ? "primary" : ""}`}
                          disabled={toggling === t.name}
                          onClick={() => handleToggle(t.name, t.enabled)}
                        >
                          {toggling === t.name ? "…" : t.enabled ? "ON" : "OFF"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
