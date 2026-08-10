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
};

export default nextConfig;
