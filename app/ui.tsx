/** Small shared presentational helpers (server-component friendly). */

export function ago(tsMs: number | null): string {
  if (!tsMs) return "never";
  const s = Math.floor((Date.now() - tsMs) / 1000);
  if (s < 5) return "just now";
  if (s < 120) return `${s}s ago`;
  if (s < 7200) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function bytes(n: number): string {
  if (n > 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GiB`;
  if (n > 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MiB`;
  if (n > 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

export type NodeHealth = "active" | "degraded" | "offline" | "unknown";

/** Node state derivation: offline = not seen for 30s+, degraded = errors/drift. */
export function healthOf(lastSeen: number | null, lastError: string, drift: boolean): NodeHealth {
  if (!lastSeen) return "unknown";
  if (Date.now() - lastSeen > 30_000) return "offline";
  if (lastError !== "" || drift) return "degraded";
  return "active";
}

export function HealthBadge({ health }: { health: NodeHealth }) {
  const cls =
    health === "active" ? "status-ok" : health === "degraded" ? "status-warn" : health === "offline" ? "status-bad" : "status-dim";
  const dot = health === "active" ? "●" : health === "degraded" ? "◐" : health === "offline" ? "○" : "?";
  return (
    <span className={`${cls} text-sm`}>
      {dot} {health}
    </span>
  );
}

export function HandshakeAge({ unixSec }: { unixSec: number }) {
  if (!unixSec) return <span className="status-dim">never</span>;
  const age = Math.floor(Date.now() / 1000 - unixSec);
  const cls = age < 180 ? "status-ok" : "status-bad";
  return <span className={cls}>{age < 120 ? `${age}s` : `${Math.floor(age / 60)}m`}</span>;
}
