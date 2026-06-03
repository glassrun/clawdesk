"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getProject, updateProject, deleteProject, getTasks, createTask, updateTask, deleteTask, runTask, getTaskResults, type Project, type Task } from "@/lib/api";
import { useStream } from "@/lib/useStream";

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

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = Number(params.id);

  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  // Edit modal
  const [showEdit, setShowEdit] = useState(false);
  const [formTitle, setFormTitle] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formStatus, setFormStatus] = useState("active");

  // Task state
  const [showAddTask, setShowAddTask] = useState(false);
  const [addTaskTitle, setAddTaskTitle] = useState("");
  const [addTaskPriority, setAddTaskPriority] = useState("medium");
  const [addTaskCreatesAgent, setAddTaskCreatesAgent] = useState(false);
  const [expandedTaskResults, setExpandedTaskResults] = useState<number | null>(null);
  const [taskResults, setTaskResults] = useState<Record<number, any[]>>({});
  const [runningTask, setRunningTask] = useState<number | null>(null);

  const { lastMessage } = useStream();

  const loadProject = useCallback(async () => {
    try {
      const data = await getProject(projectId);
      setProject(data as Project);
      setTasks(Array.isArray(data.tasks) ? data.tasks : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  useEffect(() => {
    if (!lastMessage) return;
    const ev = lastMessage.event;
    if (ev === "tasks" || ev === "projects") {
      loadProject();
    }
  }, [lastMessage, loadProject]);

  const handleDelete = async () => {
    if (!confirm("Delete this project? This cannot be undone.")) return;
    await deleteProject(projectId);
    router.push("/projects");
  };

  const openEditModal = () => {
    if (!project) return;
    setFormTitle(project.title);
    setFormDesc(project.description || "");
    setFormStatus(project.status || "active");
    setShowEdit(true);
  };

  const handleEditSave = async () => {
    if (!project) return;
    await updateProject(project.id, { title: formTitle, description: formDesc, status: formStatus });
    setShowEdit(false);
    loadProject();
  };

  const handleTaskStatusChange = async (taskId: number, status: string) => {
    await updateTask(taskId, { status });
    loadProject();
  };

  const handleAddTaskSave = async () => {
    if (!addTaskTitle.trim()) return;
    await createTask(projectId, { title: addTaskTitle, priority: addTaskPriority, creates_agent: addTaskCreatesAgent ? project.creates_agent : undefined });
    setShowAddTask(false);
    setAddTaskTitle("");
    setAddTaskPriority("medium");
    setAddTaskCreatesAgent(false);
    loadProject();
  };

  const handleTaskRun = async (taskId: number) => {
    setRunningTask(taskId);
    try {
      await runTask(taskId);
      const results = await getTaskResults(taskId);
      setTaskResults((p) => ({ ...p, [taskId]: results }));
    } catch (e) {
      console.error(e);
    } finally {
      setRunningTask(null);
      loadProject();
    }
  };

  const toggleTaskResults = async (taskId: number) => {
    if (expandedTaskResults === taskId) {
      setExpandedTaskResults(null);
      return;
    }
    const results = await getTaskResults(taskId);
    setTaskResults((p) => ({ ...p, [taskId]: results }));
    setExpandedTaskResults(taskId);
  };

  if (loading) {
    return (
      <div className="page-wrap">
        <div className="text-center text-muted py-16">Loading…</div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="page-wrap">
        <div className="text-center text-muted py-16">Project not found.</div>
        <div className="text-center">
          <Link href="/projects" className="btn">← Back to Projects</Link>
        </div>
      </div>
    );
  }

  const doneTasks = tasks.filter((t) => t.status === "done").length;
  const completionPct = tasks.length > 0 ? Math.round((doneTasks / tasks.length) * 100) : 0;

  return (
    <div className="page-wrap">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/projects" className="btn-sm">←</Link>
          <h1>{project.title}</h1>
          {project.is_template ? <span className="badge">📋 template</span> : null}
          {project.creates_agent ? <span className="badge" title={`Agent: ${project.creates_agent}`}>🤖 agent</span> : null}
          <span className={`badge ${project.status === "active" ? "status-in_progress" : project.status === "completed" ? "status-done" : "status-failed"}`}>
            {project.status}
          </span>
        </div>
        <div className="flex gap-2">
          <button className="btn-sm" onClick={() => openEditModal()}>✏️ Edit</button>
          <div style={{ position: "relative" }}>
            <button className="btn-sm" onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}>⋮</button>
            {menuOpen && (
              <div
                style={{
                  position: "absolute", right: 0, top: "100%", zIndex: 10,
                  minWidth: "160px", background: "var(--bg-card)", border: "1px solid var(--border)",
                  borderRadius: "8px", padding: "4px 0", boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <button className="dropdown-item w-full" onClick={() => { setMenuOpen(false); router.push(`/projects/${projectId}/stats`); }}>📊 Stats</button>
                <hr style={{ borderColor: "var(--border)", margin: "4px 0" }} />
                <button className="dropdown-item w-full text-red-400" onClick={() => { setMenuOpen(false); handleDelete(); }}>🗑️ Delete</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {project.description && <p className="text-muted mt-2">{project.description}</p>}
      {project.workspace_path && <p className="text-xs text-soft mt-1">📁 {project.workspace_path}</p>}
      {project.creates_agent && <p className="text-xs text-soft mt-1">🤖 Agent: <code>{project.creates_agent}</code></p>}

      {/* Progress bar */}
      <div className="card mt-4">
        <div className="card-content">
          <div className="flex justify-between text-xs text-muted mb-2">
            <span>{doneTasks}/{tasks.length} tasks done</span>
            <span>{completionPct}%</span>
          </div>
          <div className="w-full h-2 rounded bg-[var(--bg-hover)] overflow-hidden">
            <div
              className="h-full rounded"
              style={{ width: `${completionPct}%`, background: completionPct === 100 ? "var(--success)" : "var(--primary)" }}
            />
          </div>
        </div>
      </div>

      {/* Tasks section */}
      <div className="card mt-4">
        <div className="card-content">
          <div className="flex items-center justify-between mb-4">
            <h2>Tasks <span className="text-muted text-sm">({tasks.length})</span></h2>
            <button className="btn-primary btn-sm" onClick={() => setShowAddTask(true)}>+ Add Task</button>
          </div>

          {tasks.length === 0 ? (
            <div className="text-center text-muted py-6">No tasks in this project.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="p-3">ID</th>
                    <th className="p-3">Title</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Priority</th>
                    <th className="p-3">Agent</th>
                    <th className="p-3">Created</th>
                    <th className="p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <React.Fragment key={t.id}>
                      <tr>
                        <td className="p-3 text-xs text-muted">#{t.id}</td>
                        <td className="p-3 max-w-xs truncate">{t.title}</td>
                        <td className="p-3">
                          <select
                            value={t.status}
                            onChange={(e) => handleTaskStatusChange(t.id, e.target.value)}
                            className="w-32"
                          >
                            <option value="pending">pending</option>
                            <option value="in_progress">in progress</option>
                            <option value="done">done</option>
                            <option value="failed">failed</option>
                          </select>
                        </td>
                        <td className="p-3">
                          <span className={`badge priority-${t.priority || "medium"}`}>{t.priority || "medium"}</span>
                        </td>
                        <td className="p-3 text-sm">{t.agent_name || <span className="text-soft">—</span>}</td>
                        <td className="p-3 text-xs text-soft">{timeAgo(t.created_at)}</td>
                        <td className="p-3">
                          <div className="flex gap-1">
                            <button className="btn-sm" onClick={() => handleTaskRun(t.id)} disabled={runningTask === t.id}>
                              {runningTask === t.id ? "⏳" : "▶"}
                            </button>
                            <button className="btn-sm" onClick={() => toggleTaskResults(t.id)}>📄</button>
                            <button className="btn-sm danger" onClick={() => { if (confirm("Delete?")) deleteTask(t.id).then(loadProject); }}>🗑️</button>
                          </div>
                        </td>
                      </tr>
                      {expandedTaskResults === t.id && taskResults[t.id] && (
                        <tr>
                          <td colSpan={7} className="p-3" style={{ background: "var(--bg)" }}>
                            <div className="max-h-40 overflow-y-auto text-xs">
                              {taskResults[t.id].length === 0 ? (
                                <div className="text-soft">No results</div>
                              ) : (
                                taskResults[t.id].map((r: any, i: number) => (
                                  <div key={i} className="border-b pb-2 mb-2">
                                    <div className="text-soft">{new Date(r.executed_at).toLocaleString()}</div>
                                    <pre className="whitespace-pre-wrap">{r.output?.slice(0, 500)}</pre>
                                  </div>
                                ))
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Edit Project Modal */}
      {showEdit && (
        <div className="modal-overlay" onClick={() => setShowEdit(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Edit Project</h3></div>
            <div>
              <label>Title</label>
              <input value={formTitle} onChange={(e) => setFormTitle(e.target.value)} />
              <label>Description</label>
              <textarea value={formDesc} onChange={(e) => setFormDesc(e.target.value)} rows={3} />
              <label>Status</label>
              <select value={formStatus} onChange={(e) => setFormStatus(e.target.value)}>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
              </select>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowEdit(false)}>Cancel</button>
              <button className="btn-primary" onClick={handleEditSave}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Add Task Modal */}
      {showAddTask && (
        <div className="modal-overlay" onClick={() => setShowAddTask(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h3>Add Task</h3></div>
            <div>
              <label>Title</label>
              <input value={addTaskTitle} onChange={(e) => setAddTaskTitle(e.target.value)} placeholder="Task title" />
              <label>Priority</label>
              <select value={addTaskPriority} onChange={(e) => setAddTaskPriority(e.target.value)}>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
              {project.creates_agent && (
                <label className="flex items-center gap-2 mt-2 cursor-pointer">
                  <input type="checkbox" checked={addTaskCreatesAgent} onChange={(e) => setAddTaskCreatesAgent(e.target.checked)} />
                  <span className="text-sm">🤖 Create agent for this task</span>
                  <span className="text-xs text-muted">agent ID: {project.creates_agent}</span>
                </label>
              )}
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowAddTask(false)}>Cancel</button>
              <button className="btn-primary" onClick={handleAddTaskSave}>Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}