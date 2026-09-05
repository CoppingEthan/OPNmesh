import { Activity, Building2, ClipboardList, Laptop, LayoutDashboard, Settings } from "lucide-react";
import Link from "next/link";
import { APP_VERSION } from "@/server/env";
import { requireAdmin } from "@/server/session";
import { buildState } from "@/server/state";
import { Logo } from "@/ui/logo";
import { NavLink, NavSection } from "@/ui/nav-link";
import { StatusBar } from "@/ui/status-bar";
import { summarise } from "@/ui/status-summary";
import { UserChip } from "@/ui/user-chip";

export const dynamic = "force-dynamic";

/** The dashboard sits on its own; everything else is grouped by what it is for. */
const DASHBOARD = { href: "/", label: "Overview", icon: LayoutDashboard };
const GROUPS: Array<{ title: string; items: Array<{ href: string; label: string; icon: typeof Activity; tone?: string }> }> = [
  {
    title: "Network",
    items: [
      { href: "/sites", label: "Sites", icon: Building2, tone: "var(--series-1)" },
      { href: "/clients", label: "Clients", icon: Laptop, tone: "var(--series-7)" },
    ],
  },
  {
    title: "Monitoring",
    items: [
      { href: "/traffic", label: "Traffic", icon: Activity, tone: "var(--series-3)" },
      { href: "/events", label: "Events", icon: ClipboardList, tone: "var(--series-4)" },
    ],
  },
  {
    title: "Administration",
    items: [{ href: "/settings", label: "Settings", icon: Settings }],
  },
];
const ALL = [DASHBOARD, ...GROUPS.flatMap((g) => g.items)];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  const status = summarise(buildState(), APP_VERSION);
  return (
    <div className="flex min-h-screen">
      <aside className="glass-panel sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-line md:flex">
        <div className="px-4 pb-4 pt-6">
          <Link href="/" aria-label="Overview" className="inline-block">
            <Logo height={30} />
          </Link>
        </div>
        <div className="mx-4 border-t border-line" />
        <nav className="flex-1 overflow-y-auto px-3 pb-4 pt-3">
          <NavLink href={DASHBOARD.href} label={DASHBOARD.label} icon={<DASHBOARD.icon className="h-[18px] w-[18px]" />} />
          {GROUPS.map((g) => (
            <div key={g.title}>
              <NavSection>{g.title}</NavSection>
              <div className="space-y-0.5">
                {g.items.map((n) => (
                  <NavLink key={n.href} href={n.href} label={n.label} icon={<n.icon className="h-[18px] w-[18px]" />} tone={n.tone} />
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t border-line p-3">
          <UserChip email={admin.email} />
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="glass-panel sticky top-0 z-10 flex items-center justify-between border-b border-line px-4 py-3 md:hidden">
          <Link href="/" aria-label="Overview" className="inline-block">
            <Logo height={22} />
          </Link>
          <nav className="flex gap-3 text-sm text-ink-2">
            {ALL.map((n) => (
              <Link key={n.href} href={n.href}>
                {n.label}
              </Link>
            ))}
          </nav>
        </header>
        <StatusBar initial={status} />
        <main className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
