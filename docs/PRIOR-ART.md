# Prior art — what v2 takes from v1 and from other open-source projects

## OPNmesh v1 (github.com/CoppingEthan/OPNmesh)

Read in full before designing v2. Where it was heading: a site-to-site
WireGuard manager where gateways are subnet routers, config is generated
deterministically from one description of the network, the agent only pulls,
and the UI speaks plain English. It had grown a large operations layer
(Prometheus/Grafana/Alertmanager, signed self-updates with A/B installs and
commit-confirm, packet capture, per-host flows, coordinated port changes) and a
two-process controller that made it heavy to deploy.

Kept, as ideas and often as logic to reimplement:

- Gateway-per-site subnet routing with real source addresses (no NAT).
- Topology as a pure function: peered pairs, deterministic transit designation,
  client entry points, SPOF analysis (`lib/topology.ts`).
- Generator invariants and the independent validator that re-parses generated
  config (`lib/generator/*`, `lib/validators`).
- nftables in one dedicated table with per-site-pair named counters, MSS clamp,
  client isolation via conntrack.
- Agent safety rules: managed-file allowlist, single sanctioned `PostUp`,
  `syncconf` for peer-only changes, port pre-flight, rollback, hold last known
  good.
- Enrolment: single-use, short-TTL, hashed tokens; only public keys travel.
- TLS pinning at install; three credential tiers.
- The dashboard's "one sentence answer first" and the minimal force-directed
  map with intensity as opacity.

Dropped or simplified: see ARCHITECTURE.md §16.

## NetBird (github.com/netbirdio/netbird)

Go control plane + clients, WireGuard, STUN/TURN. Concepts borrowed:

- **Network routes with routing peers**: a peer advertises a CIDR on behalf of
  a LAN; other peers route to it. Their docs are explicit that with
  *masquerade off* the external router needs a return route via the routing
  peer — precisely OPNmesh's model — and that masquerade is the zero-router-
  changes fallback. OPNmesh's per-site "router layout" (transit / same-LAN /
  masquerade) is the same choice made visible.
- **Setup keys** bound to groups, reusable or one-off, with auto-approval:
  v2's enrolment tokens are pre-bound to a site and can auto-approve.
- **HA routing groups with a metric**: noted for v2.x (two gateways per site).
- Their activity log and "peers online" presentation.

## Netmaker (github.com/gravitl/netmaker)

- **Egress gateway** (advertise LAN ranges) and **remote access gateway**
  (external clients with config/QR) as roles on a node — OPNmesh's gateway is
  both at once, always.
- The **connectivity matrix / metrics** page (per-pair latency, up/down) is the
  model for the traffic matrix and RTT probes.

## Firezone (github.com/firezone/firezone)

- **Sites → Gateways → Resources → Policies**: the cleanest data model in the
  space. OPNmesh's `sites`, `gateways`, `lans` mirror it; client site
  restrictions are the smallest useful policy.
- Gateways deployed with a **one-line Docker/systemd install driven by a
  token and environment variables, no persistent state needed** — the bar for
  v2's gateway installer.
- "Control plane never in the data path" and gateway failover being the
  control plane telling clients to reconnect elsewhere.

## Tailscale / Headscale (subnet routers)

- **Subnet routers** are the same idea as OPNmesh gateways; their site-to-site
  guide requires `--snat-subnet-routes=false`, static routes on each LAN
  router, and MSS clamping — OPNmesh's defaults.
- **Route approval** in the admin console (Headscale: `approve-routes`) is the
  origin of v2's "gateway pending approval" state.
- Longest-prefix behaviour with overlapping advertised routes, and disabling
  key expiry on routers, inform validation messages.

## wg-easy (github.com/wg-easy/wg-easy)

- The client UX bar: create → QR + `.conf` in seconds, per-client live Tx/Rx
  chart, **one-time links**, **client expiry**, enable/disable toggle. v2's
  Clients page is modelled on it.
- Single-container deployment with `NET_ADMIN` and sysctls in compose.

## WGDashboard (github.com/donaldzou/WGDashboard)

- Live stats come from polling `wg show <if> dump` on an interval and
  differencing; the same source v2's agent uses, with the difference computed
  on the controller so the agent stays stateless.
- Peer scheduling (disable after a date or data volume) → v2 client expiry.

## Defguard (github.com/DefGuard/defguard)

- "Locations" = sites, each with its own gateway process and token — the same
  shape as v2, and a reminder that per-location gateway tokens should be
  rotatable from the UI.

## UniFi tooling

- paultyng/go-unifi and the Terraform/Pulumi UniFi providers: the classic
  `rest/routing` resource, field names and the create/update/delete verbs
  OPNmesh's UniFi integration uses.
- sirkirby/unifi-network-rules (Home Assistant): shows the v2
  `firewall-policies` and `trafficroutes` endpoints working against Network
  9.0.92+, and the "manage only what you created, by name/id" discipline.
