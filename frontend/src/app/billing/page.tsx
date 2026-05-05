"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getAgents, getProjects, type Agent, type Project } from "@/lib/api";
import { useStream } from "@/lib/useStream";

const PRICE_PER_M = { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 };

function fmtCost(c: number) {
  if (c >= 1) return `$${c.toFixed(2)}`;
  if (c >= 0.01) return `$${c.toFixed(3)}`;
  return `$${c.toFixed(4)}`;
}
function fmtTokens(t: number) {
  if (t >= 1e6) return `${(t / 1e6).toFixed(1)}M`;
  if (t >= 1e3) return `${(t / 1e3).toFixed(0)}k`;
  return String(t);
}
function timeAgo(dateStr: string | undefined) {
  if (!dateStr) return "never";
  const date = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

interface AgentCost {
  id: number; name: string; openclaw_agent_id: string;
  total_cost: number; total_input: number; total_output: number; total_cache: number; runs: number;
}
interface ProjectCost {
  id: number; title: string;
  total_cost: number; runs: number;
}
interface DailyCost { day: string; cost: number; runs: number; }

interface CostData {
  agents: AgentCost[];
  projects: ProjectCost[];
  daily: DailyCost[];
  total_cost: number; total_input: number; total_output: number; total_cache: number;
  this_month_cost: number;
}

export default function BillingPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [costData, setCostData] = useState<CostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"overview"|"agents"|"projects"|"history">("overview");
  const { lastMessage, connected } = useStream();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [agts, prjs] = await Promise.all([getAgents(), getProjects()]);
      setAgents(agts);
      setProjects(prjs);

      // Fetch per-agent stats + aggregate project costs
      const agentCostPromises = agts.map(async (a) => {
        try {
          const res = await fetch(`/api/agents/${a.id}/stats`);
          if (!res.ok) return null;
          const stats = await res.json();
          return {
            id: a.id, name: a.name, openclaw_agent_id: a.openclaw_agent_id,
            total_cost: stats.usage?.total_cost_usd ?? 0,
            total_input: stats.usage?.total_input_tokens ?? 0,
            total_output: stats.usage?.total_output_tokens ?? 0,
            total_cache: stats.usage?.total_cache_read_tokens ?? 0,
            runs: stats.usage?.task_runs ?? 0,
          } as AgentCost;
        } catch { return null; }
      });

      const projectCostPromises = prjs.map(async (p) => {
        try {
          const res = await fetch(`/api/projects/${p.id}/stats`);
          if (!res.ok) return null;
          const stats = await res.json();
          return {
            id: p.id, title: p.title,
            total_cost: stats.total_cost_usd ?? 0,
            runs: (stats.by_status?.done ?? 0) + (stats.by_status?.failed ?? 0),
          } as ProjectCost;
        } catch { return null; }
      });

      const [ac, pc] = await Promise.all([
        Promise.all(agentCostPromises),
        Promise.all(projectCostPromises),
      ]);

      const agentCosts = ac.filter(Boolean) as AgentCost[];
      const projectCosts = pc.filter(Boolean) as ProjectCost[];

      // Aggregate daily from task_results (fetch raw results for daily breakdown)
      const resultsRes = await fetch("/api/tasks/results-all");
      let daily: DailyCost[] = [];
      if (resultsRes.ok) {
        const allResults = await resultsRes.json();
        const byDay: Record<string, DailyCost> = {};
        const now = new Date();
        for (const r of allResults) {
          if (!r.executed_at || !r.cost) continue;
          const day = r.executed_at.split("T")[0];
          if (!byDay[day]) byDay[day] = { day, cost: 0, runs: 0 };
          byDay[day].cost += r.cost;
          byDay[day].runs += 1;
        }
        daily = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)).slice(-30);
      }

      const totals = agentCosts.reduce((acc, a) => ({
        total_cost: acc.total_cost + a.total_cost,
        total_input: acc.total_input + a.total_input,
        total_output: acc.total_output + a.total_output,
        total_cache: acc.total_cache + a.total_cache,
      }), { total_cost: 0, total_input: 0, total_output: 0, total_cache: 0 });

      const thisMonth = new Date().toISOString().slice(0, 7);
      const thisMonthCost = agentCosts.reduce((s, a) => {
        // We don't have per-result month data from stats alone, so return 0 for now
        return s;
      }, 0);

      setCostData({ agents: agentCosts, projects: projectCosts, daily, ...totals, this_month_cost: thisMonthCost });
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (!lastMessage) return;
    if (["tasks", "agents", "projects"].includes(lastMessage.event)) loadData();
  }, [lastMessage, loadData]);

  const maxDaily = useMemo(() => Math.max(...(costData?.daily.map(d => d.cost) ?? [0]), 0.001), [costData]);

  if (loading) return <div className="page-wrap"><div className="flex items-center justify-center py-16 gap-3 text-muted"><div className="spinner" />Loading billing data...</div></div>;

  const tabs: Array<{k: typeof tab; label: string}> = [
    { k: "overview", label: "📊 Overview" },
    { k: "agents", label: "🤖 By Agent" },
    { k: "projects", label: "📁 By Project" },
    { k: "history", label: "📈 Daily Trend" },
  ];

  return (
    <div className="page-wrap">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">Billing</h1>
          <p className="text-sm text-muted mt-1">Token usage + cost tracking across all agents</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} />
          <button className="btn" onClick={loadData}>🔄 Refresh</button>
        </div>
      </div>

      {/* Tab nav */}
      <div className="flex gap-1 mb-6" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 0 }}>
        {tabs.map(t => (
          <button key={t.k} onClick={() => setTab(t.k)}
            className="px-4 py-2 text-sm rounded-t"
            style={{
              background: tab === t.k ? "var(--bg-hover)" : "transparent",
              border: "1px solid transparent",
              borderBottom: tab === t.k ? "1px solid var(--border)" : "1px solid transparent",
              marginBottom: -1,
              color: tab === t.k ? "var(--fg)" : "var(--text-soft)",
              cursor: "pointer",
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Overview ── */}
      {tab === "overview" && costData && (
        <>
          {/* KPI cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 24 }}>
            <div className="card">
              <div className="card-content py-4">
                <div className="text-xs text-muted uppercase tracking-wide">Total Cost</div>
                <div className="text-2xl font-mono font-bold mt-1" style={{ color: "var(--success)" }}>{fmtCost(costData.total_cost)}</div>
                <div className="text-xs text-muted mt-1">{costData.agents.reduce((s, a) => s + a.runs, 0)} task runs</div>
              </div>
            </div>
            <div className="card">
              <div className="card-content py-4">
                <div className="text-xs text-muted uppercase tracking-wide">Input Tokens</div>
                <div className="text-2xl font-mono font-bold mt-1">{fmtTokens(costData.total_input)}</div>
                <div className="text-xs text-muted mt-1">${(costData.total_input * PRICE_PER_M.input / 1e6).toFixed(2)} at $0.30/M</div>
              </div>
            </div>
            <div className="card">
              <div className="card-content py-4">
                <div className="text-xs text-muted uppercase tracking-wide">Output Tokens</div>
                <div className="text-2xl font-mono font-bold mt-1">{fmtTokens(costData.total_output)}</div>
                <div className="text-xs text-muted mt-1">${(costData.total_output * PRICE_PER_M.output / 1e6).toFixed(2)} at $1.20/M</div>
              </div>
            </div>
            <div className="card">
              <div className="card-content py-4">
                <div className="text-xs text-muted uppercase tracking-wide">Cache Read</div>
                <div className="text-2xl font-mono font-bold mt-1">{fmtTokens(costData.total_cache)}</div>
                <div className="text-xs text-muted mt-1">${(costData.total_cache * PRICE_PER_M.cacheRead / 1e6).toFixed(2)} at $0.06/M</div>
              </div>
            </div>
          </div>

          {/* Mini daily chart */}
          {costData.daily.length > 0 && (
            <div className="card mb-4">
              <div className="card-content">
                <div className="text-sm font-semibold mb-3">Daily Cost (last {costData.daily.length} days)</div>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 60, overflow: "hidden" }}>
                  {costData.daily.slice(-14).map(d => (
                    <div key={d.day} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                      <div style={{ width: "100%", background: "var(--success)", borderRadius: 2, height: `${Math.max((d.cost / maxDaily) * 60, 2)}px`, maxHeight: 60 }} title={`${d.day}: ${fmtCost(d.cost)}`} />
                      <div className="text-xs text-muted" style={{ fontSize: 9 }}>{d.day.slice(5)}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Top agents */}
          {costData.agents.length > 0 && (
            <div className="card">
              <div className="card-content">
                <div className="text-sm font-semibold mb-3">Top Agents by Cost</div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th className="p-3 text-left">Agent</th>
                        <th className="p-3 text-right">Runs</th>
                        <th className="p-3 text-right">Input</th>
                        <th className="p-3 text-right">Output</th>
                        <th className="p-3 text-right">Cache</th>
                        <th className="p-3 text-right">Total Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...costData.agents].sort((a, b) => b.total_cost - a.total_cost).map(a => (
                        <tr key={a.id}>
                          <td className="p-3">{a.name}</td>
                          <td className="p-3 text-right font-mono text-sm">{a.runs}</td>
                          <td className="p-3 text-right font-mono text-sm text-muted">{fmtTokens(a.total_input)}</td>
                          <td className="p-3 text-right font-mono text-sm text-muted">{fmtTokens(a.total_output)}</td>
                          <td className="p-3 text-right font-mono text-sm text-muted">{fmtTokens(a.total_cache)}</td>
                          <td className="p-3 text-right font-mono text-sm font-bold" style={{ color: "var(--success)" }}>{fmtCost(a.total_cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── By Agent ── */}
      {tab === "agents" && costData && (
        <div className="card">
          <div className="card-content">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="p-3 text-left">Agent</th>
                    <th className="p-3 text-left">OpenClaw ID</th>
                    <th className="p-3 text-right">Runs</th>
                    <th className="p-3 text-right">Input Tokens</th>
                    <th className="p-3 text-right">Output Tokens</th>
                    <th className="p-3 text-right">Cache Read</th>
                    <th className="p-3 text-right">Est. Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {[...costData.agents].sort((a, b) => b.total_cost - a.total_cost).map(a => {
                    const costPct = costData.total_cost > 0 ? (a.total_cost / costData.total_cost * 100) : 0;
                    return (
                      <tr key={a.id}>
                        <td className="p-3">{a.name}</td>
                        <td className="p-3 font-mono text-xs text-muted">{a.openclaw_agent_id}</td>
                        <td className="p-3 text-right font-mono text-sm">{a.runs}</td>
                        <td className="p-3 text-right font-mono text-sm">{fmtTokens(a.total_input)}</td>
                        <td className="p-3 text-right font-mono text-sm">{fmtTokens(a.total_output)}</td>
                        <td className="p-3 text-right font-mono text-sm">{fmtTokens(a.total_cache)}</td>
                        <td className="p-3 text-right">
                          <span className="font-mono text-sm font-bold" style={{ color: "var(--success)" }}>{fmtCost(a.total_cost)}</span>
                          <div className="w-16 h-1 rounded mt-1" style={{ background: "var(--bg-hover)", marginLeft: "auto" }}>
                            <div className="h-full rounded" style={{ width: `${costPct}%`, background: "var(--success)" }} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {costData.agents.length === 0 && (
                    <tr><td colSpan={7} className="p-8 text-center text-muted">No agent usage data yet</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="p-3 font-bold">Total</td>
                    <td className="p-3" />
                    <td className="p-3 text-right font-mono text-sm font-bold">{costData.agents.reduce((s, a) => s + a.runs, 0)}</td>
                    <td className="p-3 text-right font-mono text-sm font-bold">{fmtTokens(costData.total_input)}</td>
                    <td className="p-3 text-right font-mono text-sm font-bold">{fmtTokens(costData.total_output)}</td>
                    <td className="p-3 text-right font-mono text-sm font-bold">{fmtTokens(costData.total_cache)}</td>
                    <td className="p-3 text-right font-mono text-sm font-bold" style={{ color: "var(--success)" }}>{fmtCost(costData.total_cost)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── By Project ── */}
      {tab === "projects" && costData && (
        <div className="card">
          <div className="card-content">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="p-3 text-left">Project</th>
                    <th className="p-3 text-right">Task Runs</th>
                    <th className="p-3 text-right">Est. Cost</th>
                    <th className="p-3 text-right">% of Total</th>
                  </tr>
                </thead>
                <tbody>
                  {[...costData.projects].sort((a, b) => b.total_cost - a.total_cost).map(p => {
                    const pct = costData.total_cost > 0 ? (p.total_cost / costData.total_cost * 100) : 0;
                    return (
                      <tr key={p.id}>
                        <td className="p-3">{p.title}</td>
                        <td className="p-3 text-right font-mono text-sm">{p.runs}</td>
                        <td className="p-3 text-right font-mono text-sm font-bold" style={{ color: "var(--success)" }}>{fmtCost(p.total_cost)}</td>
                        <td className="p-3 text-right">
                          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                            <div className="w-16 h-2 rounded" style={{ background: "var(--bg-hover)" }}>
                              <div className="h-full rounded" style={{ width: `${pct}%`, background: "var(--warning)" }} />
                            </div>
                            <span className="text-xs font-mono text-muted">{pct.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {costData.projects.length === 0 && (
                    <tr><td colSpan={4} className="p-8 text-center text-muted">No project data yet</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="p-3 font-bold">Total</td>
                    <td className="p-3 text-right font-mono text-sm font-bold">{costData.projects.reduce((s, p) => s + p.runs, 0)}</td>
                    <td className="p-3 text-right font-mono text-sm font-bold" style={{ color: "var(--success)" }}>{fmtCost(costData.total_cost)}</td>
                    <td className="p-3" />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Daily History ── */}
      {tab === "history" && costData && (
        <>
          <div className="card mb-4">
            <div className="card-content">
              <div className="text-sm font-semibold mb-3">Daily Cost Trend</div>
              {costData.daily.length === 0 ? (
                <div className="text-center text-muted py-8">No daily data yet</div>
              ) : (
                <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 120, overflowY: "auto" }}>
                  {costData.daily.map(d => (
                    <div key={d.day} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 20 }}>
                      <div style={{ width: "100%", background: "var(--success)", borderRadius: 2, height: `${Math.max((d.cost / maxDaily) * 120, 2)}px` }} title={`${d.day}: ${fmtCost(d.cost)} (${d.runs} runs)`} />
                      <div className="text-xs text-muted" style={{ fontSize: 9, whiteSpace: "nowrap" }}>{d.day.slice(5)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-content">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="p-3 text-left">Date</th>
                      <th className="p-3 text-right">Task Runs</th>
                      <th className="p-3 text-right">Est. Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...costData.daily].reverse().map(d => (
                      <tr key={d.day}>
                        <td className="p-3 font-mono text-sm">{d.day}</td>
                        <td className="p-3 text-right font-mono text-sm">{d.runs}</td>
                        <td className="p-3 text-right font-mono text-sm font-bold" style={{ color: "var(--success)" }}>{fmtCost(d.cost)}</td>
                      </tr>
                    ))}
                    {costData.daily.length === 0 && (
                      <tr><td colSpan={3} className="p-8 text-center text-muted">No history data yet</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
