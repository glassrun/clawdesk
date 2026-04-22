"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export type StreamEvent = "tasks" | "heartbeat" | "connected";

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
    const proto = window.location.protocol === "https:" ? "https:" : "http:";
    const host = window.location.host;
    const url = `${proto}//${host}/api/stream`;
    const es = new EventSource(url);
    esRef.current = es;

    const onConnected = () => setConnected(true);
    const onTasks = (e: MessageEvent) => setLastMessage({ event: "tasks", data: JSON.parse(e.data), ts: Date.now() });
    const onHeartbeat = (e: MessageEvent) => setLastMessage({ event: "heartbeat", data: JSON.parse(e.data), ts: Date.now() });

    es.addEventListener("connected", onConnected);
    es.addEventListener("tasks", onTasks);
    es.addEventListener("heartbeat", onHeartbeat);
    es.onerror = () => setConnected(false);

    return () => {
      es.removeEventListener("connected", onConnected);
      es.removeEventListener("tasks", onTasks);
      es.removeEventListener("heartbeat", onHeartbeat);
      es.close();
      setConnected(false);
    };
  }, []);

  return { lastMessage, connected };
}
