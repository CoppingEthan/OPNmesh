"use client";

import { useEffect, useRef, useState } from "react";
import type { StatePayload } from "@/server/state";

/**
 * Live dashboard state: starts from the server-rendered payload, then follows
 * the SSE stream. Falls back to polling if the stream cannot be opened.
 */
export function useLiveState(initial: StatePayload, opts: { fast?: boolean } = {}): { state: StatePayload; connected: boolean } {
  const [state, setState] = useState(initial);
  const [connected, setConnected] = useState(false);
  const failures = useRef(0);
  const fast = opts.fast === true;

  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const startPolling = () => {
      if (poll) return;
      poll = setInterval(async () => {
        try {
          const res = await fetch("/api/admin/state", { credentials: "same-origin" });
          if (res.ok) setState(await res.json());
        } catch {
          /* keep last */
        }
      }, 5000);
    };

    const connect = () => {
      if (closed) return;
      es = new EventSource(fast ? "/api/admin/live?fast=1" : "/api/admin/live");
      es.addEventListener("state", (ev) => {
        try {
          setState(JSON.parse((ev as MessageEvent).data));
          setConnected(true);
          failures.current = 0;
        } catch {
          /* ignore malformed */
        }
      });
      es.onerror = () => {
        setConnected(false);
        failures.current += 1;
        es?.close();
        es = null;
        if (failures.current >= 3) startPolling();
        else setTimeout(connect, 2000 * failures.current);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, [fast]);

  return { state, connected };
}
