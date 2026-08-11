/**
 * Zod schemas for every control-server request body. Nothing reaches
 * application logic unvalidated: an unparsed body is a 400, not a surprise
 * `undefined` three functions deeper.
 */
import { z } from "zod";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const tokenSchema = z.string().regex(/^[a-f0-9]{32,128}$/);
const wgKeySchema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const versionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const enrolRequestSchema = z.object({
  token: tokenSchema,
  publicKey: wgKeySchema,
  hostname: z.string().min(1).max(253),
  addresses: z.array(z.string().max(45)).max(32).default([]),
});

export const agentReportSchema = z.object({
  nodeId: z.string().max(64).optional(),
  // Constrained charset: version is reflected into a Prometheus /metrics label.
  // The exposition format is escaped at the sink as well, but a version string
  // has no reason to contain quotes, newlines or control characters, so the
  // schema refuses them outright as the first line of defence.
  version: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9._+-]*$/, "version may contain only letters, digits, and . _ + -")
    .default(""),
  appliedHash: z.string().max(128).default(""),
  diskHash: z.string().max(128).default(""),
  lastError: z.string().max(2000).default(""),
  lastUpdateError: z.string().max(2000).default(""),
  agentUptimeSec: z.number().optional(),
  peers: z
    .array(
      z.object({
        publicKey: z.string().max(64),
        endpoint: z.string().max(64).default(""),
        latestHandshake: z.number().int().nonnegative().default(0),
        rxBytes: z.number().nonnegative().default(0),
        txBytes: z.number().nonnegative().default(0),
      }),
    )
    .max(512)
    .default([]),
});

export const agentFlowsSchema = z.object({
  flows: z
    .array(
      z.object({
        proto: z.string().max(16),
        src: z.string().max(45),
        dst: z.string().max(45),
        dstPort: z.number().int().min(0).max(65535).default(0),
        bytes: z.number().nonnegative().default(0),
        packets: z.number().nonnegative().default(0),
        reported: z.number().int().nonnegative().optional(),
      }),
    )
    .max(5000),
});

export const issueTokenSchema = z.object({
  role: z.enum(["gateway", "relay", "client"]).default("gateway"),
  note: z.string().max(200).default(""),
  // Shorter is safer; the upper bound is what matters here.
  ttlMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1000).optional(),
});

/**
 * A site entry supplied at approval time.
 *
 * STRICT on purpose. These fields are written into sites.yml and flow into
 * generated config, and some of them reach a command line — `private_key_path`
 * ends up in a `PostUp = wg set %i private-key <path>` line executed by
 * wg-quick as root. An unknown field is refused loudly rather than silently
 * dropped, so a caller cannot probe for one that does get through.
 * The full sites.yml schema re-validates everything before it is persisted.
 */
export const approveSchema = z
  .object({
    pendingId: z.string().regex(/^p-[a-f0-9]{12}$/),
    site: z
      .object({
        id: idSchema,
        name: z.string().min(1).max(120),
        lan: z.string().max(45).optional(),
        lans: z
          .array(
            z
              .object({
                cidr: z.string().max(45),
                name: z.string().max(60).optional(),
                vlan: z.number().int().min(1).max(4094).optional(),
                role: z.enum(["standard", "management", "guest"]).optional(),
              })
              .strict(),
          )
          .max(64)
          .optional(),
        gateway: z
          .object({
            name: z.string().max(120).optional(),
            lan_ip: z.string().max(45),
            tunnel_ip: z.string().max(45),
            endpoint: z.string().max(253).nullable(),
            listen_port: z.number().int().min(1).max(65535).optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const pendingIdSchema = z.object({
  pendingId: z.string().regex(/^p-[a-f0-9]{12}$/),
});

export const siteIdSchema = z.object({ siteId: idSchema });

export const registerReleaseSchema = z.object({
  version: versionSchema,
  sha256: sha256Schema,
  configDigest: sha256Schema.nullable().optional(),
});

export const startRolloutSchema = z.object({
  version: versionSchema,
  canary: idSchema.optional(),
  soakSec: z.number().int().min(0).max(86_400).optional(),
  failTimeoutSec: z.number().int().min(30).max(86_400).optional(),
  approveConfigChange: z.boolean().optional(),
});

export const freezeSchema = z.object({ frozen: z.boolean() });
export const pinSchema = z.object({ siteId: idSchema, pinned: z.boolean() });
export const windowSchema = z.object({ updateWindow: z.enum(["always", "never"]) });

export const changePortSchema = z.object({
  siteId: idSchema,
  port: z.number().int().min(1).max(65535),
  verifyWindowSec: z.number().int().min(30).max(1800).optional(),
});

/**
 * Packet-capture request. The filter is a tcpdump *expression* only — any
 * token starting with "-" would be read by tcpdump as a flag, and flags like
 * `-z` execute a command as root. Rejected outright; see agent/capture.go for
 * the second, independent check on the node itself.
 */
export const captureSchema = z.object({
  node: idSchema,
  filter: z
    .string()
    .max(200)
    .default("")
    .refine((f) => !/(^|\s)-/.test(f), {
      message: "capture filter may not contain options (tokens starting with '-')",
    })
    .refine((f) => /^[A-Za-z0-9 .:/()\[\]<>=!&|_-]*$/.test(f.replace(/(^|\s)-/g, " ")), {
      message: "capture filter contains unsupported characters",
    }),
  seconds: z.number().int().min(1).max(60).default(15),
  maxKb: z.number().int().min(64).max(10240).default(2048),
});

export const flowQuerySchema = z.object({
  window: z.number().int().min(60).max(31 * 86_400).default(3600),
  limit: z.number().int().min(1).max(500).default(30),
});
