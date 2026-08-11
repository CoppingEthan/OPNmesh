"use client";

/**
 * Last-resort boundary: catches failures in the root layout itself, where the
 * normal error page cannot render. It must supply its own <html>/<body>.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          background: "#09090b",
          color: "#e4e4e7",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          padding: "3rem",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>OPNmesh could not start this page</h1>
        <p style={{ color: "#a1a1aa", marginTop: "0.5rem" }}>
          Your network is unaffected — tunnels run from configuration already on each gateway.
        </p>
        <pre
          style={{
            marginTop: "1rem",
            padding: "0.75rem",
            background: "#000",
            border: "1px solid #27272a",
            borderRadius: 4,
            fontSize: "0.8rem",
            overflowX: "auto",
          }}
        >
          {error.message}
          {error.digest ? `\n\nReference ${error.digest}` : ""}
        </pre>
        <button
          onClick={() => reset()}
          style={{
            marginTop: "1rem",
            padding: "0.5rem 0.9rem",
            background: "#18181b",
            color: "#e4e4e7",
            border: "1px solid #3f3f46",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
