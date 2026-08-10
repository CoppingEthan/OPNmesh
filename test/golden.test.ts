/**
 * Golden-file tests: every generated artifact for every fixture is compared
 * byte-for-byte (modulo line endings) against a reviewed golden copy.
 * Regenerate deliberately with: npm run goldens:update — then review the diff.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateAll, type GeneratedBundle } from "../lib/generator/index.js";
import { FIXTURES, loadFixture } from "./helpers.js";

const UPDATE = process.env["UPDATE_GOLDENS"] === "1";

function flattenBundle(bundle: GeneratedBundle): Map<string, string> {
  const files = new Map<string, string>();
  for (const [id, node] of Object.entries(bundle.nodes)) {
    for (const [path, content] of Object.entries(node.files)) files.set(`${id}/${path}`, content);
    files.set(`${id}/meta.json`, JSON.stringify(node.meta, null, 2) + "\n");
  }
  for (const [id, c] of Object.entries(bundle.clients)) files.set(`clients/${id}.conf`, c.config);
  for (const [id, text] of Object.entries(bundle.routers)) files.set(`routers/${id}.txt`, text);
  return files;
}

const normalize = (s: string) => s.replace(/\r\n/g, "\n");

describe.each(FIXTURES)("golden output: %s", (fixture) => {
  const files = flattenBundle(generateAll(loadFixture(fixture)));

  it("matches all golden files", () => {
    for (const [rel, content] of files) {
      const goldenPath = join(process.cwd(), "test", "golden", fixture, rel);
      if (UPDATE) {
        mkdirSync(dirname(goldenPath), { recursive: true });
        writeFileSync(goldenPath, content, "utf8");
        continue;
      }
      expect(existsSync(goldenPath), `missing golden file ${goldenPath}`).toBe(true);
      expect(normalize(content), `mismatch for ${fixture}/${rel}`).toBe(
        normalize(readFileSync(goldenPath, "utf8")),
      );
    }
  });

  it("has no stray golden files", () => {
    if (UPDATE) return;
    // Every golden file must correspond to a currently generated artifact.
    const goldenRoot = join(process.cwd(), "test", "golden", fixture);
    const walk = (dir: string): string[] => {
      return readdirSync(dir).flatMap((entry: string) => {
        const p = join(dir, entry);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    };
    const present = walk(goldenRoot).map((p) =>
      p.slice(goldenRoot.length + 1).replace(/\\/g, "/"),
    );
    for (const rel of present) {
      expect(files.has(rel), `stray golden file ${rel} — no longer generated`).toBe(true);
    }
  });
});
