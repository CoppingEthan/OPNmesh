// ESLint flat config: the Next.js rule set (core web vitals + TypeScript).
// `next lint` no longer exists in Next 16, so `npm run lint` runs ESLint directly.
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  globalIgnores([".next/**", "out/**", "coverage/**", "node_modules/**", "agent/**", "sim/state/**", "public/**", "branding/**", "screenshots/**", "next-env.d.ts"]),
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Unused variables are an error, except deliberately discarded ones
      // (`const { secret: _s, ...rest } = row`).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    // Tests poke at API payloads as they arrive; typing every one adds nothing.
    files: ["test/**", "sim/test/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
]);
