/**
 * Golden files: every scenario's generated bundle is committed under
 * test/golden/<scenario>/ and compared byte for byte. Regenerate on purpose
 * with `npm run goldens:update` and review the diff — a changed byte in a
 * WireGuard or nftables file is a change to what runs on every gateway.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateAll } from "@/core/generate";
import { scenarios } from "../fixtures/snapshots";

const GOLDEN_DIR = join(__dirname, "..", "golden");
const UPDATE = process.env["UPDATE_GOLDENS"] === "1";

function filesFor(name: string): Record<string, string> {
  const snap = scenarios[name]!();
  const bundle = generateAll(snap);
  const out: Record<string, string> = {};
  for (const g of Object.values(bundle.gateways)) {
    out[`${g.siteSlug}.wireguard.conf`] = g.files["wireguard.conf"];
    out[`${g.siteSlug}.nftables.conf`] = g.files["nftables.conf"];
    out[`${g.siteSlug}.sysctl.conf`] = g.files["sysctl.conf"];
  }
  for (const [id, c] of Object.entries(bundle.clients)) {
    const slug = snap.clients.find((x) => x.id === id)!.slug;
    out[`client.${slug}.conf`] = c.conf;
  }
  for (const r of Object.values(bundle.routers)) out[`${r.siteSlug}.router.json`] = JSON.stringify(r, null, 2) + "\n";
  return out;
}

describe("golden output", () => {
  for (const name of Object.keys(scenarios)) {
    it(name, () => {
      const dir = join(GOLDEN_DIR, name);
      const files = filesFor(name);
      if (UPDATE) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text, "utf8");
        return;
      }
      expect(existsSync(dir), `missing golden dir ${dir} — run npm run goldens:update`).toBe(true);
      const onDisk = readdirSync(dir).sort();
      expect(Object.keys(files).sort()).toEqual(onDisk);
      for (const [f, text] of Object.entries(files)) {
        expect(text, f).toBe(readFileSync(join(dir, f), "utf8"));
      }
    });
  }
});
