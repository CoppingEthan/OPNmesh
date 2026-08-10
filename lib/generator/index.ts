/**
 * Assemble the full generated bundle for a config: per-gateway files, per-client
 * configs, and per-site router instructions. This bundle is what agents pull,
 * what the config-preview UI diffs, and what update pre-flight compares for
 * config-neutrality.
 */
import type { ResolvedConfig } from "../schema.js";
import { arePeered } from "../topology.js";
import { generateGatewayConfig, generateClientConfig } from "./wireguard.js";
import { generateNftables } from "./nftables.js";
import { generateSysctl } from "./sysctl.js";
import { generateRouterInstructions } from "./router.js";

export interface NodeMeta {
  nodeId: string;
  role: "gateway";
  listenPort: number;
  /** Any peer endpoint is a hostname → the agent must enable the reresolve-dns timer. */
  needsReresolve: boolean;
  privateKeyPath: string;
}

/**
 * Runtime settings for the agent itself, shipped as a reconciled file so the
 * control panel drives exporter/flow behaviour centrally with no agent
 * restarts or redeploys.
 */
export interface AgentSettings {
  metrics_port: number;
  flows: boolean;
  flow_interval_sec: number;
  needs_reresolve: boolean;
}

export interface NodeBundle {
  /** Relative target path → file content. */
  files: Record<string, string>;
  meta: NodeMeta;
}

export interface GeneratedBundle {
  nodes: Record<string, NodeBundle>;
  clients: Record<string, { config: string }>;
  routers: Record<string, string>;
}

export function generateAll(cfg: ResolvedConfig): GeneratedBundle {
  const nodes: Record<string, NodeBundle> = {};
  for (const s of cfg.sites) {
    const wgConf = generateGatewayConfig(cfg, s.id);
    const peerEndpointsAreHostnames = cfg.sites.some(
      (p) => p.id !== s.id && p.gateway.endpointIsHostname && arePeered(cfg, s.id, p.id),
    );
    const settings: AgentSettings = {
      metrics_port: s.gateway.metricsPort,
      flows: s.gateway.flows,
      flow_interval_sec: 30,
      needs_reresolve: peerEndpointsAreHostnames,
    };
    nodes[s.id] = {
      files: {
        "wg0.conf": wgConf,
        "nftables.conf": generateNftables(cfg, s.id),
        "sysctl.conf": generateSysctl(cfg, s.id),
        "agent-settings.json": JSON.stringify(settings, null, 2) + "\n",
      },
      meta: {
        nodeId: s.id,
        role: "gateway",
        listenPort: s.gateway.listenPort,
        needsReresolve: peerEndpointsAreHostnames,
        privateKeyPath: s.gateway.privateKeyPath,
      },
    };
  }

  const clients: Record<string, { config: string }> = {};
  for (const c of cfg.clients) {
    clients[c.id] = { config: generateClientConfig(cfg, c.id) };
  }

  const routers: Record<string, string> = {};
  for (const s of cfg.sites) {
    routers[s.id] = generateRouterInstructions(cfg, s.id);
  }

  return { nodes, clients, routers };
}
