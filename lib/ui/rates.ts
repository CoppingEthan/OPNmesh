/**
 * Live per-link throughput as published by the control server.
 *
 * Rates are computed there, not here: the control server is the one long-lived
 * process that sees every agent report, so it can difference cumulative
 * counters reliably. The UI would lose that baseline on every restart (and, in
 * dev, on every module re-evaluation).
 */
import type { RateLookup } from "./graph.js";

export function toRateLookup(
  rates: Record<string, { aToB: number; bToA: number }> | undefined,
): RateLookup {
  const map: RateLookup = new Map();
  for (const [key, value] of Object.entries(rates ?? {})) map.set(key, value);
  return map;
}
