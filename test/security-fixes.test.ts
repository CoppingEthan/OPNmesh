/**
 * Regression guards for security fixes found in the multi-agent audit.
 * Each test fails against the pre-fix code and passes after it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { agentReportSchema } from "../lib/control/schemas.js";
import { loadSitesYaml } from "../lib/schema.js";
import { generateAll } from "../lib/generator/index.js";
import { runValidators } from "../lib/validators/index.js";

/** The reference topology as a mutable YAML document. */
function referenceDoc(): any {
  return parseYaml(readFileSync(join(process.cwd(), "test", "fixtures", "reference.yml"), "utf8"));
}

describe("metrics label injection (node version)", () => {
  it("rejects a version carrying a newline or quote", () => {
    // Would have broken out of a Prometheus /metrics label and forged another
    // node's health line, or blinded the whole scrape.
    expect(agentReportSchema.safeParse({ version: 'x"} 1\nopnmesh_up 1' }).success).toBe(false);
    expect(agentReportSchema.safeParse({ version: "1.4.0\nmalicious 1" }).success).toBe(false);
  });
  it("accepts a normal build version", () => {
    const r = agentReportSchema.safeParse({ version: "1.4.0" });
    expect(r.success).toBe(true);
  });
});

describe("router-instruction injection via name", () => {
  it("rejects a site name containing a line break", () => {
    const doc = referenceDoc();
    doc.sites[0].name = "Head Office\n10.66.66.0/24 via 10.10.0.2   # forged";
    expect(() => loadSitesYaml(stringifyYaml(doc))).toThrow();
  });

  it("still accepts an ordinary site name", () => {
    const doc = referenceDoc();
    doc.sites[0].name = "Head Office (Floor 3)";
    expect(() => loadSitesYaml(stringifyYaml(doc))).not.toThrow();
  });
});

describe("near-default supernet in AllowedIPs", () => {
  it("flags a /1 LAN that the /0-only guard used to miss", () => {
    const doc = referenceDoc();
    doc.sites[0].lan = "128.0.0.0/1";
    const cfg = loadSitesYaml(stringifyYaml(doc));
    const findings = runValidators(cfg, generateAll(cfg));
    const defaultRoute = findings.filter((f) => f.code === "default-route" && f.level === "error");
    expect(defaultRoute.length).toBeGreaterThan(0);
  });
});
