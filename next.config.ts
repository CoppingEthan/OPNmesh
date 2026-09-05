import type { NextConfig } from "next";

/**
 * Standalone output produces a self-contained server.js for the Docker image.
 * better-sqlite3 and argon2 are native modules and must not be bundled.
 */
const config: NextConfig = {
  output: process.env["OPNMESH_STANDALONE"] === "1" ? "standalone" : undefined,
  serverExternalPackages: ["better-sqlite3", "argon2"],
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: false,
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    },
  ],
};

export default config;
