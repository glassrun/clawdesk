"use client";

import { useEffect, useRef, useState } from "react";
import { API_BASE } from "./api";

export type StreamEvent = "tasks" | "heartbeat" | "connected" | "agents" | "projects" | "task_output" | "task_done" | "workflow_started" | "workflow_step_started" | "workflow_step_done" | "workflow_step_error" | "workflow_done";

export interface StreamMessage {
  event: StreamEvent;
  data: any;
  ts: number;
}

export function useStream() {
  const [lastMessage, setLastMessage] = useState<StreamMessage | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const url = `${API_BASE}/api/stream`;
    const es = new EventSource(url);
    esRef.current = es;

    const onConnected = () => setConnected(true);
    const onTasks = (e: MessageEvent) => setLastMessage({ event: "tasks", data: JSON.parse(e.data), ts: Date.now() });
    const onHeartbeat = (e: MessageEvent) => setLastMessage({ event: "heartbeat", data: JSON.parse(e.data), ts: Date.now() });
    const onAgents = (e: MessageEvent) => setLastMessage({ event: "agents", data: JSON.parse(e.data), ts: Date.now() });
    const onProjects = (e: MessageEvent) => setLastMessage({ event: "projects", data: JSON.parse(e.data), ts: Date.now() });
    const onTaskOutput = (e: MessageEvent) => setLastMessage({ event: "task_output", data: JSON.parse(e.data), ts: Date.now() });
    const onTaskDone = (e: MessageEvent) => setLastMessage({ event: "task_done", data: JSON.parse(e.data), ts: Date.now() });

    es.addEventListener("connected", onConnected);
    es.addEventListener("tasks", onTasks);
    es.addEventListener("heartbeat", onHeartbeat);
    es.addEventListener("agents", onAgents);
    es.addEventListener("projects", onProjects);
    es.addEventListener("task_output", onTaskOutput);
    es.addEventListener("task_done", onTaskDone);
    es.onerror = () => setConnected(false);

    return () => {
      es.removeEventListener("connected", onConnected);
      es.removeEventListener("tasks", onTasks);
      es.removeEventListener("heartbeat", onHeartbeat);
      es.removeEventListener("agents", onAgents);
      es.removeEventListener("projects", onProjects);
      es.removeEventListener("task_output", onTaskOutput);
      es.removeEventListener("task_done", onTaskDone);
      es.close();
      setConnected(false);
    };
  }, []);

  return { lastMessage, connected };
}

// Hook for task-specific streaming (live stdout/stderr per task)
export function useTaskStream(taskId: number | null) {
  const [lastChunk, setLastChunk] = useState<{ task_id: number; chunk: string; type: string; ts: number } | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (taskId === null) return;

    const url = `${API_BASE}/api/stream/task/${taskId}`;
    const es = new EventSource(url);
    esRef.current = es;

    const onConnected = () => setConnected(true);
    const onTaskOutput = (e: MessageEvent) => setLastChunk(JSON.parse(e.data));
    const onTaskDone = (e: MessageEvent) => setLastChunk({ ...JSON.parse(e.data), _done: true });

    es.addEventListener("connected", onConnected);
    es.addEventListener("task_output", onTaskOutput);
    es.addEventListener("task_done", onTaskDone);
    es.onerror = () => setConnected(false);

    return () => {
      es.removeEventListener("connected", onConnected);
      es.removeEventListener("task_output", onTaskOutput);
      es.removeEventListener("task_done", onTaskDone);
      es.close();
      setConnected(false);
    };
  }, [taskId]);

  return { lastChunk, connected };
}