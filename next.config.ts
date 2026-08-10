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
              // Next injects inline bootstrap scripts; styles are emitted inline by Tailwind.
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self'",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'none'",
              "form-action 'self'",
              "object-src 'none'",
            ].join("; "),
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Keeps one-time tokens and node names out of third-party referers.
          { key: "Referrer-Policy", value: "no-referrer" },
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
