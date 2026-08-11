import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the control-node image.
  output: "standalone",
  // Native modules used server-side only.
  serverExternalPackages: ["better-sqlite3", "argon2", "simple-git"],
  webpack: (config) => {
    // lib/ uses NodeNext-style ".js" specifiers (shared with tsx/vitest).
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  // Do not advertise the framework or version to an attacker.
  poweredByHeader: false,
  async headers() {
    const isDev = process.env.NODE_ENV !== "production";
    return [
      {
        source: "/:path*",
        headers: [
          // The panel renders no third-party content and needs no inline
          // styles beyond Tailwind's emitted stylesheet.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Next injects inline bootstrap scripts; styles are emitted
              // inline by Tailwind. The dev server additionally compiles
              // modules with eval() for hot reload — without 'unsafe-eval'
              // there, every client script is blocked, forms lose their
              // JavaScript handlers, and the app silently half-works.
              `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self'",
              // Dev uses a websocket for hot reload.
              `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
              "frame-ancestors 'none'",
              "base-uri 'none'",
              "form-action 'self'",
              "object-src 'none'",
            ].join("; "),
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Deliberately NOT "no-referrer": browsers then send `Origin: null`
          // on form posts, and Next's server-action CSRF check rejects that,
          // which breaks every form in the app. "same-origin" still sends
          // nothing to third parties, which is the property we actually want.
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
