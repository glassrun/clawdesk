"use client";

import React, { useCallback, useEffect, useState } from "react";
import { getAgents, syncAgents, createAgent, updateAgent, deleteAgent, type Agent } from "@/lib/api";
import { useStream } from "@/lib/useStream";

function statusBadge(status: string) {
  const styles: Record<string, string> = {
    active: "status-done",
    idle: "status-pending",
    paused: "status-failed",
  };
  return <span className={"badge " + (styles[status] || "badge")}>{status}</span>;
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

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [formOcId, setFormOcId] = useState("");
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formStatus, setFormStatus] = useState("idle");
  const [formHbEnabled, setFormHbEnabled] = useState(0);
  const [formHbInterval, setFormHbInterval] = useState(30);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await getAgents();
      setAgents(res);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const { lastMessage } = useStream();
  
  useEffect(() => { loadData(); }, []);
  
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event === "tasks" || lastMessage.event === "heartbeat") {
      loadData();
    }
  }, [lastMessage]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await syncAgents();
    } catch (e) { console.error(e); }
    finally { setSyncing(false); loadData(); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this agent?")) return;
    await deleteAgent(id);
    loadData();
  };

  const openEditModal = (agent: Agent) => {
    setEditAgent(agent);
    setFormOcId(agent.openclaw_agent_id);
    setFormName(agent.name);
    setFormDesc("");
    setFormStatus(agent.status || "idle");
    setFormHbEnabled(agent.heartbeat_enabled ? 1 : 0);
    setFormHbInterval(agent.heartbeat_interval || 30);
    setShowModal(true);
  };

  const openAddModal = () => {
    setEditAgent(null);
    setFormOcId("");
    setFormName("");
    setFormDesc("");
    setFormStatus("idle");
    setFormHbEnabled(1);
    setFormHbInterval(30);
    setShowModal(true);
  };

  const handleSave = async () => {
    if (editAgent) {
      await updateAgent(editAgent.id, {
        name: formName,
        status: formStatus,
        heartbeat_enabled: formHbEnabled === 1,
        heartbeat_interval: formHbInterval,
      });
    } else {
      await createAgent({ job_title: formName, job_description: formDesc });
    }
    setShowModal(false);
    loadData();
  };

  return (
    <div className="page-wrap">
      <div className="flex items-center justify-between">
        <h1>All Agents</h1>
        <div className="flex gap-2">
          <button className="btn" onClick={handleSync} disabled={syncing}>
            {syncing ? "⏳ Syncing..." : "🔄 Sync"}
          </button>
          <button className="btn-primary" onClick={openAddModal}>+ Add Agent</button>
        </div>
      </div>

      <div className="card mt-4">
        <div className="card-content">
          {loading ? <div className="text-center text-muted py-8">Loading...</div> :
          agents.length === 0 ? <div className="text-center text-muted py-8">No agents. Click Sync to fetch from OpenClaw.</div> :
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="p-3">ID</th>
                  <th className="p-3">Name</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Tasks Done</th>
                  <th className="p-3">Last Seen</th>
                  <th className="p-3">Heartbeat</th>
                  <th className="p-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {agents.map(a => (
                  <tr key={a.openclaw_agent_id}>
                    <td className="p-3">{a.openclaw_agent_id}</td>
                    <td className="p-3">{a.name}</td>
                    <td className="p-3">{statusBadge(a.status || "idle")}</td>
                    <td className="p-3">{a.tasks_done || 0}</td>
                    <td className="p-3 text-soft">{timeAgo(a.last_heartbeat)}</td>
                    <td className="p-3 text-soft">{a.heartbeat_enabled ? `${a.heartbeat_interval || 30}m` : 'off'}</td>
                    <td className="p-3">
                      <div className="flex gap-1">
                        <button className="btn-sm" onClick={() => openEditModal(a)}>✏️</button>
                        <button className="btn-sm danger" onClick={() => handleDelete(a.id)}>🗑️</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
        </div>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editAgent ? "Edit Agent" : "Add Agent"}</h2>
            </div>
            {editAgent && (
              <div className="form-row">
                <label>OpenClaw Agent ID</label>
                <input value={formOcId} disabled style={{ opacity: 0.6 }} />
              </div>
            )}
            <div className="form-row">
              <label>Name</label>
              <input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Agent name" />
            </div>
            {editAgent && (
              <>
                <div className="form-row">
                  <label>Status</label>
                  <select value={formStatus} onChange={(e) => setFormStatus(e.target.value)}>
                    <option value="idle">idle</option>
                    <option value="active">active</option>
                    <option value="paused">paused</option>
                  </select>
                </div>
                <hr style={{ borderColor: "var(--border)", margin: "12px 0" }} />
                <h3>Heartbeat</h3>
                <div className="form-row">
                  <label>Enabled</label>
                  <select value={formHbEnabled} onChange={(e) => setFormHbEnabled(+e.target.value)}>
                    <option value={0}>Disabled</option>
                    <option value={1}>Enabled</option>
                  </select>
                </div>
                <div className="form-row">
                  <label>Interval (minutes)</label>
                  <input type="number" min={1} max={1440} value={formHbInterval} onChange={(e) => setFormHbInterval(+e.target.value)} />
                </div>
              </>
            )}
            <div className="form-row">
              <label>Description</label>
              <textarea value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder="Description" rows={3} />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}