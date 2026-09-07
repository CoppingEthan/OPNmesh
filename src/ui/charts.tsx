"use client";

/**
 * A small, dependency-free chart for time series: smooth (monotone cubic)
 * lines with a soft gradient wash beneath each, a hairline recessive grid,
 * a crosshair that snaps to the nearest sample and a tooltip listing every
 * series at that time. Text uses ink tokens; only marks carry series colour.
 *
 * In live mode the plot glides right-to-left continuously: samples are laid
 * out against the latest sample time and a single transform, updated every
 * frame from a clock, slides the whole group as time passes. New samples
 * enter from beyond the right edge (the display lags the clock by `lagMs`)
 * so the line never has to wait at the edge or jump when data arrives.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cx } from "./components";

export interface Series {
  name: string;
  color: string;
  points: Array<{ ts: number; v: number }>;
}

export interface LiveScroll {
  /** Current time in the same time base as the samples. */
  clock: () => number;
  /** How far behind the clock the right edge sits (default 1500 ms). */
  lagMs?: number;
}

interface Props {
  series: Series[];
  height?: number;
  formatValue: (v: number) => string;
  from: number;
  to: number;
  className?: string;
  ariaLabel?: string;
  /** Smooth curves (default) or straight segments. */
  smooth?: boolean;
  /** Gradient fill under each line (default on). */
  area?: boolean;
  /** Continuous right-to-left scrolling for a live window. */
  live?: LiveScroll;
  /** Value labels down the left edge (default on). Off leaves just the gridlines. */
  yAxis?: boolean;
}

function niceMax(max: number): number {
  // Floor at 1 kbit/s so an idle network still gets a readable axis.
  if (max < 125) return 125;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const m = max / exp;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return nice * exp;
}

function timeLabel(ts: number, spanMs: number): string {
  const d = new Date(ts);
  if (spanMs > 60 * 24 * 3600_000) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (spanMs > 2 * 24 * 3600_000) return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
  if (spanMs <= 5 * 60_000) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

interface XY {
  x: number;
  y: number;
}

/** Straight segments. */
function linearPath(p: XY[]): string {
  return p.map((q, i) => `${i === 0 ? "M" : "L"} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ");
}

/**
 * Monotone cubic interpolation (Fritsch–Carlson): smooth through every
 * sample without the overshoot that would invent values below zero or
 * above the real peak.
 */
function monotonePath(p: XY[]): string {
  const n = p.length;
  if (n === 0) return "";
  if (n === 1) return `M ${p[0]!.x.toFixed(1)} ${p[0]!.y.toFixed(1)}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = p[i + 1]!.x - p[i]!.x;
    m[i] = dx[i] === 0 ? 0 : (p[i + 1]!.y - p[i]!.y) / dx[i]!;
  }
  const t: number[] = new Array(n).fill(0);
  t[0] = m[0]!;
  t[n - 1] = m[n - 2]!;
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      t[i] = tau * a * m[i]!;
      t[i + 1] = tau * b * m[i]!;
    }
  }
  let d = `M ${p[0]!.x.toFixed(1)} ${p[0]!.y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]! / 3;
    const c1x = p[i]!.x + h;
    const c1y = p[i]!.y + t[i]! * h;
    const c2x = p[i + 1]!.x - h;
    const c2y = p[i + 1]!.y - t[i + 1]! * h;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p[i + 1]!.x.toFixed(1)} ${p[i + 1]!.y.toFixed(1)}`;
  }
  return d;
}

/** Tick spacing for the live window: a label every 10 s reads cleanly at 60 s. */
const LIVE_TICK_MS = 10_000;

export function LineChart({ series, height = 180, formatValue, from, to, className, ariaLabel, smooth = true, area = true, live, yAxis = true }: Props) {
  // The viewBox tracks the element's real pixel width, so the plot fills the
  // card exactly. (With a fixed viewBox the browser letterboxes a wider
  // container, leaving a gap at each side.)
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [W, setW] = useState(800);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      if (w > 0) setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height;
  const PAD = { l: yAxis ? 66 : 14, r: 14, t: 10, b: 28 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const span = to - from;
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const scrollRef = useRef<SVGGElement | null>(null);
  /** The scrolling tick labels, masked so they fade at the edges instead of being cut. */
  const ticksRef = useRef<SVGGElement | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const lagMs = live?.lagMs ?? 1500;

  // Vertical scale. Without value labels it is smoothed: it grows at once but
  // only shrinks once the data has dropped well clear, and the change is eased
  // by scaling the plot group per frame, so a peak scrolling off the left edge
  // no longer makes the whole chart jump. With labels the scale is exact,
  // because a scaled plot would contradict the numbers down the side.
  const smoothScale = !yAxis;
  const dataMax = useMemo(() => Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.v))), [series]);
  const nice = niceMax(dataMax);
  // The scale's hysteresis is state derived from the data during render (the
  // sanctioned way to adjust state when inputs change): it grows at once and
  // shrinks only once the data has dropped well clear.
  const [scaleMax, setScaleMax] = useState(nice);
  const targetMaxValue = !smoothScale || nice > scaleMax || dataMax < scaleMax * 0.5 ? nice : scaleMax;
  if (targetMaxValue !== scaleMax) setScaleMax(targetMaxValue);
  const [renderedMax, setRenderedMax] = useState(nice);
  const maxV = smoothScale ? renderedMax : targetMaxValue;
  // Mirrors for the animation loop, which runs outside render. A layout
  // effect keeps them current before the first frame is applied.
  const targetMax = useRef(targetMaxValue);
  const animMax = useRef(targetMaxValue);
  const renderedMaxRef = useRef(maxV);
  useLayoutEffect(() => {
    targetMax.current = targetMaxValue;
    renderedMaxRef.current = maxV;
  }, [targetMaxValue, maxV]);
  const x = (ts: number) => PAD.l + ((ts - from) / span) * innerW;
  const y = (v: number) => PAD.t + innerH - (v / maxV) * innerH;
  const baseline = PAD.t + innerH;

  /** How far (px) the plot must slide so the right edge shows `clock - lag`. */
  const shift = useCallback((): number => {
    if (!live) return 0;
    const displayTo = live.clock() - lagMs;
    return ((to - displayTo) / span) * innerW;
  }, [live, lagMs, to, span, innerW]);

  // Apply the scroll offset and the eased vertical scale synchronously after
  // every layout, so a new sample never renders one frame out of step.
  const applyShift = useCallback(() => {
    const dx = shift().toFixed(2);
    const k = renderedMaxRef.current / animMax.current;
    const scale = smoothScale && Number.isFinite(k) && k > 0 ? ` translate(0 ${baseline.toFixed(1)}) scale(1 ${k.toFixed(4)}) translate(0 ${(-baseline).toFixed(1)})` : "";
    scrollRef.current?.setAttribute("transform", `translate(${dx} 0)${scale}`);
    ticksRef.current?.setAttribute("transform", `translate(${dx} 0)`);
  }, [shift, smoothScale, baseline]);
  useLayoutEffect(() => {
    applyShift();
  }, [applyShift]);
  useEffect(() => {
    if (!live && !smoothScale) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      if (smoothScale) {
        const target = targetMax.current;
        const cur = animMax.current;
        animMax.current = Math.abs(target - cur) < target * 0.002 ? target : cur + (target - cur) * (1 - Math.exp(-dt / 450));
        // Re-draw against a fresh reference whenever the group has stretched
        // far from 1:1, so the paths never carry a big standing scale.
        const ratio = renderedMaxRef.current / animMax.current;
        if (ratio > 1.2 || ratio < 0.84) setRenderedMax(animMax.current);
      }
      applyShift();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [live, smoothScale, applyShift]);

  const allTs = useMemo(() => [...new Set(series.flatMap((s) => s.points.map((p) => p.ts)))].sort((a, b) => a - b), [series]);

  const nearest = (ts: number | null) => {
    if (ts === null || allTs.length === 0) return null;
    let best = allTs[0]!;
    let bestD = Math.abs(best - ts);
    for (const t of allTs) {
      const d = Math.abs(t - ts);
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  };
  const snap = nearest(hoverTs);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxV);
  const xTicks = 5;
  const empty = series.every((s) => s.points.length === 0);
  // Background grid: an 8×8 lattice filling the plot area exactly, outer edges
  // included. The 25% value ticks fall on every second line, so axis labels
  // still land on the grid where they are shown.
  const GRID_N = 8;
  const gridLines = Array.from({ length: GRID_N + 1 }, (_, i) => i / GRID_N);

  // Live ticks sit at absolute 10 s marks and scroll with the data; the
  // range covers the visible window plus the lag either side.
  const liveTicks: number[] = [];
  if (live) {
    const first = Math.ceil((from - lagMs - LIVE_TICK_MS) / LIVE_TICK_MS) * LIVE_TICK_MS;
    for (let t = first; t <= to + lagMs + LIVE_TICK_MS; t += LIVE_TICK_MS) liveTicks.push(t);
  }

  return (
    <div ref={boxRef} className={cx("relative", className)}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full"
        style={{ height }}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={(e) => {
          const rect = svgRef.current!.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const ts = from + ((px - PAD.l - shift()) / innerW) * span;
          setHoverTs(px < PAD.l || px > W - PAD.r || ts > to ? null : ts);
        }}
        onMouseLeave={() => setHoverTs(null)}
      >
        <defs>
          {/* Each fill fades from a tenth of its colour at the series' own
              peak to nothing at the baseline. */}
          {area &&
            series.map((s, i) => (
              <linearGradient key={s.name} id={`${uid}-g${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.1} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0} />
              </linearGradient>
            ))}
          <clipPath id={`${uid}-clip`}>
            <rect x={PAD.l} y={PAD.t} width={innerW} height={innerH} />
          </clipPath>
          {/* Scrolling labels dissolve over the last ~90 px each side rather than
              being sliced mid-word at the edge. */}
          <linearGradient id={`${uid}-fade`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#000" />
            <stop offset={Math.min(0.25, 90 / innerW)} stopColor="#fff" />
            <stop offset={1 - Math.min(0.25, 90 / innerW)} stopColor="#fff" />
            <stop offset="1" stopColor="#000" />
          </linearGradient>
          <mask id={`${uid}-fademask`} maskUnits="userSpaceOnUse" x={PAD.l} y={baseline} width={innerW} height={H - baseline}>
            <rect x={PAD.l} y={baseline} width={innerW} height={H - baseline} fill={`url(#${uid}-fade)`} />
          </mask>
        </defs>

        {gridLines.map((f) => (
          <line key={`h${f}`} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + innerH * f} y2={PAD.t + innerH * f} stroke="var(--grid)" strokeWidth={1} />
        ))}
        {gridLines.map((f) => (
          <line key={`v${f}`} x1={PAD.l + innerW * f} x2={PAD.l + innerW * f} y1={PAD.t} y2={baseline} stroke="var(--grid)" strokeWidth={1} />
        ))}
        {yAxis &&
          yTicks.map((v) => (
            <text key={v} x={PAD.l - 8} y={y(v) + 4} textAnchor="end" fontSize={13} fill="var(--ink-3)" className="tnum">
              {formatValue(v)}
            </text>
          ))}
        {/* Time labels are formatted in the viewer's timezone, so the server's
            value (UTC in the container) legitimately differs from the client's. */}
        {!live &&
          Array.from({ length: xTicks + 1 }, (_, i) => from + (span * i) / xTicks).map((ts, i) => (
            <text key={i} x={x(ts)} y={H - 6} textAnchor={i === 0 ? "start" : i === xTicks ? "end" : "middle"} fontSize={13} fill="var(--ink-3)" suppressHydrationWarning>
              {timeLabel(ts, span)}
            </text>
          ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={baseline} y2={baseline} stroke="var(--line-strong)" strokeWidth={1} />

        {live && (
          <g mask={`url(#${uid}-fademask)`}>
            <g ref={ticksRef}>
              {liveTicks.map((ts) => (
                <g key={ts}>
                  <line x1={x(ts)} x2={x(ts)} y1={baseline} y2={baseline + 4} stroke="var(--line-strong)" strokeWidth={1} />
                  <text x={x(ts)} y={H - 6} textAnchor="middle" fontSize={13} fill="var(--ink-3)" className="tnum" suppressHydrationWarning>
                    {timeLabel(ts, span)}
                  </text>
                </g>
              ))}
            </g>
          </g>
        )}
        <g clipPath={`url(#${uid}-clip)`}>
          <g ref={scrollRef}>
            {series.map((s, i) => {
              if (s.points.length === 0) return null;
              const pts = s.points.map((p) => ({ x: x(p.ts), y: y(p.v) }));
              const line = smooth ? monotonePath(pts) : linearPath(pts);
              const areaPath = `${line} L ${pts[pts.length - 1]!.x.toFixed(1)} ${baseline.toFixed(1)} L ${pts[0]!.x.toFixed(1)} ${baseline.toFixed(1)} Z`;
              return (
                <g key={s.name}>
                  {/* Flat, translucent fill so overlapping series read through each other. */}
                  {area && <path d={areaPath} fill={`url(#${uid}-g${i})`} />}
                  <path d={line} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                </g>
              );
            })}
            {snap !== null && (
              <g>
                <line x1={x(snap)} x2={x(snap)} y1={PAD.t} y2={baseline} stroke="var(--ink-3)" strokeWidth={1} />
                {series.map((s) => {
                  const p = s.points.find((q) => q.ts === snap);
                  if (!p) return null;
                  return <circle key={s.name} cx={x(p.ts)} cy={y(p.v)} r={4} fill={s.color} stroke="var(--glass-strong)" strokeWidth={2} />;
                })}
              </g>
            )}
          </g>
        </g>

        {empty && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={12} fill="var(--ink-3)">
            No samples in this range yet
          </text>
        )}
      </svg>
      {snap !== null && (
        <div
          className="glass-strong pointer-events-none absolute top-2 rounded-xl px-3 py-2 text-xs"
          style={{ left: `calc(${(((x(snap) + shift()) / W) * 100).toFixed(2)}% + 8px)`, transform: x(snap) + shift() > W * 0.7 ? "translateX(calc(-100% - 16px))" : undefined }}
        >
          <div className="mb-1 text-ink-3">{new Date(snap).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })}</div>
          {series.map((s) => {
            const p = s.points.find((q) => q.ts === snap);
            return (
              <div key={s.name} className="flex items-center gap-2">
                <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
                <span className="tnum font-medium text-ink">{p ? formatValue(p.v) : "—"}</span>
                <span className="text-ink-2">{s.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Legend({ series }: { series: Array<{ name: string; color: string }> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {series.map((s) => (
        <span key={s.name} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4" style={{ background: s.color }} /> {s.name}
        </span>
      ))}
    </div>
  );
}
