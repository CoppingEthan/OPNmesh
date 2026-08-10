"use client";

/**
 * The mesh diagram: every site, every client, and every link between them.
 *
 * Reading the picture:
 *  - each line is a real WireGuard tunnel; thickness is how much traffic it is
 *    carrying right now, and the moving dots show which way the bytes go
 *  - a line with dots travelling both ways is busy in both directions
 *  - grey dashed means the tunnel exists but is idle or has not handshaked
 *  - red means down
 *
 * It refreshes itself on an interval so the page is live without a reload.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MeshGraph, GraphNode, GraphLink } from "../lib/ui/graph.js";
import { formatRate } from "../lib/ui/graph.js";

const HEALTH_COLOUR: Record<string, string> = {
  active: "#34d399",
  degraded: "#fbbf24",
  offline: "#f87171",
  pending: "#a78bfa",
  unknown: "#71717a",
};

function linkColour(link: GraphLink, busy: number): string {
  if (!link.up) return "#7f1d1d";
  if (busy <= 0) return "#3f3f46";
  // Warmer as the link gets busier relative to the mesh's current peak.
  if (busy > 0.66) return "#f59e0b";
  if (busy > 0.33) return "#38bdf8";
  return "#22d3ee";
}

export default function MeshDiagram({
  initial,
  refreshMs = 5000,
}: {
  initial: MeshGraph;
  refreshMs?: number;
}) {
  const [graph, setGraph] = useState<MeshGraph>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (paused) return;
    const tick = async () => {
      try {
        const res = await fetch("/api/mesh-graph", { cache: "no-store" });
        if (res.ok) setGraph((await res.json()) as MeshGraph);
      } catch {
        /* keep showing the last good picture */
      }
    };
    timer.current = setInterval(tick, refreshMs);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [paused, refreshMs]);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const chosen = selected ? byId.get(selected) : null;

  const scale = (rate: number): number => {
    if (graph.peakRate <= 0 || rate <= 0) return 0;
    // Square root keeps a busy link visibly fatter without letting one huge
    // transfer flatten everything else to a hairline.
    return Math.sqrt(rate / graph.peakRate);
  };

  const gatewayCount = graph.nodes.filter((n) => n.kind === "gateway").length;
  const clientCount = graph.nodes.length - gatewayCount;
  const nodeRadius = graph.nodes.length > 40 ? 12 : graph.nodes.length > 20 ? 16 : 20;

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-zinc-100">Your network right now</div>
          <div className="text-xs text-zinc-500">
            {gatewayCount} {gatewayCount === 1 ? "location" : "locations"} · {clientCount}{" "}
            {clientCount === 1 ? "remote device" : "remote devices"} · {graph.links.length}{" "}
            {graph.links.length === 1 ? "connection" : "connections"}
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <Legend colour="#22d3ee" label="carrying traffic" />
          <Legend colour="#3f3f46" label="connected, idle" dashed />
          <Legend colour="#7f1d1d" label="down" />
          <button className="btn" onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          className="w-full"
          style={{ maxHeight: "62vh" }}
          role="img"
          aria-label="Diagram of your network showing every location, device and connection"
        >
          <defs>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Links first so nodes sit on top of them. */}
          {graph.links.map((link) => {
            const a = byId.get(link.from);
            const b = byId.get(link.to);
            if (!a || !b) return null;
            const busiest = Math.max(link.rateOut, link.rateIn);
            const intensity = scale(busiest);
            const colour = linkColour(link, intensity);
            const width = link.up ? 1.2 + intensity * 7 : 1;
            const dim = selected !== null && link.from !== selected && link.to !== selected;

            return (
              <g key={link.id} opacity={dim ? 0.15 : 1}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={colour}
                  strokeWidth={width}
                  strokeLinecap="round"
                  strokeDasharray={link.up ? (busiest > 0 ? undefined : "5 6") : "3 4"}
                  opacity={link.kind === "client" ? 0.75 : 1}
                />
                {/* Direction of flow: dots travel from source to destination,
                    one stream per busy direction. */}
                {link.rateOut > 0 && (
                  <FlowDots from={a} to={b} rate={link.rateOut} peak={graph.peakRate} colour={colour} />
                )}
                {link.rateIn > 0 && (
                  <FlowDots from={b} to={a} rate={link.rateIn} peak={graph.peakRate} colour={colour} />
                )}
                {busiest > 0 && <RateLabel a={a} b={b} link={link} />}
              </g>
            );
          })}

          {graph.nodes.map((n) => {
            const dim = selected !== null && selected !== n.id;
            const colour = HEALTH_COLOUR[n.health] ?? HEALTH_COLOUR["unknown"]!;
            const r = n.kind === "client" ? nodeRadius * 0.6 : nodeRadius;
            return (
              <g
                key={n.id}
                opacity={dim ? 0.25 : 1}
                onClick={() => setSelected(selected === n.id ? null : n.id)}
                style={{ cursor: "pointer" }}
              >
                {n.kind === "gateway" ? (
                  <rect
                    x={n.x - r}
                    y={n.y - r * 0.8}
                    width={r * 2}
                    height={r * 1.6}
                    rx={4}
                    fill="#18181b"
                    stroke={colour}
                    strokeWidth={n.isHub ? 3 : 2}
                    filter={n.throughput > 0 ? "url(#glow)" : undefined}
                  />
                ) : (
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={r}
                    fill="#18181b"
                    stroke={colour}
                    strokeWidth={2}
                    strokeDasharray="3 2"
                  />
                )}
                <text
                  x={n.x}
                  y={n.y + (n.kind === "gateway" ? r * 1.6 + 12 : r + 13)}
                  textAnchor="middle"
                  fontSize={graph.nodes.length > 40 ? 10 : 12}
                  fill="#e4e4e7"
                >
                  {n.label}
                </text>
                {n.kind === "gateway" && n.isHub && (
                  <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize={10} fill="#a1a1aa">
                    HUB
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {chosen ? (
        <div className="mt-3 rounded border border-zinc-800 bg-black/40 p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-zinc-100">{chosen.label}</span>
            <span className="text-xs" style={{ color: HEALTH_COLOUR[chosen.health] }}>
              {chosen.kind === "gateway" ? "Location" : "Remote device"} · {chosen.health}
            </span>
          </div>
          <div className="mono mt-1 space-y-0.5 text-xs text-zinc-400">
            {chosen.detail.map((d) => (
              <div key={d}>{d}</div>
            ))}
            <div>currently moving {formatRate(chosen.throughput)}</div>
          </div>
          <button className="btn mt-2" onClick={() => setSelected(null)}>
            Clear selection
          </button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-zinc-500">
          Click any box or circle to see its details. Squares are your locations, dashed circles are
          remote devices, and moving dots show which way traffic is flowing.
        </p>
      )}
    </div>
  );
}

function Legend({ colour, label, dashed }: { colour: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1 text-zinc-400">
      <svg width="22" height="8" aria-hidden="true">
        <line
          x1="1"
          y1="4"
          x2="21"
          y2="4"
          stroke={colour}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={dashed ? "4 4" : undefined}
        />
      </svg>
      {label}
    </span>
  );
}

/**
 * Animated dots travelling along a link. Speed tracks the rate, so a busier
 * link visibly moves faster as well as being thicker.
 */
function FlowDots({
  from,
  to,
  rate,
  peak,
  colour,
}: {
  from: GraphNode;
  to: GraphNode;
  rate: number;
  peak: number;
  colour: string;
}) {
  const share = peak > 0 ? Math.min(1, rate / peak) : 0;
  const duration = 4.5 - share * 3; // seconds for one traversal
  const count = share > 0.5 ? 3 : share > 0.15 ? 2 : 1;

  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <circle key={i} r={2.6} fill={colour}>
          <animateMotion
            dur={`${duration}s`}
            repeatCount="indefinite"
            begin={`${(duration / count) * i}s`}
            path={`M ${from.x} ${from.y} L ${to.x} ${to.y}`}
          />
        </circle>
      ))}
    </>
  );
}

/**
 * Both directions labelled on the link. `from → to` is shown with ▲ and the
 * reverse with ▼, so the arrows mean the same thing everywhere regardless of
 * which way the line happens to be drawn.
 */
function RateLabel({ a, b, link }: { a: GraphNode; b: GraphNode; link: GraphLink }) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular offset keeps the text clear of the line itself.
  const ox = (-dy / len) * 14;
  const oy = (dx / len) * 14;
  const lines = [
    link.rateOut > 0 ? `▲ ${formatRate(link.rateOut)}` : null,
    link.rateIn > 0 ? `▼ ${formatRate(link.rateIn)}` : null,
  ].filter((s): s is string => s !== null);
  const h = 6 + lines.length * 12;

  return (
    <g transform={`translate(${mx + ox}, ${my + oy})`} pointerEvents="none">
      <rect x={-40} y={-h / 2} width={80} height={h} rx={4} fill="#09090b" opacity={0.85} />
      {lines.map((text, i) => (
        <text
          key={text}
          textAnchor="middle"
          y={-h / 2 + 12 + i * 12}
          fontSize={10}
          fill={i === 0 ? "#67e8f9" : "#a5b4fc"}
        >
          {text}
        </text>
      ))}
    </g>
  );
}
