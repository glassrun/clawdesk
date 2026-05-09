"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { getAgents, getProjects, getTasks, type Agent, type Project, type Task } from "@/lib/api";
import { useRouter } from "next/navigation";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const allResults = [
    ...agents.slice(0, 5).map(a => ({ type: "agent" as const, id: a.id, label: a.name, sub: a.status, href: `/agents?id=${a.id}` })),
    ...projects.slice(0, 5).map(p => ({ type: "project" as const, id: p.id, label: p.title, sub: p.status || "active", href: `/projects/${p.id}` })),
    ...tasks.slice(0, 5).map(t => ({ type: "task" as const, id: t.id, label: t.title, sub: t.status, href: `/tasks?id=${t.id}` })),
  ];

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      // load initial results without search
      setAgents([]);
      setProjects([]);
      setTasks([]);
      return;
    }
    setLoading(true);
    try {
      const [agentsData, projectsData, tasksData] = await Promise.all([
        getAgents().catch(() => []),
        getProjects().catch(() => []),
        getTasks({ search: q, limit: "10" }).catch(() => ({ data: [] })),
      ]);
      setAgents(Array.isArray(agentsData) ? agentsData : []);
      setProjects(Array.isArray(projectsData) ? projectsData : []);
      setTasks(Array.isArray(tasksData?.data) ? tasksData.data : []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  const doSearchRef = useRef<{(q: string): Promise<void>} | null>(null);
  doSearchRef.current = doSearch;

  useEffect(() => {
    const timer = setTimeout(() => doSearchRef.current!(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(prev => !prev);
      }
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, allResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const item = allResults[selectedIdx];
      if (item) {
        router.push(item.href);
        setOpen(false);
      }
    }
  };

  const handleClick = (href: string) => {
    router.push(href);
    setOpen(false);
  };

  const sections = [
    { label: "Agents", items: agents.slice(0, 5).map(a => ({ type: "agent" as const, id: a.id, label: a.name, sub: a.status, href: `/agents?id=${a.id}` })) },
    { label: "Projects", items: projects.slice(0, 5).map(p => ({ type: "project" as const, id: p.id, label: p.title, sub: p.status || "active", href: `/projects/${p.id}` })) },
    { label: "Tasks", items: tasks.slice(0, 5).map(t => ({ type: "task" as const, id: t.id, label: t.title, sub: t.status, href: `/tasks?id=${t.id}` })) },
  ];

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(6px)" }}
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="card w-full max-w-2xl mx-4 overflow-hidden"
        style={{ maxHeight: "70vh" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="p-3 border-b border-[var(--border)]">
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setSelectedIdx(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Search agents, projects, tasks..."
            className="w-full bg-transparent outline-none text-base"
            aria-label="Search"
          />
        </div>

        {/* Results */}
        <div className="overflow-y-auto" style={{ maxHeight: "calc(70vh - 60px)" }}>
          {loading ? (
            <div className="p-6 text-center text-muted text-sm">Searching...</div>
          ) : allResults.length === 0 ? (
            <div className="p-6 text-center text-muted text-sm">
              {query ? `No results for "${query}"` : "Start typing to search..."}
            </div>
          ) : (
            sections.map(section => {
              if (section.items.length === 0) return null;
              return (
                <div key={section.label}>
                  <div className="px-3 py-1.5 text-xs font-semibold text-muted uppercase tracking-wider bg-[var(--bg)]">
                    {section.label}
                  </div>
                  {section.items.map((item, idx) => {
                    const globalIdx = sections.indexOf(section) === 0
                      ? idx
                      : sections[0].items.length + (sections.indexOf(section) === 1 ? idx : sections[0].items.length + sections[1].items.length + idx);
                    const isSelected = selectedIdx === globalIdx;
                    const badgeClass = item.type === "agent" ? "badge status-done" :
                                       item.type === "project" ? "badge status-pending" :
                                       "badge status-in_progress";
                    return (
                      <div
                        key={item.id}
                        className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer ${isSelected ? "bg-[var(--bg-hover)]" : ""}`}
                        onClick={() => handleClick(item.href)}
                        onMouseEnter={() => setSelectedIdx(globalIdx)}
                        role="option"
                        aria-selected={isSelected}
                      >
                        <span className={badgeClass} style={{ minWidth: "64px", textAlign: "center" }}>
                          {item.type}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate">{item.label}</div>
                        </div>
                        <span className="text-xs text-muted">{item.sub}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* Footer hint */}
        <div className="px-3 py-2 border-t border-[var(--border)] flex gap-4 text-xs text-muted">
          <span>↑↓ Navigate</span>
          <span>↵ Open</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
}
