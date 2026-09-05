"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "./components";

/**
 * One row in the sidebar. The active row is a raised panel; the rest are
 * quiet until hovered. `tone` tints the icon only, so the label stays ink.
 */
export function NavLink({ href, label, icon, tone }: { href: string; label: string; icon: ReactNode; tone?: string }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
        active
          ? "border border-line bg-surface-3 font-semibold text-ink shadow-[inset_0_1px_0_var(--glass-highlight)]"
          : "border border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink",
      )}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center" style={tone && !active ? { color: tone } : undefined}>
        {icon}
      </span>
      {label}
    </Link>
  );
}

/** Uppercase heading above a group of rows. */
export function NavSection({ children }: { children: ReactNode }) {
  return <div className="px-3 pb-1.5 pt-5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-3">{children}</div>;
}
