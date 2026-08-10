import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "OPNmesh",
  description: "Self-hosted WireGuard mesh management",
};

/** Plain-language navigation: what the page is for, not what it is called. */
const NAV = [
  ["/", "Overview", "Is everything working?"],
  ["/nodes", "Locations", "Add and manage sites"],
  ["/clients", "Remote devices", "Laptops and phones"],
  ["/traffic", "Traffic", "What is moving where"],
  ["/routes", "Router setup", "What to type into each router"],
  ["/config", "Generated config", "Exactly what each gateway runs"],
  ["/updates", "Updates", "Software rollouts"],
  ["/alerts", "Alerts", "Email notifications"],
  ["/settings", "Settings", "Passwords and options"],
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <aside className="w-52 shrink-0 border-r border-zinc-800 bg-zinc-950 p-3">
            <div className="mb-5 px-2 pt-1">
              {/* Brand: OPN capitalised, mesh lowercase. */}
              <span className="text-base font-bold text-emerald-400">OPN</span>
              <span className="text-base font-bold text-zinc-100">mesh</span>
            </div>
            <nav className="space-y-0.5">
              {NAV.map(([href, label, hint]) => (
                <Link
                  key={href}
                  href={href}
                  title={hint}
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
