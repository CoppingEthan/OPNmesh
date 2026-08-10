/**
 * Zod schema for sites.yml — the single source of truth for the whole mesh.
 *
 * Two layers:
 *  1. `sitesFileSchema` validates the raw YAML shape (strict: unknown keys are
 *     errors, so typos fail loudly instead of being silently ignored).
 *  2. `resolveConfig` fills defaults that depend on sibling values (ports, MTU,
 *     client entry points) and checks referential integrity, producing the
 *     `ResolvedConfig` everything downstream consumes.
 *
 * Private keys have no place in this file's schema by design: the only
 * key-shaped field is `public_key`, and objects are strict, so a `private_key`
 * field anywhere is a parse error.
 */
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { isValidCidr, isValidIpv4, isHostname } from "./ip.js";

const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "ids are lowercase alphanumerics and hyphens");

const ipv4Schema = z.string().refine(isValidIpv4, { message: "not a valid IPv4 address" });

const cidrSchema = z.string().refine(isValidCidr, { message: "not a valid IPv4 CIDR" });

/** 32 bytes base64 → 43 chars + '='. Applies to public keys only; private keys never appear. */
const wgKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, "not a valid WireGuard key (44-char base64)");

const portSchema = z.number().int().min(1).max(65535);

/** Endpoint is a host only — the port is always derived from the owning node's listen_port. */
const endpointSchema = z
  .string()
  .refine((s) => !s.includes(":"), {
    message: "endpoint must be a host only; the port comes from that node's listen_port",
  })
  .refine((s) => isValidIpv4(s) || isHostname(s), {
    message: "endpoint must be an IPv4 address or hostname",
  });

const gatewaySchema = z
  .object({
    /** Display name — cosmetic, never appears in generated WireGuard config. */
    name: z.string().min(1).optional(),
    /** The gateway's address on its own site LAN — the next hop the site router points at. */
    lan_ip: ipv4Schema,
    tunnel_ip: ipv4Schema,
    /** null = no reachable inbound UDP (behind NAT); peers learn the endpoint from handshakes. */
    endpoint: endpointSchema.nullable(),
    listen_port: portSchema.optional(),
    public_key: wgKeySchema,
    mtu: z.number().int().optional(),
    private_key_path: z.string().min(1).optional(),
    /** Prometheus exporter port on this node. */
    metrics_port: portSchema.optional(),
    /** Tier-3 per-host flow records — opt-in per gateway (§13). */
    flows: z.boolean().default(false),
  })
  .strict();

/**
 * One LAN segment behind a gateway. A single-VLAN site has one; an office with
 * VLANs has several. `role` decides how the mesh treats it:
 *   standard   — advertised to every reachable site (the default)
 *   management — advertised, but reachable only from policy.management
 *                admin sources, and never allowed to initiate across the mesh
 *   guest      — NEVER advertised: stays local to its site, no mesh route
 *                exists for it in any direction
 */
const lanSchema = z
  .object({
    cidr: cidrSchema,
    /** Display name, e.g. "Staff", "Voice", "CCTV". Cosmetic. */
    name: z.string().min(1).optional(),
    /** 802.1Q VLAN id, documentation only — OPNmesh never configures switches. */
    vlan: z.number().int().min(1).max(4094).optional(),
    role: z.enum(["standard", "management", "guest"]).default("standard"),
  })
  .strict();

const siteSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    /** Single-subnet shorthand. Exactly one of `lan` or `lans` is required. */
    lan: cidrSchema.optional(),
    /** Multi-VLAN sites list every segment here. */
    lans: z.array(lanSchema).min(1).optional(),
    gateway: gatewaySchema,
  })
  .strict()
  .refine((s) => (s.lan === undefined) !== (s.lans === undefined), {
    message: "each site needs exactly one of `lan` (single subnet) or `lans` (multiple VLANs)",
  });

const clientSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).optional(),
    tunnel_ip: ipv4Schema,
    public_key: wgKeySchema,
    /** Ordered preference. Omitted = every eligible site (has an inbound endpoint). */
    entry_points: z.array(idSchema).min(1).optional(),
    /** Cosmetic/DNS-level only; any site is allowed. */
    home_site: idSchema,
    mtu: z.number().int().optional(),
  })
  .strict();

const networkSchema = z
  .object({
    name: z.string().min(1).optional(),
    gateway_subnet: cidrSchema.default("10.99.0.0/24"),
    client_subnet: cidrSchema.default("10.99.1.0/24"),
    /** Default only — every node may override. Never hardcoded downstream. */
    default_listen_port: portSchema.default(51820),
    default_metrics_port: portSchema.default(9586),
    default_mtu: z.number().int().default(1420),
    keepalive: z.number().int().min(1).max(3600).default(25),
    /** Tier-3 flow record retention, days (§13: default 7). */
    flow_retention_days: z.number().int().min(1).max(365).default(7),
  })
  .strict();

const topologySchema = z
  .object({
    shape: z.enum(["full-mesh", "multi-hub", "single-hub"]).default("full-mesh"),
    /** Ordered hub preference; required for multi-hub and single-hub. */
    hubs: z.array(idSchema).optional(),
  })
  .strict();

const policySchema = z
  .object({
    management: z
      .object({
        /** Sources allowed to open connections to management destinations. */
        admin_sources: z.array(cidrSchema).default([]),
        /** Subnets holding IPMI/management interfaces: reachable only from admin_sources, and never initiate across the mesh. */
        management_destinations: z.array(cidrSchema).default([]),
      })
      .strict(),
  })
  .strict();

export const sitesFileSchema = z
  .object({
    version: z.literal(1),
    network: networkSchema.default({}),
    topology: topologySchema.default({}),
    sites: z.array(siteSchema).min(1),
    clients: z.array(clientSchema).default([]),
    policy: policySchema.optional(),
  })
  .strict();

export type SitesFile = z.infer<typeof sitesFileSchema>;

export interface ResolvedGateway {
  displayName: string | undefined;
  lanIp: string;
  tunnelIp: string;
  endpoint: string | null;
  /** True when endpoint is a hostname — peers need the reresolve-dns timer. */
  endpointIsHostname: boolean;
  listenPort: number;
  publicKey: string;
  mtu: number;
  privateKeyPath: string;
  metricsPort: number;
  flows: boolean;
}

export interface ResolvedLan {
  cidr: string;
  name: string | undefined;
  vlan: number | undefined;
  role: "standard" | "management" | "guest";
}

export interface ResolvedSite {
  id: string;
  name: string;
  /** Every LAN segment behind this gateway, in file order. */
  lans: ResolvedLan[];
  /**
   * Subnets advertised across the mesh (standard + management; never guest).
   * This is the list that reaches AllowedIPs and router instructions.
   */
  advertised: string[];
  /** Management-role subnets at this site. */
  managementNets: string[];
  gateway: ResolvedGateway;
}

export interface ResolvedClient {
  id: string;
  displayName: string | undefined;
  tunnelIp: string;
  publicKey: string;
  /** Ordered preference; always non-empty after resolution. */
  entryPoints: string[];
  homeSite: string;
  mtu: number;
}

export interface ResolvedConfig {
  network: {
    name: string | undefined;
    gatewaySubnet: string;
    clientSubnet: string;
    defaultListenPort: number;
    defaultMetricsPort: number;
    defaultMtu: number;
    keepalive: number;
    flowRetentionDays: number;
  };
  topology: {
    shape: "full-mesh" | "multi-hub" | "single-hub";
    /** Ordered. Empty for full-mesh. */
    hubs: string[];
  };
  sites: ResolvedSite[];
  clients: ResolvedClient[];
  policy: {
    management: { adminSources: string[]; managementDestinations: string[] };
  } | null;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

export const DEFAULT_PRIVATE_KEY_PATH = "/etc/opnmesh/keys/wg0.key";

/**
 * Fill cross-field defaults and check referential integrity.
 * Semantic network validation (overlaps, SPOF, ports…) lives in lib/validators;
 * this only rejects configs that are structurally unusable.
 */
export function resolveConfig(file: SitesFile): ResolvedConfig {
  const problems: string[] = [];
  const siteIds = new Set<string>();
  for (const s of file.sites) {
    if (siteIds.has(s.id)) problems.push(`duplicate site id "${s.id}"`);
    siteIds.add(s.id);
  }
  const clientIds = new Set<string>();
  for (const c of file.clients) {
    if (clientIds.has(c.id)) problems.push(`duplicate client id "${c.id}"`);
    if (siteIds.has(c.id)) problems.push(`client id "${c.id}" collides with a site id`);
    clientIds.add(c.id);
  }

  const shape = file.topology.shape;
  const hubs = file.topology.hubs ?? [];
  if (shape === "full-mesh" && hubs.length > 0) {
    problems.push("topology.hubs is only valid for multi-hub and single-hub shapes");
  }
  if (shape === "multi-hub" && hubs.length < 1) {
    problems.push("multi-hub topology requires at least one entry in topology.hubs");
  }
  if (shape === "single-hub" && hubs.length !== 1) {
    problems.push("single-hub topology requires exactly one entry in topology.hubs");
  }
  for (const h of hubs) {
    if (!siteIds.has(h)) {
      problems.push(`topology.hubs references unknown site "${h}"`);
    } else {
      const hub = file.sites.find((s) => s.id === h)!;
      if (hub.gateway.endpoint === null) {
        problems.push(`hub "${h}" has no endpoint — a hub must be reachable`);
      }
    }
  }
  if (new Set(hubs).size !== hubs.length) problems.push("topology.hubs contains duplicates");

  const eligibleEntrySites = file.sites
    .filter((s) => s.gateway.endpoint !== null)
    .map((s) => s.id);

  const sites: ResolvedSite[] = file.sites.map((s) => {
    const lans: ResolvedLan[] = s.lans
      ? s.lans.map((l) => ({ cidr: l.cidr, name: l.name, vlan: l.vlan, role: l.role }))
      : [{ cidr: s.lan!, name: undefined, vlan: undefined, role: "standard" as const }];
    // Guest segments are deliberately absent from `advertised`: no peer ever
    // routes them, so a guest VLAN cannot reach — or be reached from — the mesh.
    const advertised = lans.filter((l) => l.role !== "guest").map((l) => l.cidr);
    const managementNets = lans.filter((l) => l.role === "management").map((l) => l.cidr);
    if (advertised.length === 0) {
      problems.push(`site "${s.id}" advertises no subnets — every LAN is marked guest`);
    }
    return {
      id: s.id,
      name: s.name,
      lans,
      advertised,
      managementNets,
      gateway: {
        displayName: s.gateway.name,
        lanIp: s.gateway.lan_ip,
        tunnelIp: s.gateway.tunnel_ip,
        endpoint: s.gateway.endpoint,
        endpointIsHostname: s.gateway.endpoint !== null && isHostname(s.gateway.endpoint),
        listenPort: s.gateway.listen_port ?? file.network.default_listen_port,
        publicKey: s.gateway.public_key,
        mtu: s.gateway.mtu ?? file.network.default_mtu,
        privateKeyPath: s.gateway.private_key_path ?? DEFAULT_PRIVATE_KEY_PATH,
        metricsPort: s.gateway.metrics_port ?? file.network.default_metrics_port,
        flows: s.gateway.flows,
      },
    };
  });

  const clients: ResolvedClient[] = file.clients.map((c) => {
    let entryPoints = c.entry_points ?? eligibleEntrySites;
    if (c.entry_points) {
      for (const e of c.entry_points) {
        if (!siteIds.has(e)) {
          problems.push(`client "${c.id}" entry point "${e}" is not a known site`);
        } else if (!eligibleEntrySites.includes(e)) {
          problems.push(
            `client "${c.id}" entry point "${e}" has no inbound UDP endpoint — clients cannot enter there`,
          );
        }
      }
      if (new Set(c.entry_points).size !== c.entry_points.length) {
        problems.push(`client "${c.id}" lists duplicate entry points`);
      }
    }
    if (entryPoints.length === 0) {
      problems.push(
        `client "${c.id}" has no usable entry point — no site publishes an inbound endpoint`,
      );
    }
    if (!siteIds.has(c.home_site)) {
      problems.push(`client "${c.id}" home_site "${c.home_site}" is not a known site`);
    }
    return {
      id: c.id,
      displayName: c.name,
      tunnelIp: c.tunnel_ip,
      publicKey: c.public_key,
      entryPoints,
      homeSite: c.home_site,
      mtu: c.mtu ?? file.network.default_mtu,
    };
  });

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    network: {
      name: file.network.name,
      gatewaySubnet: file.network.gateway_subnet,
      clientSubnet: file.network.client_subnet,
      defaultListenPort: file.network.default_listen_port,
      defaultMetricsPort: file.network.default_metrics_port,
      defaultMtu: file.network.default_mtu,
      keepalive: file.network.keepalive,
      flowRetentionDays: file.network.flow_retention_days,
    },
    topology: { shape, hubs },
    sites,
    clients,
    // Any LAN marked role: management joins the management destination set
    // automatically, so a multi-VLAN office does not have to restate its
    // management subnets in the policy block.
    policy: (() => {
      const fromLans = sites.flatMap((s) => s.managementNets);
      if (!file.policy && fromLans.length === 0) return null;
      const declared = file.policy?.management.management_destinations ?? [];
      return {
        management: {
          adminSources: file.policy?.management.admin_sources ?? [],
          managementDestinations: [...new Set([...declared, ...fromLans])],
        },
      };
    })(),
  };
}

/** Parse + resolve YAML text. Throws ConfigError (semantic) or ZodError (shape). */
export function loadSitesYaml(text: string): ResolvedConfig {
  const raw: unknown = parseYaml(text);
  return resolveConfig(sitesFileSchema.parse(raw));
}
