/**
 * Assemble the full generated bundle: per-gateway files, per-client configs,
 * per-site router plans, and one hash over all of it. Agents pull their entry;
 * the UI previews and diffs it; validators check it.
 */
import { createHash } from "node:crypto";
import type { Snapshot } from "../model";
import { listenPortOf, meshSites, arePeered } from "../topology";
import { isHostname } from "../ip";
import { generateGatewayConf, generateClientConf } from "./wireguard";
import { generateNftables } from "./nftables";
import { generateSysctl } from "./sysctl";
import { generateRouterPlan, type RouterPlan } from "./router";

export const MANAGED_FILES = ["wireguard.conf", "nftables.conf", "sysctl.conf"] as const;
export type ManagedFile = (typeof MANAGED_FILES)[number];

export interface GatewayBundle {
  gatewayId: string;
  siteId: string;
  siteSlug: string;
  files: Record<ManagedFile, string>;
  meta: {
    interfaceName: string;
    listenPort: number;
    /** A peer endpoint is a hostname → the agent must re-resolve periodically. */
    needsReresolve: boolean;
    privateKeyPath: string;
  };
  /** Hash of this gateway's files only — what the agent compares and reports. */
  hash: string;
}

export interface Bundle {
  gateways: Record<string, GatewayBundle>;
  clients: Record<string, { conf: string }>;
  routers: Record<string, RouterPlan>;
  hash: string;
}

export function hashFiles(files: Record<string, string>): string {
  const h = createHash("sha256");
  for (const name of Object.keys(files).sort()) h.update(`${name}\0${files[name]}\0`);
  return h.digest("hex");
}

export function generateAll(snap: Snapshot): Bundle {
  const gateways: Record<string, GatewayBundle> = {};
  for (const s of meshSites(snap)) {
    const files: Record<ManagedFile, string> = {
      "wireguard.conf": generateGatewayConf(snap, s.id),
      "nftables.conf": generateNftables(snap, s.id),
      "sysctl.conf": generateSysctl(snap, s.id),
    };
    const needsReresolve = meshSites(snap).some(
      (p) =>
        p.id !== s.id &&
        p.gateway.endpointHost !== null &&
        isHostname(p.gateway.endpointHost) &&
        arePeered(snap, s.id, p.id),
    );
    gateways[s.gateway.id] = {
      gatewayId: s.gateway.id,
      siteId: s.id,
      siteSlug: s.slug,
      files,
      meta: {
        interfaceName: snap.settings.interfaceName,
        listenPort: listenPortOf(snap, s),
        needsReresolve,
        privateKeyPath: snap.settings.privateKeyPath,
      },
      hash: hashFiles(files),
    };
  }

  const clients: Record<string, { conf: string }> = {};
  for (const c of snap.clients) {
    if (!c.enabled) continue;
    clients[c.id] = { conf: generateClientConf(snap, c.id) };
  }

  const routers: Record<string, RouterPlan> = {};
  for (const s of meshSites(snap)) routers[s.id] = generateRouterPlan(snap, s.id);

  const h = createHash("sha256");
  for (const id of Object.keys(gateways).sort()) h.update(`${id}\0${gateways[id]!.hash}\0`);
  for (const id of Object.keys(clients).sort()) h.update(`${id}\0${clients[id]!.conf}\0`);
  for (const id of Object.keys(routers).sort()) h.update(`${id}\0${JSON.stringify(routers[id])}\0`);

  return { gateways, clients, routers, hash: h.digest("hex") };
}
