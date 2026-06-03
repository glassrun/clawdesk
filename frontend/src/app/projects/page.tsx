"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getProjects, createProject, deleteProject, updateProject, cloneProject, getProjectTemplates, type Project } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

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
  const router = useRouter();
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formStatus, setFormStatus] = useState("active");
  const [formIsTemplate, setFormIsTemplate] = useState(0);
  const [formCreatesAgent, setFormCreatesAgent] = useState(false);
  const [formCreatesAgentEdit, setFormCreatesAgentEdit] = useState(false);
  const [addTab, setAddTab] = useState<"blank" | "template">("blank");
  const [menuOpen, setMenuOpen] = useState<number | null>(null);

  const { data: projectsData, refetch: refetchProjects } = useQuery({
    queryKey: ["projects"],
    queryFn: () => getProjects(),
  });

  const { data: templatesData } = useQuery({
    queryKey: ["project-templates"],
    queryFn: () => getProjectTemplates(),
  });

  const projects = projectsData?.projects ?? [];
  const templates = templatesData ?? [];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuOpen !== null) setMenuOpen(null);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [menuOpen]);

  const handleAdd = async () => {
    if (!formTitle.trim()) return;
    await createProject({ title: formTitle, description: formDesc, status: formStatus, is_template: formIsTemplate || undefined, creates_agent: formCreatesAgent ? formTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : undefined });
    setShowAddModal(false);
    setFormTitle(""); setFormDesc(""); setFormStatus("active"); setFormIsTemplate(0); setFormCreatesAgent(false);
    refetchProjects();
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this project?")) return;
    await deleteProject(id);
    refetchProjects();
  };

  const handleCloneAsTemplate = async (id: number) => {
    setMenuOpen(null);
    const p = projects.find(x => x.id === id);
    if (!p) return;
    await createProject({
      title: p.title + " (template)",
      description: p.description,
      status: "active",
      is_template: 1,
    });
    refetchProjects();
  };

  const handleClone = async (id: number) => {
    setMenuOpen(null);
    await cloneProject(id);
    refetchProjects();
  };

  const openEditModal = (project: Project) => {
    setEditProject(project);
    setFormTitle(project.title);
    setFormDesc(project.description || "");
    setFormStatus(project.status || "active");
    setFormIsTemplate(project.is_template ? 1 : 0);
    setFormCreatesAgentEdit(!!project.creates_agent);
    setShowEditModal(true);
  };

  const handleEditSave = async () => {
    if (!editProject) return;
    await updateProject(editProject.id, { title: formTitle, description: formDesc, status: formStatus, is_template: formIsTemplate || undefined, creates_agent: formCreatesAgentEdit ? formTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : null });
    setShowEditModal(false);
    refetchProjects();
  };

  const handleCreateFromTemplate = async (templateId: number) => {
    setMenuOpen(null);
    await cloneProject(templateId);
    refetchProjects();
    setShowAddModal(false);
  };

  return (
    <div className="page-wrap">
      <div className="flex items-center justify-between">
        <h1>All Projects</h1>
        <button className="btn-primary" onClick={() => { setAddTab("blank"); setShowAddModal(true); }}>+ Add Project</button>
      </div>

      {projects.length === 0 ? <div className="text-center text-muted py-8">No projects</div> :
      <div className="flex gap-3 flex-wrap mt-4">
        {projects.map(p => (
          <div key={p.id} className="card" style={{minWidth: '280px', flex: '1 1 300px', overflow: 'visible', cursor: 'pointer'}} onClick={() => router.push(`/projects/${p.id}`)}>
            <div className="card-content">
              <div className="flex items-center justify-between pb-2">
                <div className="flex items-center gap-2">
                  <h3>{p.title}</h3>
                  {p.is_template ? <span title="Template project" className="text-lg">📋</span> : null}
                  {p.creates_agent ? <span title={`Agent: ${p.creates_agent}`} className="text-lg">🤖</span> : null}
                </div>
                <div className="flex gap-1">
                  <div style={{ position: "relative", overflow: "visible" }} onClick={e => e.stopPropagation()}>
                    <button className="btn-sm" onClick={(e) => { e.stopPropagation(); setMenuOpen(menuOpen === p.id ? null : p.id); }}>⋮</button>
                    {menuOpen === p.id && (
                      <div className="dropdown-menu">
                        <button className="dropdown-item" onClick={() => { setMenuOpen(null); window.location.href = `/projects/${p.id}`; }}>📂 Open</button>
                        <button className="dropdown-item" onClick={() => openEditModal(p)}>✏️ Edit</button>
                        <button className="dropdown-item" onClick={() => handleClone(p.id)}>📄 Clone</button>
                        <button className="dropdown-item" onClick={() => handleCloneAsTemplate(p.id)}>📋 Clone as Template</button>
                        <hr style={{ borderColor: "var(--border)", margin: "4px 0" }} />
                        <button className="dropdown-item text-red-400" onClick={() => handleDelete(p.id)}>🗑️ Delete</button>
                      </div>
                    )}
                  </div>
                </div>
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
          <div className="flex gap-1 mb-4">
            <button className={`btn-sm ${addTab === "blank" ? "primary" : ""}`} onClick={() => setAddTab("blank")}>Blank Project</button>
            <button className={`btn-sm ${addTab === "template" ? "primary" : ""}`} onClick={() => setAddTab("template")}>From Template</button>
          </div>
          {addTab === "blank" ? (
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
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input type="checkbox" checked={formIsTemplate === 1} onChange={(e) => setFormIsTemplate(e.target.checked ? 1 : 0)} />
                <span className="text-sm">Save as template</span>
                <span className="text-xs text-muted">📋</span>
              </label>
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input type="checkbox" checked={formCreatesAgentEdit} onChange={(e) => setFormCreatesAgentEdit(e.target.checked)} />
                <span className="text-sm">🤖 Create agent for this project</span>
              </label>
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input type="checkbox" checked={formCreatesAgent} onChange={(e) => setFormCreatesAgent(e.target.checked)} />
                <span className="text-sm">🤖 Create agent for this project</span>
                <span className="text-xs text-muted">agent shares project workspace</span>
              </label>
            </div>
          ) : (
            <div>
              <p className="text-sm text-muted mb-3">Select a template to create a new project from:</p>
              {templates.length === 0 ? (
                <div className="text-center text-muted py-6">No templates yet. Create a project and save it as template.</div>
              ) : (
                <div className="flex gap-2 flex-wrap">
                  {templates.map(t => (
                    <div key={t.id} className="card cursor-pointer hover:border-[var(--primary)]" style={{minWidth: "200px", flex: "1 1 200px"}} onClick={() => handleCreateFromTemplate(t.id)}>
                      <div className="card-content">
                        <div className="flex items-center gap-2">
                          <span className="text-lg">📋</span>
                          <span className="font-medium text-sm">{t.title}</span>
                        </div>
                        <p className="text-xs text-muted mt-1">{t.description || "No description"}</p>
                        <p className="text-xs text-soft mt-1">{t.task_total || 0} tasks</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="modal-footer">
            <button onClick={() => setShowAddModal(false)}>Cancel</button>
            {addTab === "blank" && <button className="btn-primary" onClick={handleAdd}>Add</button>}
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
            <label className="flex items-center gap-2 mt-2 cursor-pointer">
              <input type="checkbox" checked={formIsTemplate === 1} onChange={(e) => setFormIsTemplate(e.target.checked ? 1 : 0)} />
              <span className="text-sm">Save as template</span>
              <span className="text-xs text-muted">📋</span>
            </label>
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
