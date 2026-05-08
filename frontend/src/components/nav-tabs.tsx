"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/dashboard", label: "🎯 Dashboard" },
  { href: "/agents", label: "🤖 Agents" },
  { href: "/projects", label: "📁 Projects" },
  { href: "/tasks", label: "📋 Tasks" },
  { href: "/heartbeats", label: "💓 Heartbeats" },
  { href: "/audit", label: "📊 Audit" },
  { href: "/system/stats", label: "⚙️ System" },
  { href: "/billing", label: "💰 Billing" },
  { href: "/tools", label: "🔧 Tools" },
];

export function NavTabs() {
  const pathname = usePathname();

  return (
    <nav className="nav-wrap">
      <div className="nav-inner overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = pathname === tab.href || (tab.href !== "/dashboard" && pathname.startsWith(tab.href));
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`nav-link shrink-0 ${isActive ? "active" : ""}`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
