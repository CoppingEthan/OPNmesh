/**
 * Config truth access for the UI: read sites.yml, validate, write, and record
 * every change in the LOCAL config git repository (§4 repository 2 — created
 * in place, no remote, never pushed anywhere). SQLite is never involved:
 * configuration truth lives in the file and its history in git.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { simpleGit } from "simple-git";
import { writeFileAtomic } from "../fs-atomic.js";
import { loadSitesYaml, type ResolvedConfig } from "../schema.js";
import { generateAll, type GeneratedBundle } from "../generator/index.js";
import { runValidators, type Finding } from "../validators/index.js";
import { connectivityMatrix, spofAnalysis, type MatrixEntry, type SpofReport } from "../topology.js";
import { STATE_DIR, SITES_PATH } from "./env.js";

export interface SitesView {
  cfg: ResolvedConfig;
  bundle: GeneratedBundle;
  findings: Finding[];
  matrix: MatrixEntry[];
  spof: SpofReport[];
  raw: string;
}

export function loadSites(): SitesView {
  const raw = readFileSync(SITES_PATH, "utf8");
  const cfg = loadSitesYaml(raw);
  const bundle = generateAll(cfg);
  return {
    cfg,
    bundle,
    findings: runValidators(cfg, bundle),
    matrix: connectivityMatrix(cfg),
    spof: spofAnalysis(cfg),
    raw,
  };
}

async function commitConfig(message: string): Promise<void> {
  const git = simpleGit(STATE_DIR);
  if (!existsSync(`${STATE_DIR}/.git`)) {
    await git.init();
    await git.addConfig("user.name", "opnmesh");
    await git.addConfig("user.email", "opnmesh@localhost");
  }
  await git.add("sites.yml");
  await git.commit(message);
}

/**
 * Apply a mutation to the raw YAML document, validate the result end to end
 * (schema + all semantic validators; errors block), then persist and commit
 * with a descriptive message. Returns non-blocking warnings.
 */
export async function editSites(message: string, fn: (doc: any) => void): Promise<Finding[]> {
  const raw = readFileSync(SITES_PATH, "utf8");
  const doc = parseYaml(raw);
  fn(doc);
  const next = stringifyYaml(doc);
  const cfg = loadSitesYaml(next); // throws on structural problems
  const findings = runValidators(cfg, generateAll(cfg));
  const errors = findings.filter((f) => f.level === "error");
  if (errors.length > 0) {
    throw new Error(`change blocked by validators:\n${errors.map((e) => `- ${e.message}`).join("\n")}`);
  }
  writeFileAtomic(SITES_PATH, next);
  await commitConfig(message);
  return findings.filter((f) => f.level === "warning");
}

export async function configHistory(limit = 30): Promise<Array<{ hash: string; date: string; message: string }>> {
  const git = simpleGit(STATE_DIR);
  if (!existsSync(`${STATE_DIR}/.git`)) return [];
  try {
    const log = await git.log({ maxCount: limit });
    return log.all.map((l) => ({ hash: l.hash.slice(0, 8), date: l.date, message: l.message }));
  } catch {
    return []; // repo exists but has no commits yet
  }
}
