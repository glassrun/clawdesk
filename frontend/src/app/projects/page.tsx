"use client";

import React, { useEffect, useState } from "react";
import { getProjects, createProject, deleteProject, updateProject, type Project } from "@/lib/api";

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

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formStatus, setFormStatus] = useState("active");

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await getProjects();
      setProjects(res);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  const handleAdd = async () => {
    if (!formTitle.trim()) return;
    await createProject({ title: formTitle, description: formDesc });
    setShowAddModal(false);
    setFormTitle(""); setFormDesc("");
    loadData();
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this project?")) return;
    await deleteProject(id);
    loadData();
  };


  const openEditModal = (project: Project) => {
    setEditProject(project);
    setFormTitle(project.title);
    setFormDesc(project.description || "");
    setFormStatus(project.status || "active");
    setShowEditModal(true);
  };


  const handleEditSave = async () => {
    if (!editProject) return;
    await updateProject(editProject.id, { title: formTitle, description: formDesc, status: formStatus });
    setShowEditModal(false);
    loadData();
  };

  return (
    <div className="page-wrap">
      <div className="flex items-center justify-between">
        <h1>All Projects</h1>
        <button className="btn-primary" onClick={() => setShowAddModal(true)}>+ Add Project</button>
      </div>


      {loading ? <div className="text-center text-muted py-8">Loading...</div> :
      projects.length === 0 ? <div className="text-center text-muted py-8">No projects</div> :
      <div className="flex gap-3 flex-wrap mt-4">
        {projects.map(p => (
          <div key={p.id} className="card" style={{minWidth: '280px', flex: '1 1 300px'}}>
            <div className="card-content">
              <div className="flex items-center justify-between pb-2">
                <h3>{p.title}</h3>
                <button className="btn-sm danger" onClick={() => handleDelete(p.id)}>🗑️</button>
                <button className="btn-sm" onClick={() => openEditModal(p)}>✏️</button>
              </div>
              <p className="text-sm text-muted">{p.description || "No description"}</p>
              {p.workspace_path && <p className="text-xs text-soft mt-2">📁 {p.workspace_path}</p>}
              <div className="flex gap-2 mt-3 text-xs">
                <span className={p.task_done === p.task_total ? "text-green" : "text-yellow"}>
                  {p.task_done || 0}/{p.task_total || 0} done
                </span>
                {p.task_total && p.task_total > 0 && <span className="text-soft">{p.completion_pct}%</span>}
              </div>
              <p className="text-xs text-soft mt-2">Created {timeAgo(p.created_at)}</p>
            </div>
          </div>
        ))}
      </div>}


      {showAddModal && <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
        <div className="modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header"><h3>Add Project</h3></div>
          <div>
            <label>Title</label>
            <input value={formTitle} onChange={(e) => setFormTitle(e.target.value)} placeholder="Project title" />
            <label>Description</label>
            <textarea value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder="Description" rows={3} />
          </div>
          <div className="modal-footer">
            <button onClick={() => setShowAddModal(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleAdd}>Add</button>
          </div>
        </div>
      </div>}

      {showEditModal && <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
        <div className="modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header"><h3>Edit Project</h3></div>
          <div>
            <label>Title</label>
            <input value={formTitle} onChange={(e) => setFormTitle(e.target.value)} placeholder="Project title" />
            <label>Description</label>
            <textarea value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder="Description" rows={3} />
            <label>Status</label>
            <select value={formStatus} onChange={e => setFormStatus(e.target.value)}>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>
          </div>
          <div className="modal-footer">
            <button onClick={() => setShowEditModal(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleEditSave}>Save</button>
          </div>
        </div>
      </div>}
    </div>
  );
}
