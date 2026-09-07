"use client";

/**
 * The signed-in admin at the foot of the sidebar: initials in a coloured
 * disc, a display name, the role, and sign out. There is no name column in
 * the database, so the name is derived from the email's local part and the
 * full address is kept in the tooltip.
 */
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiFetch } from "./api";

/** "jane.doe@x.com" → "Jane Doe"; "admin@x.com" → "Admin". */
export function displayName(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local.split(/[._-]+/).filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || email;
}

export function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** A stable hue per address, so two admins never share a disc colour by accident. */
function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export function UserChip({ email }: { email: string }) {
  const router = useRouter();
  const name = displayName(email);
  const h = hue(email);
  return (
    <div className="flex items-center gap-3 px-2 py-1">
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
        style={{ background: `linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 24) % 360} 48% 30%))` }}
      >
        {initials(name)}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-semibold text-ink" title={email}>
          {name}
        </div>
        <div className="text-xs text-brand-ink">Admin</div>
      </div>
      <button
        type="button"
        aria-label="Sign out"
        title="Sign out"
        className="shrink-0 rounded-md p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
        onClick={async () => {
          await apiFetch("POST", "/api/admin/logout");
          router.push("/login");
          router.refresh();
        }}
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
}
