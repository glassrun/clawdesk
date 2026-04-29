"use client";

import React, { useEffect, useState, useCallback } from "react";
import { getTasks, getAgents, getProjects, runTask, getTaskResults, deleteTask, createTask, updateTask, type Task, type Agent, type Project } from "@/lib/api";
import { useStream } from "@/lib/useStream";

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
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [expandedResults, setExpandedResults] = useState<number | null>(null);
  const [taskResults, setTaskResults] = useState<Record<number, any[]>>({});
  const [runningTask, setRunningTask] = useState<number | null>(null);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const { lastMessage, connected } = useStream();

  // Form state
  const [formTitle, setFormTitle] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formPriority, setFormPriority] = useState("medium");
  const [formAgent, setFormAgent] = useState("");
  const [formProject, setFormProject] = useState(1);

  const buildParams = useCallback(() => {
    const params: any = { page, limit: 30 };
    if (search) params.search = search;
    if (filterStatus) params.status = filterStatus;
    if (filterPriority) params.priority = filterPriority;
    if (filterAgent) params.agent_id = filterAgent;
    if (filterProject) params.project_id = filterProject;
    return params;
  }, [page, search, filterStatus, filterPriority, filterAgent, filterProject]);

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

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.event === "tasks") {
      setPage(1);
      refreshData();
    }
  }, [lastMessage, refreshData]);

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
    });
    setShowAddModal(false);
    setFormTitle(""); setFormDesc(""); setFormPriority("medium"); setFormAgent(""); setFormProject(1);
    loadData();
  };

  const handleSel = (setter: (v: string) => void) => (e: any) => {
    const val = e?.target?.value ?? e ?? '';
    setter(val);
  };

  const projMap = projects.reduce((acc: any, p) => { acc[p.id] = p.title; return acc; }, {});

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
          </div>
        </div>
      </div>

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
                <th className="p-3">Created</th>
                <th className="p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={10} className="text-center text-muted py-8">Loading...</td></tr> :
              tasks.length === 0 ? <tr><td colSpan={10} className="text-center text-muted py-8">No tasks</td></tr> :
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
                    <td className="p-3 text-soft text-xs">{timeAgo(t.created_at)}</td>
                    <td className="p-3">
                      <div className="flex gap-1">
                        <button className="btn-sm" onClick={() => handleRun(t.id)} disabled={runningTask === t.id}>
                          {runningTask === t.id ? "⏳" : "▶"}
                        </button>
                        <button className="btn-sm" onClick={() => openEditModal(t)}>✏️</button>
                        <button className="btn-sm" onClick={() => toggleResults(t.id)}>📄</button>
                        <button className="btn-sm" onClick={() => handleDuplicate(t.id)}>📋</button>
                        <button className="btn-sm danger" onClick={() => handleDelete(t.id)}>🗑️</button>
                      </div>
                    </td>
                  </tr>
                  {expandedResults === t.id && taskResults[t.id] && (
                    <tr><td colSpan={10} className="p-3" style={{background: "var(--bg)"}}>
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
          </div>
          <div className="modal-footer">
            <button onClick={() => setShowEditModal(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleSave}>Save</button>
          </div>
        </div>
      </div>}
    </div>
  );
}
