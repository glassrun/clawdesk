"use client";

import React from "react";

export interface TaskNode {
  id: number;
  title: string;
  status: string;
  priority: string;
}

interface DependencyGraphProps {
  task: TaskNode;
  dependencies: TaskNode[];   // tasks this one depends on (chain backward)
  dependents: TaskNode[];    // tasks blocked by this one
  onClose?: () => void;
}

const NODE_W = 160;
const NODE_H = 52;
const GAP_X = 60;
const GAP_Y = 20;

const STATUS_COLORS: Record<string, string> = {
  pending:    "var(--warning)",
  in_progress:"#3b82f6",
  done:       "var(--success)",
  failed:     "var(--danger)",
};

const PRIORITY_COLORS: Record<string, string> = {
  high:   "var(--danger)",
  medium: "var(--warning)",
  low:    "var(--success)",
};

function truncate(str: string, len: number) {
  return str.length > len ? str.slice(0, len - 1) + "…" : str;
}

export function DependencyGraph({ task, dependencies, dependents, onClose }: DependencyGraphProps) {
  // Layout: [deps...] → [task] → [dependents...]
  const allNodes = [...dependencies, task, ...dependents];
  const taskIdx = dependencies.length; // index of "this task" in the array

  // SVG dimensions
  const totalW = allNodes.length * NODE_W + (allNodes.length - 1) * GAP_X;
  const svgW = Math.max(totalW + 40, 600);
  const svgH = NODE_H + 80;

  // Node X positions
  const nodeX = (idx: number) => 20 + idx * (NODE_W + GAP_X);

  // Arrow path from node i to node j (i < j)
  const arrowPath = (fromIdx: number, toIdx: number) => {
    const x1 = nodeX(fromIdx) + NODE_W;
    const y1 = svgH / 2;
    const x2 = nodeX(toIdx);
    const y2 = svgH / 2;
    // Simple straight arrow
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}>
      <div className="card max-w-4xl w-full mx-4" style={{ maxHeight: "80vh", overflow: "auto" }}>
        <div className="card-content">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold">Dependency Graph — #{task.id}</h2>
            <button className="btn-sm" onClick={onClose}>✕ Close</button>
          </div>
          <p className="text-sm text-muted mb-4">← Dependencies &nbsp;&nbsp;|&nbsp;&nbsp; This Task &nbsp;&nbsp;|&nbsp;&nbsp; Dependents →</p>
          <div className="overflow-x-auto">
            <svg
              width={svgW}
              height={svgH}
              style={{ minWidth: svgW }}
              aria-label="Task dependency graph"
            >
              <defs>
                <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="var(--muted)" />
                </marker>
              </defs>

              {/* Draw arrows between consecutive nodes */}
              {allNodes.map((_, idx) => {
                if (idx === taskIdx) return null; // skip arrow before the center task if you want
                return (
                  <path
                    key={`arrow-${idx}`}
                    d={arrowPath(Math.min(idx, taskIdx), Math.max(idx, taskIdx))}
                    stroke="var(--muted)"
                    strokeWidth={1.5}
                    fill="none"
                    markerEnd="url(#arrowhead)"
                    opacity={0.6}
                  />
                );
              })}

              {/* Draw nodes */}
              {allNodes.map((node, idx) => {
                const isCenter = idx === taskIdx;
                const x = nodeX(idx);
                const y = (svgH - NODE_H) / 2;
                const statusColor = STATUS_COLORS[node.status] || "var(--muted)";
                const prioColor = PRIORITY_COLORS[node.priority] || "var(--muted)";

                return (
                  <g key={node.id}>
                    {/* Priority indicator stripe */}
                    <rect x={x} y={y} width={6} height={NODE_H} rx={3} fill={prioColor} opacity={0.8} />
                    {/* Node background */}
                    <rect
                      x={x + 6}
                      y={y}
                      width={NODE_W - 6}
                      height={NODE_H}
                      rx={8}
                      fill={isCenter ? "var(--bg-hover)" : "var(--surface2)"}
                      stroke={isCenter ? statusColor : "var(--border)"}
                      strokeWidth={isCenter ? 2 : 1}
                    />
                    {/* Status dot */}
                    <circle cx={x + 20} cy={y + NODE_H / 2} r={5} fill={statusColor} />
                    {/* Title */}
                    <text
                      x={x + 32}
                      y={y + NODE_H / 2 - 4}
                      className="text-xs"
                      fill="var(--fg)"
                      fontSize={11}
                      fontFamily="var(--font-sans)"
                    >
                      {truncate(node.title, 22)}
                    </text>
                    {/* ID + priority */}
                    <text
                      x={x + 32}
                      y={y + NODE_H / 2 + 10}
                      fill="var(--muted)"
                      fontSize={9}
                      fontFamily="monospace"
                    >
                      #{node.id} · {node.priority}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
