# OPNmesh

Self-hosted WireGuard mesh management for small multi-site networks. OPNmesh
writes WireGuard config files onto a few Linux boxes and keeps them correct —
it is never in the data path, and the mesh keeps running indefinitely if the
control panel dies.

**Status: early development.** Phase 1 (config schema, generators, validators)
is implemented and tested; the mesh simulation harness, agent, and UI are not
yet built.

## What exists today

- `lib/schema.ts` — strict schema for `sites.yml`, the single source of truth.
- `lib/topology.ts` — peering shapes (full mesh / multi hub / single hub),
  transit designation, connectivity matrix, SPOF analysis.
- `lib/generator/` — per-gateway `wg0.conf`, nftables rulesets (client
  isolation, management ACLs, MSS clamp, traffic counters), sysctl, per-site
  router instructions, and client configs.
- `lib/validators/` — AllowedIPs exactness, no-SNAT, address overlap, MTU,
  port collision, and SPOF checks. Errors block a save.
- `lib/diff.ts` — config-neutrality diffing for the future update pre-flight.

```
npm install
npm test
```

## Security posture (already enforced by tests and CI)

- Private keys never leave the node that generated them: gateway configs load
  the key from a root-only path via `wg set`; client configs ship a
  placeholder filled in on the device. CI fails if key material is committed.
- `config/sites.yml` (your network description) is gitignored here — it
  belongs only in the local, private config repository on your control node.
- No masquerade/SNAT anywhere; source addresses survive the mesh end to end.
- Roaming clients reach in; nothing inside any site can open a connection to
  a client.
- No port is hardcoded. Every port comes from configuration.
