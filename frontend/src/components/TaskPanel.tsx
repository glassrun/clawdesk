"use client";

import React, { useState, useEffect } from "react";
import { runTask, getTaskResults, type Task } from "@/lib/api";

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

interface TaskPanelProps {
  task: Task;
  isRunning: boolean;
  onClose: () => void;
  onRun: (taskId: number) => void;
  onDone: (taskId: number) => void;
}

type RunStatus = "idle" | "running" | "done" | "failed";

export function TaskPanel({ task, isRunning, onClose, onRun, onDone }: TaskPanelProps) {
  const [status, setStatus] = useState<RunStatus>(isRunning ? "running" : "idle");
  const [output, setOutput] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [usage, setUsage] = useState<{ input: number; output: number; cache: number; cost: number } | null>(null);

  // Keep status in sync if parent says the task is still running
  useEffect(() => {
    if (isRunning && status === "idle") {
      setStatus("running");
      setOutput("");
      setError(null);
      setUsage(null);
      setDurationMs(null);
    }
  }, [isRunning]);

  const handleRun = async () => {
    setStatus("running");
    setOutput("");
    setError(null);
    setUsage(null);
    setDurationMs(null);
    onRun(task.id);
    const start = Date.now();

    try {
      await runTask(task.id);
      const results = await getTaskResults(task.id);
      const elapsed = Date.now() - start;
      setDurationMs(elapsed);

      const latest = results.find((r: any) => r.task_id === task.id) as any;
      if (latest) {
        setOutput(latest.output || "(no output)");
        if (latest.input_tokens != null) {
          setUsage({
            input: latest.input_tokens,
            output: latest.output_tokens,
            cache: latest.cache_read_tokens,
            cost: latest.cost,
          });
        }
        setStatus("done");
      onDone(task.id);
      } else {
        setOutput(results[0]?.output || "(no result recorded)");
        setStatus(results[0]?.status === "failed" ? "failed" : "done");
      }
    } catch (e: any) {
      setError(e.message || "Run failed");
      setStatus("failed");
      onDone(task.id);
    }
  };

  return (
    <div style={{
      position: "fixed", bottom: 20, right: 20, width: 540, maxHeight: "70vh",
      background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12,
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)", display: "flex", flexDirection: "column",
      zIndex: 1000, overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</div>
          <div style={{ fontSize: 11, color: "var(--text-soft)", marginTop: 2 }}>
            {status === "idle" && <span>Ready — click Run to execute</span>}
            {status === "running" && <span style={{ color: "var(--warning)" }}>⏳ Running…</span>}
            {status === "done" && <span style={{ color: "var(--success)" }}>✅ Done</span>}
            {status === "failed" && <span style={{ color: "var(--danger)" }}>❌ Failed</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {status === "idle" && <button className="btn-sm" style={{ background: "var(--success)", color: "#fff" }} onClick={handleRun}>▶ Run</button>}
          {status === "running" && <button className="btn-sm" style={{ opacity: 0.5 }}>⏳</button>}
          <button className="btn-sm" onClick={onClose}>✕</button>
        </div>
      </div>

      {/* Running spinner */}
      {status === "running" && (
        <div style={{ padding: "16px", textAlign: "center", color: "var(--text-soft)" }}>
          <div className="spinner" style={{ margin: "0 auto 8px" }} />
          <span style={{ fontSize: 12 }}>Executing task…</span>
        </div>
      )}

      {/* Output */}
      {(status === "done" || status === "failed") && output && (
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", fontFamily: "monospace", fontSize: 12, background: "var(--bg)", minHeight: 160 }}>
          {error && <div style={{ color: "var(--danger)", marginBottom: 8, fontSize: 11 }}>Error: {error}</div>}
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.5, color: "var(--fg)" }}>{output}</div>
        </div>
      )}

      {/* Idle state hint */}
      {status === "idle" && (
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 16px", textAlign: "center", color: "var(--text-soft)", fontSize: 12 }}>
          Click <strong>Run</strong> to execute this task. Results will appear here.
        </div>
      )}

      {/* Usage footer */}
      {(status === "done" || status === "failed") && (
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", background: "var(--bg-hover)" }}>
          <div style={{ display: "flex", gap: 16, fontSize: 11, fontFamily: "monospace", flexWrap: "wrap" }}>
            {durationMs !== null && (
              <span>⏱ {(durationMs / 1000).toFixed(1)}s</span>
            )}
            {usage && (
              <>
                <span>In: {fmtTokens(usage.input)}</span>
                <span>Out: {fmtTokens(usage.output)}</span>
                <span>Cache: {fmtTokens(usage.cache)}</span>
                <span style={{ color: "var(--success)", fontWeight: 600 }}>{fmtCost(usage.cost)}</span>
              </>
            )}
            {!usage && status === "done" && <span style={{ color: "var(--text-soft)" }}>Usage data unavailable</span>}
          </div>
        </div>
      )}
    </div>
  );
}