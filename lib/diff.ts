/**
 * Bundle diffing — the primitive behind config preview and the update
 * pre-flight config-neutrality gate (§11: a software update must never change
 * WireGuard configuration as a side effect; a non-empty diff blocks a rollout).
 */
import type { GeneratedBundle } from "./generator/index.js";

export interface FileChange {
  path: string;
  kind: "added" | "removed" | "changed";
}

function flatten(bundle: GeneratedBundle): Map<string, string> {
  const files = new Map<string, string>();
  for (const [id, node] of Object.entries(bundle.nodes)) {
    for (const [path, content] of Object.entries(node.files)) {
      files.set(`nodes/${id}/${path}`, content);
    }
  }
  for (const [id, c] of Object.entries(bundle.clients)) {
    files.set(`clients/${id}/wg.conf`, c.config);
  }
  for (const [id, text] of Object.entries(bundle.routers)) {
    files.set(`routers/${id}.txt`, text);
  }
  return files;
}

/** Changed files between two generated bundles. Empty array = config-neutral. */
export function diffBundles(before: GeneratedBundle, after: GeneratedBundle): FileChange[] {
  const a = flatten(before);
  const b = flatten(after);
  const out: FileChange[] = [];
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const path of paths) {
    const inA = a.has(path);
    const inB = b.has(path);
    if (inA && !inB) out.push({ path, kind: "removed" });
    else if (!inA && inB) out.push({ path, kind: "added" });
    else if (a.get(path) !== b.get(path)) out.push({ path, kind: "changed" });
  }
  return out;
}

export function isConfigNeutral(before: GeneratedBundle, after: GeneratedBundle): boolean {
  return diffBundles(before, after).length === 0;
}
