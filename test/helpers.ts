import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSitesYaml, type ResolvedConfig } from "../lib/schema.js";

export const FIXTURES = ["reference", "custom-ports", "single-hub", "multi-hub"] as const;
export type FixtureName = (typeof FIXTURES)[number];

export function fixtureText(name: FixtureName): string {
  return readFileSync(join(process.cwd(), "test", "fixtures", `${name}.yml`), "utf8");
}

export function loadFixture(name: FixtureName): ResolvedConfig {
  return loadSitesYaml(fixtureText(name));
}

/** Deep-clone a resolved config so tests can mutate it safely. */
export function mutate(cfg: ResolvedConfig, fn: (c: ResolvedConfig) => void): ResolvedConfig {
  const copy = structuredClone(cfg);
  fn(copy);
  return copy;
}
