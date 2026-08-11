"use client";

/**
 * Anything that throws while rendering a page lands here. Without it, Next
 * shows a blank white screen — which is indistinguishable from "the app is
 * broken and I have no idea why".
 */
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("OPNmesh page error:", error);
  }, [error]);

  return (
    <div className="mx-auto mt-20 max-w-lg">
      <div className="card border-red-900">
        <h1 className="h1 mb-2">Something went wrong on this page</h1>
        <p className="mb-3 text-sm text-zinc-300">
          Your network is unaffected — the tunnels keep running whatever this panel does.
        </p>
        <pre className="conf">{error.message || "No error message was reported."}</pre>
        {error.digest && (
          <p className="mono mt-2 text-xs text-zinc-500">
            Reference {error.digest} — search the control node log for this to see the full detail.
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <button className="btn btn-primary" onClick={() => reset()}>
            Try again
          </button>
          <a className="btn" href="/">
            Back to overview
          </a>
        </div>
      </div>
    </div>
  );
}
