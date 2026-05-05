import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { NavTabs } from "@/components/nav-tabs";
import { ClientShell } from "@/components/ClientShell";

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: "ClawDesk — Agent Orchestration",
  description: "AI Agent Orchestration Platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>
        <ClientShell>
          <NavTabs />
          {children}
        </ClientShell>
      </body>
    </html>
  );
}
