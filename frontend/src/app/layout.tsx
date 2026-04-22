import type { Metadata } from "next";
import { Inter, Geist } from "next/font/google";
import "./globals.css";
import { NavTabs } from "@/components/nav-tabs";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

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
        <NavTabs />
        {children}
      </body>
    </html>
  );
}