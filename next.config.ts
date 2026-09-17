import type { NextConfig } from "next";

/**
 * Next.js emits inline bootstrap scripts and the pages use style attributes,
 * so both need 'unsafe-inline': a nonce would need a request proxy, which
 * this app does not have. What the policy still stops is loading anything
 * from another origin, plugins, <base> rewrites and framing. Development
 * adds 'unsafe-eval', which React's debugging aids need there.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/**
 * Code that reads files relative to process.cwd() (/dl, /install.sh, the data
 * directory) makes the tracer copy the whole project into the build output.
 * Keep runtime data, secrets and development material out of it, even when
 * they sit untracked in the checkout being built.
 */
const traceExcludes = [
  ".git/**",
  "data/**",
  "backups/**",
  "sim/**",
  "test/**",
  "scripts/**",
  ".test-data/**",
  "coverage/**",
  "**/.env*",
  "**/*.key",
  "**/*.pem",
  "**/*.token",
  "**/*.db",
  "**/*.db-*",
];

/**
 * Standalone output produces a self-contained server.js for the Docker image.
 * better-sqlite3 and argon2 are native modules and must not be bundled.
 */
const config: NextConfig = {
  output: process.env["OPNMESH_STANDALONE"] === "1" ? "standalone" : undefined,
  serverExternalPackages: ["better-sqlite3", "argon2"],
  // Keys match route paths. Turbopack does not apply this to the trace of
  // instrumentation.ts, which still picks up data/secret.key from a local
  // checkout; image builds never see data/ (.dockerignore).
  outputFileTracingExcludes: { "/**": traceExcludes },
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: false,
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    },
  ],
};

export default config;
