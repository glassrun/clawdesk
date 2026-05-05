"use client";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStream } from "./useStream";

export function useGlobalStream() {
  const qc = useQueryClient();
  const { lastMessage } = useStream();

  useEffect(() => {
    if (!lastMessage) return;
    switch (lastMessage.event) {
      case "tasks":    qc.invalidateQueries({ queryKey: ["tasks"] }); break;
      case "agents":   qc.invalidateQueries({ queryKey: ["agents"] }); break;
      case "projects":  qc.invalidateQueries({ queryKey: ["projects"] }); break;
      case "heartbeat": qc.invalidateQueries({ queryKey: ["heartbeats"] }); break;
    }
  }, [lastMessage, qc]);
}