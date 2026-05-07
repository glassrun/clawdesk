"use client";

import React, { useEffect, useState, useCallback } from "react";
import { getTasks, getAgents, getProjects, runTask, getTaskResults, deleteTask, createTask, updateTask, getApprovals, approveApproval, rejectApproval, type Task, type Agent, type Project } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { TaskPanel } from "@/components/TaskPanel";

function statusBadge(status: string) {
  const styles: Record<string, string> = {
    pending: "status-pending",
    in_progress: "status-in_progress",
    done: "status-done",
    failed: "status-failed",
  };
  return <span className={"badge " + (styles[status] || "badge")}>{status.replace("_", " ")}</span>;
}

function priorityBadge(priority: string) {
  const styles: Record<string, string> = {
    high: "priority-high",
    medium: "priority-medium",
    low: "priority-low",
  };
  return <span className={"badge " + (styles[priority] || "badge")}>{priority}</span>;
}

function timeAgo(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterPriority, setFilterPriority] = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [filterProject, setFilterProject] = useState("");
  const [filterScheduled, setFilterScheduled] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [expandedResults, setExpandedResults] = useState<number | null>(null);
  const [taskResults, setTaskResults] = useState<Record<number, any[]>>({});
  const [runningTask, setRunningTask] = useState<number | null>(null);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [panelTask, setPanelTask] = useState<Task | null>(null);
  const { lastMessage, connected } = useStream();

  // Approval state
  const [approvals, setApprovals] = useState<any[]>([]);
  const [processingApproval, setProcessingApproval] = useState<number | null>(null);

  // Form state
  const [formTitle, setFormTitle] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formPriority, setFormPriority] = useState("medium");
  const [formAgent, setFormAgent] = useState("");
  const [formProject, setFormProject] = useState(0);
  const [formDepIds, setFormDepIds] = useState<number[]>([]);
  const [formScheduledAt, setFormScheduledAt] = useState("");
  const [formRepeat, setFormRepeat] = useState(false);
  const [formRequiresApproval, setFormRequiresApproval] = useState(false);

  const buildParams = useCallback(() => {
    const params: any = { page, limit: 30 };
    if (search) params.search = search;
    if (filterStatus) params.status = filterStatus;
    if (filterPriority) params.priority = filterPriority;
    if (filterAgent) params.agent_id = filterAgent;
    if (filterProject) params.project_id = filterProject;
    if (filterScheduled) params.scheduled = "1";
    return params;
  }, [page, search, filterStatus, filterPriority, filterAgent, filterProject, filterScheduled]);

  // Silent refresh — no loading state, used for SSE updates
  const refreshData = useCallback(async () => {
    try {
      const params = buildParams();
      const tasksRes = await getTasks(params);
      setTasks(tasksRes.data || []);
      setTotal(tasksRes.total);
      setPages(tasksRes.pages);
    } catch (e) { console.error(e); }
  }, [buildParams]);

  // Full load with loading state
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = buildParams();
      const [tasksRes, agentsRes, projectsRes] = await Promise.all([
        getTasks(params),
        getAgents(),
        getProjects(),
      ]);
      setTasks(tasksRes.data || []);
      setTotal(tasksRes.total);
      setPages(tasksRes.pages);
      setAgents(agentsRes);
      setProjects(projectsRes);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [buildParams]);

  const loadApprovals = useCallback(async () => {
    try {
      const data = await getApprovals({ status: "pending" });
      setApprovals(Array.isArray(data) ? data : []);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => { loadApprovals(); }, [loadApprovals]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event === "tasks") {
      setPage(1);
      refreshData();
    }
  }, [lastMessage, refreshData]);

  // Reset form when Add modal opens
  useEffect(() => {
    if (showAddModal) {
      setFormTitle("");
      setFormDesc("");
      setFormPriority("medium");
      setFormAgent("");
      setFormProject(projects[0]?.id || 0);
      setFormDepIds([]);
      setFormScheduledAt("");
      setFormRepeat(false);
      setFormRequiresApproval(false);
    }
  }, [showAddModal, projects]);

  const handleRun = async (id: number) => {
    setRunningTask(id);
    try {
      await runTask(id);
      const results = await getTaskResults(id);
      setTaskResults(prev => ({ ...prev, [id]: results }));
    } catch (e) { console.error(e); }
    finally { setRunningTask(null); loadData(); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this task?")) return;
    await deleteTask(id);
    loadData();
  };

  const handleDuplicate = async (id: number) => {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    await createTask(+task.project_id, { ...task, title: task.title + " (copy)" });
    loadData();
  };

  const handleStatusChange = async (id: number, status: string) => {
    await updateTask(id, { status });
    refreshData();
  };

  const toggleResults = async (id: number) => {
    if (expandedResults === id) { setExpandedResults(null); return; }
    const results = await getTaskResults(id);
    setTaskResults(prev => ({ ...prev, [id]: results }));
    setExpandedResults(id);
  };

  const openEditModal = (task: Task) => {
    setEditTask(task);
    setFormTitle(task.title);
    setFormDesc(task.description || "");
    setFormPriority(task.priority || "medium");
    setFormAgent(task.assigned_agent_id ? String(task.assigned_agent_id) : "");
    setFormProject(task.project_id);
    setFormDepIds(task.dependency_ids ? JSON.parse(task.dependency_ids) : (task.dependency_id ? [task.dependency_id] : []));
    setFormScheduledAt(task.scheduled_at ? task.scheduled_at.slice(0, 16) : "");
    setFormRepeat(task.repeat === true);
    setFormRequiresApproval(!!task.requires_approval);
    setShowEditModal(true);
  };

  const handleSave = async () => {
    if (!editTask) return;
    await updateTask(editTask.id, {
      title: formTitle,
      description: formDesc,
      priority: formPriority,
      assigned_agent_id: formAgent ? +formAgent : undefined,
      project_id: formProject,
      dependency_id: formDepIds[0] || undefined,
      dependency_ids: formDepIds.length > 0 ? JSON.stringify(formDepIds) : undefined,
      scheduled_at: formScheduledAt || undefined,
      repeat: formRepeat || undefined,
      requires_approval: formRequiresApproval || undefined,
    });
    setShowEditModal(false);
    loadData();
  };

  const handleAddSave = async () => {
    await createTask(formProject, {
      title: formTitle,
      description: formDesc,
      priority: formPriority,
      assigned_agent_id: formAgent ? +formAgent : undefined,
      dependency_id: formDepIds[0] || undefined,
      dependency_ids: formDepIds.length > 0 ? JSON.stringify(formDepIds) : undefined,
      scheduled_at: formScheduledAt || undefined,
      repeat: formRepeat || undefined,
      requires_approval: formRequiresApproval || undefined,
    });
    setShowAddModal(false);
    setFormTitle(""); setFormDesc(""); setFormPriority("medium"); setFormAgent(""); setFormProject(projects[0]?.id || 0); setFormDepIds([]); setFormScheduledAt(""); setFormRepeat(false); setFormRequiresApproval(false);
    loadData();
  };

  const handleApprove = async (id: number) => {
    if (!confirm("Approve this approval request?")) return;
    setProcessingApproval(id);
    try { await approveApproval(id); loadApprovals(); loadData(); } catch (e) { console.error(e); }
    finally { setProcessingApproval(null); }
  };

  const handleReject = async (id: number) => {
    if (!confirm("Reject this approval request?")) return;
    setProcessingApproval(id);
    try { await rejectApproval(id); loadApprovals(); loadData(); } catch (e) { console.error(e); }
    finally { setProcessingApproval(null); }
  };

  const handleSel = (setter: (v: string) => void) => (e: any) => {
    const val = e?.target?.value ?? e ?? '';
    setter(val);
  };

  const projMap = projects.reduce((acc: any, p) => { acc[p.id] = p.title; return acc; }, {});

  const hasScheduledCol = filterScheduled;

  return (
    <div className="page-wrap">
      <div className="flex items-center justify-between">
        <h1>All Tasks</h1>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} />
          <button className="btn-primary" onClick={() => setShowAddModal(true)}>+ Add Task</button>
        </div>
      </div>

      <div className="card mt-4">
        <div className="card-content">
          <div className="flex gap-2 items-center flex-nowrap">
            <input placeholder="Search tasks..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-40" />
            <select value={filterStatus} onChange={(e) => handleSel(setFilterStatus)(e.target.value)} className="w-28">
              <option value="">Status</option>
              <option value="pending">pending</option>
              <option value="in_progress">running</option>
              <option value="done">done</option>
              <option value="failed">failed</option>
            </select>
            <select value={filterPriority} onChange={(e) => handleSel(setFilterPriority)(e.target.value)} className="w-24">
              <option value="">Priority</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
            <select value={filterAgent} onChange={(e) => handleSel(setFilterAgent)(e.target.value)} className="w-28">
              <option value="">Agent</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select value={filterProject} onChange={(e) => handleSel(setFilterProject)(e.target.value)} className="w-32">
              <option value="">Project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
            <button
              className={`btn-sm ${filterScheduled ? "primary" : ""}`}
              onClick={() => setFilterScheduled(f => !f)}
            >
              📅 Scheduled
            </button>
          </div>
        </div>
      </div>

      {/* Pending Approvals */}
      {approvals.length > 0 && (
        <div className="card mt-4" style={{ borderColor: "var(--warning)" }}>
          <div className="card-content">
            <h3 className="mb-3">⏳ Pending Approvals ({approvals.length})</h3>
            <table>
              <thead>
                <tr>
                  <th className="p-3">ID</th>
                  <th className="p-3">Task ID</th>
                  <th className="p-3">Notes</th>
                  <th className="p-3">Requested</th>
                  <th className="p-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {approvals.map(a => (
                  <tr key={a.id}>
                    <td className="p-3">#{a.id}</td>
                    <td className="p-3">
                      <span className="badge status-pending">#{a.task_id}</span>
                    </td>
                    <td className="p-3 text-xs text-muted max-w-xs truncate">{a.notes || "—"}</td>
                    <td className="p-3 text-xs text-soft">{new Date(a.requested_at).toLocaleString()}</td>
                    <td className="p-3">
                      <div className="flex gap-1">
                        <button
                          className="btn-sm"
                          style={{ background: "var(--success)", color: "#fff" }}
                          disabled={processingApproval === a.id}
                          onClick={() => handleApprove(a.id)}
                        >
                          {processingApproval === a.id ? "…" : "✅ Approve"}
                        </button>
                        <button
                          className="btn-sm danger"
                          disabled={processingApproval === a.id}
                          onClick={() => handleReject(a.id)}
                        >
                          ❌ Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card mt-4">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="p-3">ID</th>
                <th className="p-3">Title</th>
                <th className="p-3">Status</th>
                <th className="p-3">Priority</th>
                <th className="p-3">Agent</th>
                <th className="p-3">Depends On</th>
                <th className="p-3">Created By</th>
                <th className="p-3">Project</th>
                {hasScheduledCol && <th className="p-3">Scheduled</th>}
                <th className="p-3">Created</th>
                <th className="p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={hasScheduledCol ? 11 : 10} className="text-center text-muted py-8">Loading...</td></tr> :
              tasks.length === 0 ? <tr><td colSpan={hasScheduledCol ? 11 : 10} className="text-center text-muted py-8">No tasks</td></tr> :
              tasks.map((t, idx) => (
                <React.Fragment key={`task-${t.id}-${idx}`}>
                  <tr>
                    <td className="p-3">#{t.id}</td>
                    <td className="p-3 max-w-xs truncate">{t.title}</td>
                    <td className="p-3">
                      <select value={t.status} onChange={(e) => handleStatusChange(t.id, e.target.value)} className="w-32">
                        <option value="pending">pending</option>
                        <option value="in_progress">in progress</option>
                        <option value="done">done</option>
                        <option value="failed">failed</option>
                      </select>
                    </td>
                    <td className="p-3">{priorityBadge(t.priority || "medium")}</td>
                    <td className="p-3">
                      {t.agent_name ? <span>{t.agent_name}</span> : <span className="text-soft">unassigned</span>}
                    </td>
                    <td className="p-3 text-xs">
                      {t.dependency_id ? (
                        <span
                          className={`badge ${t.dep_title ? (tasks.find(x => x.id === t.dependency_id)?.status === 'done' ? 'status-done' : 'status-pending') : ''}`}
                          title={`Task #${t.dependency_id}${t.dep_title ? ': ' + t.dep_title : ''}`}
                        >
                          #{t.dependency_id}
                        </span>
                      ) : <span className="text-soft">—</span>}
                    </td>
                    <td className="p-3 text-xs text-muted">{t.created_by_agent_slug || <span className="text-soft">—</span>}</td>
                    <td className="p-3 text-muted">{projMap[t.project_id] || `Project #${t.project_id}`}</td>
                    {hasScheduledCol && <td className="p-3 text-xs text-muted">{t.scheduled_at ? new Date(t.scheduled_at).toLocaleString() : "—"}</td>}
                    <td className="p-3 text-soft text-xs">{timeAgo(t.created_at)}</td>
                    <td className="p-3">
                      <div className="flex gap-1">
                        <button className="btn-sm" onClick={() => handleRun(t.id)} disabled={runningTask === t.id}>
                          {runningTask === t.id ? "⏳" : "▶"}
                        </button>
                        <button className="btn-sm" onClick={() => setPanelTask(t)} title="Watch live output">👁</button>
                        <button className="btn-sm" onClick={() => openEditModal(t)}>✏️</button>
                        <button className="btn-sm" onClick={() => toggleResults(t.id)}>📄</button>
                        <button className="btn-sm" onClick={() => handleDuplicate(t.id)}>📋</button>
                        <button className="btn-sm danger" onClick={() => handleDelete(t.id)}>🗑️</button>
                      </div>
                    </td>
                  </tr>
                  {expandedResults === t.id && taskResults[t.id] && (
                    <tr><td colSpan={hasScheduledCol ? 11 : 10} className="p-3" style={{background: "var(--bg)"}}>
                      <div className="text-xs max-h-40 overflow-y-auto">
                        {taskResults[t.id].length === 0 ? <div className="text-soft">No results</div> : taskResults[t.id].map((r: any, i: number) => (
                          <div key={i} className="border-b pb-2 mb-2">
                            <div className="text-soft text-xs">{new Date(r.executed_at).toLocaleString()}</div>
                            <div className="text-yellow-400 whitespace-pre-wrap">{r.input?.slice(0, 300)}</div>
                            <div className="whitespace-pre-wrap">{r.output?.slice(0, 800)}</div>
                          </div>
                        ))}
                      </div>
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {pages > 1 && <div className="flex justify-center gap-2 mt-4">
        <button className="btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button>
        <span className="py-2 px-4 text-muted">{total} tasks · Page {page}/{pages}</span>
        <button className="btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button>
      </div>}

      {/* Add Modal */}
      {showAddModal && <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
        <div className="modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header"><h3>Add Task</h3></div>
          <div>
            <label>Title</label>
            <input value={formTitle} onChange={(e) => setFormTitle(e.target.value)} placeholder="Task title" />
            <label>Description</label>
            <textarea value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder="Task description" rows={3} />
            <label>Priority</label>
            <select value={formPriority} onChange={(e) => setFormPriority(e.target.value)}>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
            <label>Assign to Agent</label>
            <select value={formAgent} onChange={(e) => setFormAgent(e.target.value)}>
              <option value="">Unassigned</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <label>Project</label>
            <select value={formProject} onChange={(e) => setFormProject(Number(e.target.value))}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
            <label>Depends on</label>
            <select
              multiple
              value={formDepIds.map(String)}
              onChange={(e) => setFormDepIds(Array.from(e.target.selectedOptions).map(o => Number(o.value)))}
              className="border rounded p-2 min-h-[80px] text-sm w-full"
            >
              {tasks.filter(t => t.project_id === formProject && t.id !== editTask?.id).map(t => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
            {tasks.filter(t => t.project_id === formProject && t.id !== editTask?.id).length === 0 && <span className="text-muted text-xs">No other tasks in this project</span>}
            <label>Scheduled At</label>
            <input type="datetime-local" value={formScheduledAt} onChange={(e) => setFormScheduledAt(e.target.value)} className="w-full" />
            <label className="flex items-center gap-2 mt-2">
              <input type="checkbox" checked={formRepeat} onChange={(e) => setFormRepeat(e.target.checked)} />
              🔁 Repeat (auto-reschedule when done)
            </label>
            <label className="flex items-center gap-2 mt-1">
              <input type="checkbox" checked={formRequiresApproval} onChange={(e) => setFormRequiresApproval(e.target.checked)} />
              ⏳ Requires approval before execution
            </label>
          </div>
          <div className="modal-footer">
            <button onClick={() => setShowAddModal(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleAddSave}>Add</button>
          </div>
        </div>
      </div>}

      {/* Edit Modal */}
      {showEditModal && editTask && <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
        <div className="modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header"><h3>Edit Task #{editTask.id}</h3></div>
          <div>
            <label>Title</label>
            <input value={formTitle} onChange={(e) => setFormTitle(e.target.value)} />
            <label>Description</label>
            <textarea value={formDesc} onChange={(e) => setFormDesc(e.target.value)} rows={3} />
            <label>Priority</label>
            <select value={formPriority} onChange={(e) => setFormPriority(e.target.value)}>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
            <label>Assign to Agent</label>
            <select value={formAgent} onChange={(e) => setFormAgent(e.target.value)}>
              <option value="">Unassigned</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <label>Project</label>
            <select value={formProject} onChange={(e) => setFormProject(Number(e.target.value))}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
            <label>Depends on</label>
            <select
              multiple
              value={formDepIds.map(String)}
              onChange={(e) => setFormDepIds(Array.from(e.target.selectedOptions).map(o => Number(o.value)))}
              className="border rounded p-2 min-h-[80px] text-sm w-full"
            >
              {tasks.filter(t => t.project_id === formProject && t.id !== editTask?.id).map(t => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
            {tasks.filter(t => t.project_id === formProject && t.id !== editTask?.id).length === 0 && <span className="text-muted text-xs">No other tasks in this project</span>}
            <label>Scheduled At</label>
            <input type="datetime-local" value={formScheduledAt} onChange={(e) => setFormScheduledAt(e.target.value)} className="w-full" />
            <label className="flex items-center gap-2 mt-2">
              <input type="checkbox" checked={formRepeat} onChange={(e) => setFormRepeat(e.target.checked)} />
              🔁 Repeat (auto-reschedule when done)
            </label>
            <label className="flex items-center gap-2 mt-1">
              <input type="checkbox" checked={formRequiresApproval} onChange={(e) => setFormRequiresApproval(e.target.checked)} />
              ⏳ Requires approval before execution
            </label>
          </div>
          <div className="modal-footer">
            <button onClick={() => setShowEditModal(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleSave}>Save</button>
          </div>
        </div>
      </div>}
    {panelTask && (
      <TaskPanel
        task={panelTask}
        isRunning={runningTask === panelTask.id}
        onClose={() => { setPanelTask(null); refreshData(); }}
        onRun={(id) => { setRunningTask(id); }}
        onDone={(id) => { setRunningTask(null); }}
      />
    )}
    </div>
  );
}
