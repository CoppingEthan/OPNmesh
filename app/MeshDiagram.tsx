"use client";

/**
 * The mesh, drawn as a force-directed graph.
 *
 * Design rules, deliberately restrictive:
 *  - One stroke colour for every link. Intensity is carried by OPACITY alone —
 *    a busy tunnel is simply more visible. Varying colour and width together
 *    made the picture noisy and neither channel readable.
 *  - Colour is reserved for exceptions. Everything healthy is neutral grey, so
 *    the one amber or red node draws the eye immediately.
 *  - Labels only where they help: locations always, devices on hover, and
 *    nothing at all once the graph is dense enough that text would collide.
 *  - The view auto-fits. Nodes drift under physics but the whole graph is
 *    always scaled to sit inside its box, whatever the browser size.
 *
 * Positions are seeded from the deterministic server layout, so the graph
 * settles the same way every reload instead of reshuffling.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MeshGraph, GraphLink, GraphNode } from "../lib/ui/graph.js";
import { formatRate } from "../lib/ui/graph.js";

interface Body {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  node: GraphNode;
  degree: number;
  /** Held in place by the pointer. */
  pinned: boolean;
  /** When this node first appeared, so it can fade in rather than pop. */
  appeared: number;
}

const INK = "228, 228, 231"; // zinc-200, as an rgb triple for rgba()
const MUTED = "#52525b";
const STATUS: Record<string, string> = {
  active: "#a1a1aa",
  degraded: "#fbbf24",
  offline: "#f87171",
  unknown: "#52525b",
};

/** Physics constants, tuned for legibility rather than realism. */
const REPULSION = 5200;
const SPRING = 0.035;
const REST_LENGTH = 110;
const CENTERING = 0.006;
const DAMPING = 0.86;
const MIN_ALPHA = 0.004;

export default function MeshDiagram({ initial, refreshMs = 5000 }: { initial: MeshGraph; refreshMs?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const graphRef = useRef<MeshGraph>(initial);
  const bodiesRef = useRef<Map<string, Body>>(new Map());
  /**
   * Displayed link load, eased toward the measured value. Polling gives a new
   * number every few seconds; without this the whole picture steps.
   */
  const shownRef = useRef<Map<string, { out: number; in: number }>>(new Map());
  const peakRef = useRef(1);
  /**
   * Per-link animation phase, integrated frame by frame. It must NOT be
   * derived from absolute time divided by a period: the period varies with
   * load, and Date.now() is ~1.8e12, so a 1ms change in the divisor moves the
   * result by hundreds of cycles and the dot teleports.
   */
  const phasesRef = useRef<Map<string, number>>(new Map());
  const lastFrameRef = useRef(0);
  /** Node/link membership, so we only reheat physics when the shape changes. */
  const shapeRef = useRef("");
  const alphaRef = useRef(1);
  const viewRef = useRef({ scale: 1, ox: 0, dy: 0, ready: false });
  const sizeRef = useRef({ w: 800, h: 520, dpr: 1 });
  const pointerRef = useRef<{ x: number; y: number; down: boolean; dragging: string | null }>({
    x: -1e6,
    y: -1e6,
    down: false,
    dragging: null,
  });

  // The animation loop reads focus from refs so it is created once and never
  // torn down; the matching state exists only to re-render the info panel.
  const hoveredRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [summary, setSummary] = useState({ gateways: 0, clients: 0, links: 0 });

  /** Rebuild bodies from graph data, preserving positions of nodes we know. */
  const syncBodies = useCallback((graph: MeshGraph) => {
    const bodies = bodiesRef.current;
    const seen = new Set<string>();
    const degree = new Map<string, number>();
    for (const l of graph.links) {
      degree.set(l.from, (degree.get(l.from) ?? 0) + 1);
      degree.set(l.to, (degree.get(l.to) ?? 0) + 1);
    }
    for (const n of graph.nodes) {
      seen.add(n.id);
      const existing = bodies.get(n.id);
      if (existing) {
        existing.node = n;
        existing.degree = degree.get(n.id) ?? 0;
      } else {
        // Seed from the server's deterministic layout, centred on the origin.
        bodies.set(n.id, {
          id: n.id,
          x: n.x - graph.width / 2,
          y: n.y - graph.height / 2,
          vx: 0,
          vy: 0,
          node: n,
          degree: degree.get(n.id) ?? 0,
          pinned: false,
          appeared: performance.now(),
        });
      }
    }
    for (const id of [...bodies.keys()]) if (!seen.has(id)) bodies.delete(id);

    // Reheat the simulation only when the graph's SHAPE changes. A poll that
    // merely brings new traffic numbers must not jolt the layout.
    const shape = [
      graph.nodes.map((n) => n.id).sort().join(","),
      graph.links.map((l) => l.id).sort().join(","),
    ].join("|");
    if (shape !== shapeRef.current) {
      shapeRef.current = shape;
      alphaRef.current = Math.max(alphaRef.current, 0.6);
    }

    // Drop smoothing state for links that no longer exist.
    const liveLinks = new Set(graph.links.map((l) => l.id));
    for (const id of [...shownRef.current.keys()]) {
      if (!liveLinks.has(id)) shownRef.current.delete(id);
    }
    for (const id of [...phasesRef.current.keys()]) {
      if (!liveLinks.has(id)) phasesRef.current.delete(id);
    }
    setSummary({
      gateways: graph.nodes.filter((n) => n.kind === "gateway").length,
      clients: graph.nodes.filter((n) => n.kind === "client").length,
      links: graph.links.length,
    });
  }, []);

  useEffect(() => {
    syncBodies(initial);
  }, [initial, syncBodies]);

  // --- live data ---------------------------------------------------------
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/mesh-graph", { cache: "no-store" });
        if (!res.ok || stop) return;
        const graph = (await res.json()) as MeshGraph;
        graphRef.current = graph;
        syncBodies(graph);
      } catch {
        /* keep drawing the last good picture */
      }
    };
    const id = setInterval(tick, refreshMs);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [refreshMs, syncBodies]);

  // --- sizing ------------------------------------------------------------
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const apply = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      alphaRef.current = Math.max(alphaRef.current, 0.25);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // --- simulation + render ----------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;

    const radiusOf = (b: Body) => {
      const base = b.node.kind === "gateway" ? 7 : 4.5;
      return base + Math.min(4, b.degree * 0.45);
    };

    const step = (ts: number) => {
      // Clamped: a backgrounded tab produces an enormous gap, and an
      // unclamped dt would fling every dot down its line at once.
      const dt = Math.min(50, lastFrameRef.current ? ts - lastFrameRef.current : 16);
      lastFrameRef.current = ts;
      const bodies = [...bodiesRef.current.values()];
      const graph = graphRef.current;
      const alpha = alphaRef.current;

      if (bodies.length > 0 && alpha > MIN_ALPHA) {
        // Repulsion — every pair pushes apart, which is what spreads the
        // graph out and stops clusters overlapping.
        for (let i = 0; i < bodies.length; i++) {
          const a = bodies[i]!;
          for (let j = i + 1; j < bodies.length; j++) {
            const b = bodies[j]!;
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) {
              // Perfectly coincident nodes would divide by zero; nudge apart.
              dx = (Math.random() - 0.5) * 0.1;
              dy = (Math.random() - 0.5) * 0.1;
              d2 = dx * dx + dy * dy;
            }
            const d = Math.sqrt(d2);
            const f = (REPULSION / d2) * alpha;
            const fx = (dx / d) * f;
            const fy = (dy / d) * f;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }

        // Springs — linked nodes pull together toward a rest length.
        for (const l of graph.links) {
          const a = bodiesRef.current.get(l.from);
          const b = bodiesRef.current.get(l.to);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 0.01;
          // Client tethers sit a little closer, which groups devices visibly
          // around the location they enter at.
          const rest = l.kind === "client" ? REST_LENGTH * 0.62 : REST_LENGTH;
          const f = (d - rest) * SPRING * alpha;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }

        // Shape the potential well to the container. Pulling harder along Y
        // than X makes the graph settle wide and flat, matching the box it
        // lives in, instead of drifting into a tall column that wastes the
        // horizontal space and then gets scaled down to fit.
        const aspect = Math.max(1, sizeRef.current.w / Math.max(1, sizeRef.current.h));
        const bias = Math.pow(aspect, 1.5);
        const cx = CENTERING / bias;
        const cy = CENTERING * bias;

        for (const b of bodies) {
          if (b.pinned) {
            b.vx = 0;
            b.vy = 0;
            continue;
          }
          b.vx -= b.x * cx * alpha;
          b.vy -= b.y * cy * alpha;
          b.vx *= DAMPING;
          b.vy *= DAMPING;
          b.x += b.vx;
          b.y += b.vy;
        }
        alphaRef.current = alpha * 0.985;
      }

      // --- auto-fit: keep the whole graph inside the box at any size ---
      const { w, h, dpr } = sizeRef.current;
      const pad = 46;
      let minX = -1,
        maxX = 1,
        minY = -1,
        maxY = 1;
      for (const b of bodies) {
        minX = Math.min(minX, b.x);
        maxX = Math.max(maxX, b.x);
        minY = Math.min(minY, b.y);
        maxY = Math.max(maxY, b.y);
      }
      const spanX = Math.max(1, maxX - minX);
      const spanY = Math.max(1, maxY - minY);
      const target = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY, 1.9);
      const view = viewRef.current;
      // Ease toward the target so resizing and new nodes glide rather than jump.
      const ease = view.ready ? 0.12 : 1;
      view.scale += (target - view.scale) * ease;
      view.ox += (w / 2 - ((minX + maxX) / 2) * view.scale - view.ox) * ease;
      view.dy += (h / 2 - ((minY + maxY) / 2) * view.scale - view.dy) * ease;
      view.ready = true;

      const toScreen = (b: Body) => ({ x: b.x * view.scale + view.ox, y: b.y * view.scale + view.dy });

      // --- hover / drag ---
      const p = pointerRef.current;
      let nearest: string | null = null;
      let nearestDist = 18;
      for (const b of bodies) {
        const s = toScreen(b);
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = b.id;
        }
      }
      if (p.dragging) {
        const body = bodiesRef.current.get(p.dragging);
        if (body) {
          body.x = (p.x - view.ox) / view.scale;
          body.y = (p.y - view.dy) / view.scale;
        }
      }
      if (hoveredRef.current !== nearest) {
        hoveredRef.current = nearest;
        setHovered(nearest);
      }

      // --- draw ---
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const focus = p.dragging ?? hoveredRef.current ?? selectedRef.current;
      const neighbours = new Set<string>();
      if (focus) {
        neighbours.add(focus);
        for (const l of graph.links) {
          if (l.from === focus) neighbours.add(l.to);
          if (l.to === focus) neighbours.add(l.from);
        }
      }

      // Ease displayed load toward the measured value so the picture breathes
      // between polls rather than stepping. ~1s to converge at 60fps.
      const EASE = 0.06;
      for (const l of graph.links) {
        const shown = shownRef.current.get(l.id) ?? { out: l.rateOut, in: l.rateIn };
        shown.out += (l.rateOut - shown.out) * EASE;
        shown.in += (l.rateIn - shown.in) * EASE;
        shownRef.current.set(l.id, shown);
      }
      peakRef.current += ((graph.peakRate || 1) - peakRef.current) * EASE;

      // Links: one colour, one width. Opacity carries how busy the tunnel is.
      const peak = Math.max(1, peakRef.current);
      ctx.lineWidth = 1;
      for (const l of graph.links) {
        const a = bodiesRef.current.get(l.from);
        const b = bodiesRef.current.get(l.to);
        if (!a || !b) continue;
        const sa = toScreen(a);
        const sb = toScreen(b);
        const shown = shownRef.current.get(l.id) ?? { out: l.rateOut, in: l.rateIn };
        const busiest = Math.max(shown.out, shown.in);
        // Square root so a quiet-but-alive link is still visible next to a
        // saturated one, rather than being crushed to nothing.
        const load = busiest > 0 ? Math.sqrt(busiest / peak) : 0;
        let opacity = l.up ? 0.07 + load * 0.55 : 0.05;
        if (focus) opacity = neighbours.has(l.from) && neighbours.has(l.to) ? Math.max(opacity, 0.5) : opacity * 0.25;

        ctx.strokeStyle = `rgba(${INK}, ${opacity})`;
        ctx.setLineDash(l.up ? [] : [3, 4]);
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Direction, shown only where there is something to show: a single
        // faint travelling dot per active direction.
        if (l.up && busiest > 0) {
          // One unhurried traversal every 5.5s when barely moving, 3s when
          // saturated. The range is deliberately narrow: speed is a hint that
          // something is flowing, not a second load gauge competing with
          // opacity.
          const period = 5500 - load * 2500;
          const t = ((phasesRef.current.get(l.id) ?? 0) + dt / period) % 1;
          phasesRef.current.set(l.id, t);
          const dot = (from: { x: number; y: number }, to: { x: number; y: number }, offset: number) => {
            const k = (t + offset) % 1;
            ctx.fillStyle = `rgba(${INK}, ${Math.min(0.7, 0.22 + load * 0.45)})`;
            ctx.beginPath();
            ctx.arc(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, 1.5, 0, Math.PI * 2);
            ctx.fill();
          };
          if (shown.out > 0) dot(sa, sb, 0);
          if (shown.in > 0) dot(sb, sa, 0.5);
        }
      }

      // Nodes.
      const showAllLabels = bodies.length <= 24;
      for (const b of bodies) {
        const s = toScreen(b);
        const r = radiusOf(b);
        // New nodes ease in over ~600ms so an enrolment does not pop.
        const age = Math.min(1, (performance.now() - b.appeared) / 600);
        const dim = (focus ? (neighbours.has(b.id) ? 1 : 0.22) : 1) * age;
        const status = STATUS[b.node.health] ?? STATUS["unknown"]!;
        // Healthy nodes stay neutral so that anything coloured means trouble.
        const ring = b.node.health === "active" ? (b.node.kind === "gateway" ? "#a1a1aa" : MUTED) : status;

        ctx.globalAlpha = dim;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#18181b";
        ctx.fill();
        ctx.lineWidth = b.node.isHub ? 2 : 1.25;
        ctx.strokeStyle = ring;
        if (b.node.kind === "client") ctx.setLineDash([2, 2]);
        ctx.stroke();
        ctx.setLineDash([]);

        if (b.node.isHub) {
          ctx.beginPath();
          ctx.arc(s.x, s.y, 2, 0, Math.PI * 2);
          ctx.fillStyle = ring;
          ctx.fill();
        }

        const labelled = showAllLabels || b.node.kind === "gateway" || b.id === focus;
        if (labelled) {
          ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.fillStyle = `rgba(${INK}, ${b.id === focus ? 0.95 : 0.6})`;
          ctx.fillText(b.node.label, s.x, s.y + r + 13);
        }
        ctx.globalAlpha = 1;
      }

      // Rates for the focused node's links only — always-on labels are noise.
      if (focus) {
        ctx.font = "10px ui-monospace, monospace";
        ctx.textAlign = "center";
        for (const l of graph.links) {
          if (l.from !== focus && l.to !== focus) continue;
          const shown = shownRef.current.get(l.id) ?? { out: l.rateOut, in: l.rateIn };
          if (shown.out <= 0 && shown.in <= 0) continue;
          const a = bodiesRef.current.get(l.from);
          const b = bodiesRef.current.get(l.to);
          if (!a || !b) continue;
          const sa = toScreen(a);
          const sb = toScreen(b);
          // Rate away from the focused node, so the number always reads
          // "leaving the thing you are looking at". Uses the same eased value
          // the line is drawn from, so the label and the picture agree.
          const away = l.from === focus ? shown.out : shown.in;
          const towards = l.from === focus ? shown.in : shown.out;
          const mx = (sa.x + sb.x) / 2;
          const my = (sa.y + sb.y) / 2;
          ctx.fillStyle = `rgba(${INK}, 0.75)`;
          ctx.fillText(`↑ ${formatRate(away)}  ↓ ${formatRate(towards)}`, mx, my - 5);
        }
      }

      ctx.restore();
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);

  // --- pointer -----------------------------------------------------------
  const localPoint = (e: React.PointerEvent) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = localPoint(e);
    pointerRef.current.x = x;
    pointerRef.current.y = y;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = localPoint(e);
    const target = hoveredRef.current;
    pointerRef.current = { x, y, down: true, dragging: target };
    if (target) {
      const b = bodiesRef.current.get(target);
      if (b) b.pinned = true;
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    }
  };
  const onPointerUp = () => {
    const dragged = pointerRef.current.dragging;
    if (dragged) {
      const b = bodiesRef.current.get(dragged);
      if (b) b.pinned = false;
      alphaRef.current = Math.max(alphaRef.current, 0.35);
    }
    pointerRef.current.down = false;
    pointerRef.current.dragging = null;
  };
  const onPointerLeave = () => {
    pointerRef.current.x = -1e6;
    pointerRef.current.y = -1e6;
    onPointerUp();
  };
  const onClick = () => {
    const next = selectedRef.current === hoveredRef.current ? null : hoveredRef.current;
    selectedRef.current = next;
    setSelected(next);
  };

  const focusId = hovered ?? selected;
  const focusNode = focusId ? graphRef.current.nodes.find((n) => n.id === focusId) : null;

  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-zinc-100">Your network</div>
          <div className="text-xs text-zinc-500">
            {summary.gateways} {summary.gateways === 1 ? "location" : "locations"} · {summary.clients}{" "}
            {summary.clients === 1 ? "device" : "devices"} · {summary.links}{" "}
            {summary.links === 1 ? "connection" : "connections"}
          </div>
        </div>
        <div className="text-xs text-zinc-600">
          brighter lines carry more traffic · drag to rearrange
        </div>
      </div>

      {/* Fixed proportion of the viewport, and it follows the browser as you
          resize — the graph rescales itself to fit whatever it is given. */}
      <div
        ref={wrapRef}
        className="relative w-full rounded border border-zinc-800/60 bg-black/20"
        style={{ height: "min(60vh, 560px)", minHeight: 300 }}
      >
        <canvas
          ref={canvasRef}
          onPointerMove={onPointerMove}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          onClick={onClick}
          style={{ cursor: hovered ? "grab" : "default", display: "block" }}
          role="img"
          aria-label="Force-directed diagram of every location, device and connection in your network"
        />

        {focusNode && (
          <div className="pointer-events-none absolute left-3 top-3 max-w-xs rounded border border-zinc-800 bg-zinc-950/90 p-3">
            <div className="text-sm font-medium text-zinc-100">{focusNode.label}</div>
            <div className="text-xs" style={{ color: STATUS[focusNode.health] }}>
              {focusNode.kind === "gateway" ? "Location" : "Remote device"}
              {focusNode.isHub ? " · hub" : ""} · {focusNode.health}
            </div>
            <div className="mono mt-1 space-y-0.5 text-xs text-zinc-400">
              {focusNode.detail.map((d) => (
                <div key={d}>{d}</div>
              ))}
              <div>{formatRate(focusNode.throughput)} total</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
