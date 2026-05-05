"use client";

import { QueryProvider } from "@/lib/queryProvider";
import { CommandPalette } from "@/components/CommandPalette";
import { useGlobalStream } from "@/lib/useGlobalStream";

function StreamInitializer() {
  useGlobalStream();
  return null;
}

export function ClientShell({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <StreamInitializer />
      <CommandPalette />
      {children}
    </QueryProvider>
  );
}
