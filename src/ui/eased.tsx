"use client";

import { useEffect, useRef, useState } from "react";
import { formatBits } from "./format";

/**
 * A number that glides toward its target instead of jumping. Live figures
 * arrive in steps (one sample a second); an exponential approach with a
 * time constant of `tauMs` turns the steps into a smooth read-out, and is
 * frame-rate independent so it feels the same at 60 Hz and 144 Hz. A longer
 * tau also low-passes sample-to-sample noise, which is what keeps a busy
 * headline figure from twitching. Re-renders only when the text changes.
 */
export function useEased(target: number, format: (v: number) => string, tauMs = 1200): string {
  const [text, setText] = useState(() => format(target));
  const ref = useRef({ shown: target, target, text: format(target) });
  useEffect(() => {
    ref.current.target = target;
  }, [target]);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      const r = ref.current;
      const diff = r.target - r.shown;
      if (Math.abs(diff) < Math.max(1, Math.abs(r.target) * 0.002)) r.shown = r.target;
      else r.shown += diff * (1 - Math.exp(-dt / tauMs));
      const next = format(r.shown);
      if (next !== r.text) {
        r.text = next;
        setText(next);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [format, tauMs]);
  return text;
}

export function EasedBits({ value, tauMs }: { value: number; tauMs?: number }) {
  return <>{useEased(value, formatBits, tauMs)}</>;
}
