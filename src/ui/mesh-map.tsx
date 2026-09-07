"use client";

/**
 * The live map: sites as nodes, tunnels as links, roaming clients as small
 * satellites. Layout is deterministic (a ring in hub-priority order) so the
 * picture never reshuffles. Traffic is shown by one thing only: the weight
 * of each link, from a hairline you can barely see to a bold stroke, eased
 * smoothly between samples. Figures live in the hover card, not on the map.
 * Colour is reserved for problems.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { StatePayload, SiteState } from "@/server/state";
import type { TunnelView } from "@/server/status";
import { formatBits, formatMs } from "./format";
import { cx } from "./components";

const W = 1000;
const H = 560;
const NODE_R = 30;
/** Link weight range: nearly invisible at rest, bold under load. */
const MIN_W = 0.5;
const MAX_W = 13;
/**
 * Log scale from 100 kbit/s to 100 Mbit/s. An idle tunnel (keepalives, a
 * little chatter) sits at the hairline; a real transfer is bold well before
 * it saturates a typical site link, so the contrast is visible day to day.
 */
const LOW_BPS = 12_500;
const DECADES = 3;
/** Time constant of the weight easing. */
const TAU_MS = 700;

interface Pos {
  x: number;
  y: number;
}

function layout(sites: SiteState[]): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  const n = sites.length;
  if (n === 0) return pos;
  if (n === 1) {
    pos.set(sites[0]!.id, { x: W / 2, y: H / 2 });
    return pos;
  }
  const rx = Math.min(W * 0.36, 90 + n * 45);
  const ry = Math.min(H * 0.34, 70 + n * 30);
  sites.forEach((s, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pos.set(s.id, { x: W / 2 + rx * Math.cos(a), y: H / 2 + 20 + ry * Math.sin(a) });
  });
  return pos;
}

/** Stroke width for a link carrying `bps` (both directions combined). */
export function linkWeight(bps: number): number {
  if (bps <= LOW_BPS) return MIN_W;
  const t = Math.min(1, (Math.log10(bps) - Math.log10(LOW_BPS)) / DECADES);
  return MIN_W + (MAX_W - MIN_W) * t;
}

function linkOpacity(w: number): number {
  return 0.28 + 0.62 * ((w - MIN_W) / (MAX_W - MIN_W));
}

function toneOf(site: SiteState): "good" | "warn" | "bad" | "idle" {
  const h = site.gateway?.health;
  if (!h || h === "never" || h === "disabled") return "idle";
  if (h === "pending" || h === "stale" || site.gateway?.attention) return "warn";
  if (h === "offline") return "bad";
  return "good";
}

const STROKE: Record<string, string> = { good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)", idle: "var(--idle)" };

/** A store that never changes: "mounted" is false on the server and true in the browser. */
const subscribeNever = () => () => {};

export function MeshMap({ state, height = 560 }: { state: StatePayload; height?: number }) {
  const sites = useMemo(() => [...state.sites].sort((a, b) => a.hubPriority - b.hubPriority || a.name.localeCompare(b.name)), [state.sites]);
  const pos = useMemo(() => layout(sites), [sites]);
  const byId = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  const [hoverLink, setHoverLink] = useState<TunnelView | null>(null);
  const [hoverSite, setHoverSite] = useState<SiteState | null>(null);
  // The animation loop reads these each frame; they are mirrored by effects
  // so render stays free of ref access.
  const tunnelsRef = useRef(state.tunnels);
  const hoverKey = useRef<string | null>(null);
  useEffect(() => {
    tunnelsRef.current = state.tunnels;
  }, [state.tunnels]);
  useEffect(() => {
    hoverKey.current = hoverLink ? `${hoverLink.a}|${hoverLink.b}` : null;
  }, [hoverLink]);
  /** Eased weight per link, written straight to the line elements. */
  const shown = useRef<Map<string, number>>(new Map());
  const lineRefs = useRef<Map<string, SVGLineElement>>(new Map());

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      const k = 1 - Math.exp(-dt / TAU_MS);
      for (const t of tunnelsRef.current) {
        if (t.kind !== "direct") continue;
        const key = `${t.a}|${t.b}`;
        const target = linkWeight(t.aToB + t.bToA);
        const cur = shown.current.get(key) ?? target;
        const next = Math.abs(target - cur) < 0.01 ? target : cur + (target - cur) * k;
        shown.current.set(key, next);
        const el = lineRefs.current.get(key);
        if (el) {
          el.setAttribute("stroke-width", next.toFixed(2));
          el.setAttribute("opacity", hoverKey.current === key ? "1" : linkOpacity(next).toFixed(2));
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const name = (id: string) => byId.get(id)?.name ?? id;
  const onlineClients = state.clients.filter((c) => c.online);
  // React 19 treats <title> as document metadata and hoists it, which makes an
  // SVG <title> disagree between the server's markup and the client's. Render
  // the native tooltip only after mount, so hydration has nothing to reconcile.
  const mounted = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} role="img" aria-label="Map of sites and tunnels">
        <defs>
          <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1" stdDeviation="2" floodOpacity="0.12" />
          </filter>
        </defs>

        {/* Links */}
        {state.tunnels.map((t) => {
          const a = pos.get(t.a);
          const b = pos.get(t.b);
          if (!a || !b) return null;
          const key = `${t.a}|${t.b}`;
          const hovered = hoverLink === t;
          if (t.kind !== "direct") {
            const via = t.via ? pos.get(t.via) : null;
            const d = via ? `M ${a.x} ${a.y} Q ${via.x} ${via.y} ${b.x} ${b.y}` : `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
            return (
              <g key={key} onMouseEnter={() => setHoverLink(t)} onMouseLeave={() => setHoverLink(null)}>
                <path d={d} fill="none" stroke="transparent" strokeWidth={18} />
                <path d={d} fill="none" stroke={t.kind === "unreachable" ? "var(--bad)" : "var(--ink-3)"} strokeWidth={1.25} strokeDasharray="4 6" opacity={hovered ? 0.9 : 0.45} />
              </g>
            );
          }
          const stroke = t.health === "up" ? "var(--ink-2)" : t.health === "handshake-only" ? "var(--warn)" : t.health === "down" ? "var(--bad)" : "var(--ink-3)";
          return (
            <g key={key} onMouseEnter={() => setHoverLink(t)} onMouseLeave={() => setHoverLink(null)} style={{ cursor: "default" }}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={22} />
              {/* Width and opacity are animated imperatively; React only sets the geometry and colour. */}
              <line
                ref={(el) => {
                  if (el) lineRefs.current.set(key, el);
                  else lineRefs.current.delete(key);
                }}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={stroke}
                strokeLinecap="round"
                strokeWidth={MIN_W}
                opacity={linkOpacity(MIN_W)}
              />
            </g>
          );
        })}

        {/* Client satellites */}
        {sites.map((s) => {
          const p = pos.get(s.id)!;
          const mine = onlineClients.filter((c) => c.viaSiteId === s.id);
          return mine.slice(0, 12).map((c, i) => {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(6, mine.length);
            const r = NODE_R + 22;
            const cx0 = p.x + r * Math.cos(a);
            const cy0 = p.y + r * Math.sin(a);
            return (
              <g key={c.id}>
                <line x1={p.x + NODE_R * Math.cos(a)} y1={p.y + NODE_R * Math.sin(a)} x2={cx0} y2={cy0} stroke="var(--ink-3)" strokeWidth={1} opacity={0.5} />
                <circle cx={cx0} cy={cy0} r={5} fill="var(--solid)" stroke="var(--brand)" strokeWidth={1.75}>
                  {mounted && <title>{`${c.name} · ${c.tunnelIp}`}</title>}
                </circle>
              </g>
            );
          });
        })}

        {/* Sites */}
        {sites.map((s) => {
          const p = pos.get(s.id)!;
          const tone = toneOf(s);
          const dim = !s.inMesh;
          return (
            <Link key={s.id} href={`/sites/${s.id}`}>
              <g onMouseEnter={() => setHoverSite(s)} onMouseLeave={() => setHoverSite(null)} opacity={dim ? 0.55 : 1} style={{ cursor: "pointer" }}>
                <circle cx={p.x} cy={p.y} r={NODE_R} fill="var(--solid)" stroke={STROKE[tone]} strokeWidth={tone === "good" ? 2 : 3} filter="url(#soft)" strokeDasharray={dim ? "3 4" : undefined} />
                <text x={p.x} y={p.y + 5} textAnchor="middle" fontSize={15} fontWeight={600} fill="var(--ink)">
                  {s.name.slice(0, 2).toUpperCase()}
                </text>
                <text x={p.x} y={p.y + NODE_R + 20} textAnchor="middle" fontSize={14} fontWeight={500} fill="var(--ink)" stroke="var(--solid)" strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">
                  {s.name}
                </text>
                <text x={p.x} y={p.y + NODE_R + 36} textAnchor="middle" fontSize={11} fill="var(--ink-3)" stroke="var(--solid)" strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">
                  {!s.inMesh ? "no gateway yet" : s.reachable ? "accepts connections" : "dials out only"}
                </text>
              </g>
            </Link>
          );
        })}

        {sites.length === 0 && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={16} fill="var(--ink-3)">
            No sites yet
          </text>
        )}
      </svg>

      {/* Hover cards */}
      {hoverLink && (
        <div className="glass-strong fade-in pointer-events-none absolute left-4 top-4 w-64 rounded-xl p-3 text-xs">
          <div className="mb-1 font-medium text-ink">
            {name(hoverLink.a)} ↔ {name(hoverLink.b)}
          </div>
          {hoverLink.kind === "direct" ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-ink-2">
              <dt>Status</dt>
              <dd className={cx(hoverLink.health === "up" ? "text-good-ink" : hoverLink.health === "down" ? "text-bad-ink" : "text-warn-ink")}>{hoverLink.health}</dd>
              <dt>{name(hoverLink.a)} →</dt>
              <dd className="tnum text-ink">{formatBits(hoverLink.aToB)}</dd>
              <dt>{name(hoverLink.b)} →</dt>
              <dd className="tnum text-ink">{formatBits(hoverLink.bToA)}</dd>
              <dt>Round trip</dt>
              <dd className="tnum text-ink">{formatMs(hoverLink.rttMs)}</dd>
              <dt>Handshake</dt>
              <dd className="tnum text-ink">{hoverLink.handshakeAgeS === null ? "never" : `${hoverLink.handshakeAgeS}s ago`}</dd>
            </dl>
          ) : hoverLink.kind === "transit" ? (
            <p className="text-ink-2">
              Indirect: neither site accepts incoming connections, so traffic between them travels through <span className="text-ink">{name(hoverLink.via!)}</span>.
            </p>
          ) : (
            <p className="text-bad-ink">These sites cannot connect: neither accepts incoming connections and no site can relay.</p>
          )}
        </div>
      )}
      {hoverSite && !hoverLink && (
        <div className="glass-strong fade-in pointer-events-none absolute right-4 top-4 w-64 rounded-xl p-3 text-xs">
          <div className="mb-1 font-medium text-ink">{hoverSite.name}</div>
          <div className="text-ink-2">
            {hoverSite.gateway ? (
              <>
                <div>Gateway: {hoverSite.gateway.health}{hoverSite.gateway.attention ? ` — ${hoverSite.gateway.attention}` : ""}</div>
                <div className="mono">tunnel {hoverSite.gateway.tunnelIp}</div>
              </>
            ) : (
              <div>No gateway installed yet.</div>
            )}
            <ul className="mono mt-1">
              {hoverSite.lans.map((l) => (
                <li key={l.id}>
                  {l.cidr} <span className="font-sans text-ink-3">{l.name}{l.shared ? "" : " (local only)"}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

    </div>
  );
}
