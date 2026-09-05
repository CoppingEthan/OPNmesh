import { withAdmin } from "@/server/http";
import { liveState } from "@/server/live";
import { buildState } from "@/server/state";

export const dynamic = "force-dynamic";

const PUSH_MS = 1000;

/**
 * Server-Sent Events: the full dashboard state once a second (the live
 * series moves every second even when gateways report less often), sooner
 * when a gateway has just reported. One connection per open dashboard.
 */
export const GET = withAdmin(async (req) => {
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  // ?fast=1 (the overview) asks gateways to report every second while open.
  const fast = new URL(req.url).searchParams.get("fast") === "1";
  let fastRegistered = false;
  const leave = () => {
    if (fastRegistered) {
      fastRegistered = false;
      liveState().removeFastViewer();
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (fast) {
        liveState().addFastViewer();
        fastRegistered = true;
      }
      let dirty = false;
      let last = 0;
      const send = () => {
        try {
          controller.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify(buildState())}\n\n`));
          last = Date.now();
          dirty = false;
        } catch {
          /* closed */
        }
      };
      send();
      unsubscribe = liveState().subscribe(() => {
        dirty = true;
      });
      timer = setInterval(() => {
        if (dirty && Date.now() - last > 400) send();
        else if (Date.now() - last >= PUSH_MS) send();
      }, 250);
    },
    cancel() {
      if (timer) clearInterval(timer);
      if (unsubscribe) unsubscribe();
      leave();
    },
  });
  req.signal.addEventListener("abort", () => {
    if (timer) clearInterval(timer);
    if (unsubscribe) unsubscribe();
    leave();
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
