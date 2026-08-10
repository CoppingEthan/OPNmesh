import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "OPNmesh",
  description: "Self-hosted WireGuard mesh management",
};

const NAV = [
  ["/", "Dashboard"],
  ["/nodes", "Nodes"],
  ["/clients", "Clients"],
  ["/traffic", "Traffic"],
  ["/config", "Config"],
  ["/routes", "Routes"],
  ["/updates", "Updates"],
  ["/alerts", "Alerts"],
  ["/settings", "Settings"],
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <aside className="w-44 shrink-0 border-r border-zinc-800 bg-zinc-950 p-3">
            <div className="mb-4 px-2">
              <span className="text-sm font-bold tracking-widest text-emerald-400">OPN</span>
              <span className="text-sm font-bold tracking-widest text-zinc-100">MESH</span>
            </div>
            <nav className="space-y-0.5">
              {NAV.map(([href, label]) => (
                <Link
                  key={href}
                  href={href}
                  className="block rounded px-2 py-1.5 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                >
                  {label}
                </Link>
              ))}
            </nav>
          </aside>
          <main className="min-w-0 flex-1 p-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
