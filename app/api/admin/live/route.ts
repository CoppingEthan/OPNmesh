import { sessionFromToken, tokenFromRequest } from "@/server/auth";
import { json, withAdmin } from "@/server/http";
import { liveState } from "@/server/live";
import { onShutdown, stopping } from "@/server/shutdown";
import { buildState } from "@/server/state";

export const dynamic = "force-dynamic";

const PUSH_MS = 1000;
/** How often an open stream checks that its session is still valid. */
const SESSION_CHECK_MS = 5000;
/** Streams end after this long; the browser reconnects, and the session is checked again. */
const MAX_STREAM_MS = 15 * 60 * 1000;
const MAX_STREAMS_PER_SESSION = 8;
const MAX_STREAMS = 64;

const g = globalThis as unknown as { __opnmeshLiveStreams?: Map<string, number> };
const open = (g.__opnmeshLiveStreams ??= new Map<string, number>());
const totalOpen = () => [...open.values()].reduce((a, b) => a + b, 0);

/**
 * Server-Sent Events: the full dashboard state once a second (the live
 * series moves every second even when gateways report less often), sooner
 * when a gateway has just reported. One connection per open dashboard.
 *
 * A stream stops when its session ends (sign-out, password change, expiry),
 * after MAX_STREAM_MS, when the client disconnects, or when the controller
 * stops. A client that stops reading is skipped rather than buffered for.
 */
export const GET = withAdmin(async (req, { admin }) => {
  if (stopping()) return json({ error: "the controller is stopping" }, 503);
  if ((open.get(admin.sessionId) ?? 0) >= MAX_STREAMS_PER_SESSION || totalOpen() >= MAX_STREAMS) {
    return json({ error: "too many live connections" }, 429);
  }
  open.set(admin.sessionId, (open.get(admin.sessionId) ?? 0) + 1);
  const token = tokenFromRequest(req);
  const enc = new TextEncoder();
  const started = Date.now();
  // ?fast=1 (the overview) asks gateways to report every second while open.
  const fast = new URL(req.url).searchParams.get("fast") === "1";
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  let close: () => void = () => undefined;
  let offShutdown: () => void = () => undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (unsubscribe) unsubscribe();
    offShutdown();
    if (fast) liveState().removeFastViewer();
    const n = (open.get(admin.sessionId) ?? 1) - 1;
    if (n > 0) open.set(admin.sessionId, n);
    else open.delete(admin.sessionId);
    close();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (fast) liveState().addFastViewer();
      close = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      let dirty = false;
      let last = 0;
      let checked = started;
      const send = () => {
        if ((controller.desiredSize ?? 1) <= 0) return; // the client is not reading: skip, never queue
        try {
          controller.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify(buildState())}\n\n`));
          last = Date.now();
          dirty = false;
        } catch {
          stop();
        }
      };
      controller.enqueue(enc.encode("retry: 2000\n\n"));
      send();
      unsubscribe = liveState().subscribe(() => {
        dirty = true;
      });
      timer = setInterval(() => {
        const t = Date.now();
        if (t - started >= MAX_STREAM_MS) return stop();
        if (t - checked >= SESSION_CHECK_MS) {
          checked = t;
          if (!sessionFromToken(token)) return stop();
        }
        if (dirty && t - last > 400) send();
        else if (t - last >= PUSH_MS) send();
      }, 250);
    },
    cancel() {
      stop();
    },
  });
  req.signal.addEventListener("abort", stop);
  // An open stream would otherwise hold the server open through a restart.
  offShutdown = onShutdown(stop);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // The connection ends with the stream, rather than idling for the
      // keep-alive timeout: a stopping server waits for idle connections too.
      Connection: "close",
      "X-Accel-Buffering": "no",
    },
  });
});
