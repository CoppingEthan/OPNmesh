# OPNmesh

Self-hosted WireGuard mesh management for small multi-site networks. OPNmesh
writes WireGuard config files onto a few Linux boxes and keeps them correct.
That is the whole product.

**OPNmesh is not in the data path.** Traffic never flows through the control
panel. Switch the control panel off and the network keeps running
indefinitely — you just cannot change or observe it until it is back.

## How it works, in plain terms

Three deliberately independent layers:

1. **The tunnels.** Plain WireGuard: one Linux gateway per site with a
   `wg0.conf`. Once that file exists and `wg-quick@wg0` is enabled, the tunnels
   run forever with no OPNmesh involvement. This layer carries all the traffic.
2. **The agent.** A small Go binary on each gateway. Every few seconds it asks
   the control panel "what should my config be?" If the answer differs from
   disk, it writes the new config and reloads. If the control panel does not
   answer, it changes nothing and carries on.
3. **The control panel.** A web app holding one YAML file describing the
   network. It generates config from that file, answers agents, and shows you
   what is happening.

Site-to-site, not per-host: each site has **one** gateway routing for the whole
site. Ordinary hosts, VMs, IPMI cards and appliances run no VPN software and
never have their default gateway changed — they keep talking to their site
router, which routes the mesh subnets to the gateway.

## Sites with more than one network (VLANs)

A site can have one flat subnet or many VLANs. List each segment and give it a
role:

```yaml
sites:
  - id: head-office
    name: Head Office
    lans:
      - { cidr: 10.10.10.0/24, name: Staff,      vlan: 10 }
      - { cidr: 10.10.20.0/24, name: Voice,      vlan: 20 }
      - { cidr: 10.10.99.0/24, name: Management, vlan: 99, role: management }
      - { cidr: 192.168.1.0/24, name: Guest Wi-Fi, vlan: 90, role: guest }
  - id: branch
    name: Branch
    lan: 10.20.0.0/16          # single flat network — shorthand
```

| Role | Behaviour |
|---|---|
| `standard` (default) | Reachable from every other site. |
| `management` | Reachable **only** from `policy.management.admin_sources`, and never allowed to start connections across the mesh. Added to the ACL set automatically. |
| `guest` | Never carried across the mesh in either direction. No peer routes it, and the gateway drops it — so guest ranges may safely overlap between sites. |

OPNmesh never configures switches; `vlan` is documentation that appears in the
router instructions so whoever wires it up knows which segment is which.

## What's in the box

| Area | Where |
|---|---|
| Config schema, generators, validators | `lib/` (schema, topology, generator, validators, diff, flows, update) |
| On-node agent (Go) | `agent/` — pull loop, reconcile, port pre-flight, commit-confirm, A/B install, boot watchdog, flow + capture, rollback CLI |
| Admin UI (Next.js) | `app/` — dashboard, nodes, clients, traffic, config, routes, updates, alerts, settings |
| Control API (dev/sim server; production semantics) | `scripts/control-server.ts` |
| Simulation mesh | `docker/` — compose harness, config/release builders, chaos |
| Deployment | `deploy/` — control-node compose, agent systemd units, `install.sh`, Prometheus/Alertmanager/Grafana |
| Optional relay | `relay/` |
| Reference fixtures + integration tests | `test/` |

## Try it locally (Windows + WSL2 + Docker Desktop, or any Docker host)

The whole platform runs as a simulated three-site mesh using **userspace
WireGuard** (built from source in the image), so no host kernel module is
needed and behaviour is identical on Windows, WSL and CI.

```bash
npm install
npm run mesh:up        # build + start 3 gateways, 3 LAN hosts, a client, the control node
npm run mesh:test      # the §14 + agent + enrolment + observability + update integration tests
npm run mesh:obs       # add Prometheus (:19090), Alertmanager (:19093), Grafana (:13000), mailpit (:18025)
npm run mesh:traffic   # a traffic generator so the observability views have something to show
npm run mesh:chaos     # kill a random gateway, prove the rest stay connected, restore it
npm run mesh:update-test  # staged rollout, freeze, broken-release rollback, coordinated port change
npm run mesh:down      # tear everything down
```

Run the admin UI against that mesh:

```bash
npm run dev            # http://localhost:3000  (first visit walks you through creating the admin account)
```

`OPNMESH_STATE_DIR` (default `docker/state`), `OPNMESH_CONTROL_URL`
(`http://localhost:18080`) and `OPNMESH_PROM_URL` (`http://localhost:19090`)
point the UI at the simulation. Nothing is hardcoded.

## Deploy for real

### Control node (one Ubuntu VM, on a site LAN, separate from that site's gateway)

```bash
cd deploy/control-node
cp .env.example .env.local     # set the web/API/observability ports and SMTP
docker compose up -d
```

The UI is on `OPNMESH_WEB_PORT`, the agent-facing API on `OPNMESH_API_PORT`.
On first boot `sites.yml` is seeded from the committed example; edit it in the
UI. Every edit is validated end to end and committed to a **local** git
repository in the config volume — no remote, nothing pushed anywhere. See
Settings if you want to add a private off-box backup remote.

### Add a gateway (enrolment)

In the UI: **Nodes → Add node**, pick a role and note, get a one-time token.
The UI shows the install one-liner and the `install.sh` SHA-256 so you can
verify the script before running it:

```bash
curl -fsSL https://<control-host>:<api-port>/install.sh | sudo bash -s -- \
  --token <one-time-token> --server https://<control-host>:<api-port>
```

The script installs dependencies, **generates the WireGuard keypair on the box**
(only the public key is ever sent), and enrols. The node then appears as
**pending**. Review its key fingerprint against the install output, assign the
site subnet / tunnel IP / listen port, and approve. The agent pulls its config
and the tunnels come up.

Install the systemd units from `deploy/agent/` (the packaged `install.sh` does
this on a real host): `opnmesh-agent.service` runs the agent, and the
`opnmesh-reresolve-dns.timer` is enabled automatically when any peer endpoint
is a hostname (DDNS), because `wg-quick` resolves names only once at start.

### Site routers (you do this by hand — OPNmesh never touches them)

The **Routes** page prints the exact static routes and firewall rules each
site router needs, using the actual configured ports. Copy them in.
**UniFi note:** a static route alone is silently dropped unless a matching
LAN-IN firewall rule allows the routed subnets.

## Topology shapes and ports

Chosen per install:

- **Full mesh** (default when every site can open a UDP port) — every pair
  direct, no single point of failure.
- **Multi hub** — capable sites peer directly; NAT-bound sites dial every hub.
- **Single hub** — one UDP port total; that hub becomes a single point of
  failure for all inter-site traffic (the UI warns loudly).

The dashboard shows a **connectivity matrix**: which pairs are direct, which
transit, and what each site's death would sever.

Ports are configuration, never constants. `listen_port` is per node
(default 51820 but nothing hardcodes it — use 443/udp to blend in if you like);
peers derive each other's `Endpoint` automatically. Changing a port on a live
mesh is a **coordinated transaction** across all affected nodes with mesh-wide
verification and all-or-nothing revert, because a naive per-node change
deadlocks (peers keep dialling the old port). Do it from **Nodes → change
port**.

A site with no inbound port sets `endpoint: null`: it dials out with
`PersistentKeepalive` and peers learn its address from the handshake. At least
one reachable UDP endpoint per pair is required — UDP hole punching is out of
scope for v1.

## Observability (four tiers, each switchable)

1. **Per-tunnel counters** (always on, free): bytes and handshake age from
   `wg show`, scraped into Prometheus.
2. **Site-to-site matrix** (always on): nftables counters per subnet pair.
3. **Per-host flows** (opt-in per gateway): who talked to whom, from conntrack
   accounting, stored with a retention window (default 7 days) and a purge
   action. **Never** in Prometheus — per-host series are unbounded cardinality.
4. **On-demand capture**: a time-boxed, size-capped `tcpdump` on a chosen
   gateway, downloadable as a pcap. Every capture is audited.

**OPNmesh only sees traffic that crosses a tunnel.** Traffic between two hosts
at the same site never reaches the gateway and is invisible here by design.

Alerting is Prometheus Alertmanager with an SMTP receiver (credentials from the
environment). Minimum alert set shipped in
`deploy/prometheus/rules/opnmesh.yml`. The **Alerts** page has a *Send test
email* button. Grafana holds the deep historical dashboards
(`deploy/grafana/`); the UI shows the at-a-glance views.

Because alerting dies with the control node, the control node runs a
**dead-man's switch**: a periodic heartbeat to a configurable external endpoint
(`OPNMESH_DEADMAN_URL`) so its own death is noticed.

## Updates (centrally controlled, layered failsafes)

Releases are minisign-signed. A rollout: verifies signature + checksum + the
release's self-test offline, canary-first one node at a time (hubs last), and
each node **commit-confirms locally** — it needs a fresh handshake and a
check-in within 90s or it flips back to the previous version by itself, even if
the control node died mid-update. A/B installs make rollback a symlink flip
with zero network. A boot watchdog reverts to last-known-good config if a node
boots unable to handshake. Freeze, maintenance windows and per-node pinning are
central. **A software update never changes WireGuard config as a side effect**:
a release whose generated config differs is blocked pending explicit approval.
Manual escape hatch on every node: `opnmesh-agent rollback` (config) and
`opnmesh-agent rollback-update` (binary), both offline-capable.

## Two repositories — do not confuse them

1. **This repo** (public): the application. Contains no network configuration.
   `config/sites.yml` and secrets are gitignored; `config/sites.example.yml`
   and `.env.example` are committed. CI greps every diff for private key
   material and fails the build.
2. **Your config repository** (local, private, on your control node): created
   with `git init` in the config directory at install time. Its only purpose is
   change history — who changed what, when, with diff/revert. **No remote is
   configured and nothing is pushed anywhere** unless you explicitly add one
   (Settings warns you it describes your entire topology and must be private).

Private keys never enter either repository, the database, or any log line.

## Security

The control node holds the keys to every site, and the agent runs as root on
every gateway, so the trust boundaries are explicit.

**Three credential tiers, never interchangeable.**

| Tier | Covers | Held by |
|---|---|---|
| Public | `/install.sh`, `POST /api/v1/enrol` (rate limited, gated by a single-use short-TTL token) | anyone who can reach the port |
| Node | `/api/v1/agent/*` | one 256-bit bearer token per node, issued at approval, stored root-only; only its hash is kept server-side |
| Admin | `/api/v1/admin/*`, `/api/v1/state`, `/api/v1/flows/*`, `/metrics` | the UI only, via `OPNMESH_ADMIN_TOKEN` |

- **TLS is mandatory.** The control server refuses to start without a
  certificate unless you explicitly set `OPNMESH_ALLOW_INSECURE_HTTP=1` for an
  isolated lab. `install.sh` records the control node's certificate public key
  and the agent **pins** it, so a private mesh needs no public CA and a swapped
  certificate is refused. The pin must match the **leaf** certificate — the one
  whose private key the peer proved it holds — so an interceptor cannot satisfy
  it by stapling a copy of the real (public) certificate behind their own.
  Pass `--pin <sha256>` to `install.sh`, using the value the UI prints beside
  the enrolment command: without it the first connection is trusted blind, and
  whoever answers it is trusted from then on.
- **The agent does not trust the control node with paths or commands.** It
  writes only its own known filenames (no traversal), validates release
  versions before they touch a path, and refuses any packet-capture filter
  containing a `-` token — tcpdump would read that as an option, and `-z` runs
  a command as root.
- **UI auth**: one local admin, argon2id, server-side sessions stored *hashed*,
  idle + absolute timeouts, login throttling that only counts failures (so
  nobody can lock you out of your own panel), and a one-time bootstrap token
  for first-run setup printed to the server log. First-run setup is throttled
  on the same ledger, so the setup code cannot be guessed at speed either.
- **Throttling does not trust request headers.** `X-Forwarded-For` is only read
  when you set `OPNMESH_TRUST_PROXY=1`, which you should do **only** when the
  panel really is behind a reverse proxy that overwrites it. Anything else
  would let a caller vary the header per request, land in a fresh bucket every
  time, and guess the admin password without limit. A global failure ceiling
  backstops the per-source count either way.
- **Exporters bind to the tunnel address only.** Prometheus scrapes gateways
  over the mesh; the metrics port is not reachable from the WAN.
- **No secrets in URLs.** Enrolment tokens are shown once from a server-side
  store; pcaps stream through the authenticated UI, not the raw API.
- **Releases**: minisign (Ed25519) detached signatures, verified offline before
  anything is switched; SHA-256 as a secondary check.
- **Agent language**: Go — one static binary, trivial A/B installs, no runtime
  on gateways.

`test/integration/security.test.ts` asserts these against the running server so
a refactor cannot quietly reopen one.

### Before you deploy on a real network

1. Generate an admin token: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` → `OPNMESH_ADMIN_TOKEN`.
2. Put a real certificate and key in `deploy/control-node/tls/`.
3. Set `OPNMESH_GRAFANA_PASSWORD` (Grafana ships with no default password set,
   and the compose file refuses to start without it).
4. Prometheus, Alertmanager and Grafana bind to **loopback only** — reach them
   over an SSH tunnel, not from the LAN.
5. Ship your minisign public key to nodes as `/etc/opnmesh/minisign.pub`;
   without it, agents refuse all self-updates (fail closed).

## Development

Stack: Next.js (App Router) + TypeScript + Tailwind, Node 22, `yaml`,
`simple-git`, `better-sqlite3`; agent in Go; Vitest for unit tests.

```bash
npm test          # unit tests (schema, topology, generators, validators, VLANs, flows, rollout, isolation)
npm run typecheck
npm run ui:test   # build + smoke-test the UI
npm run mesh:test # live integration suite, including security regressions
```

Golden config output lives in `test/golden/`; regenerate deliberately with
`npm run goldens:update` and review the diff. The generator is tested hardest —
a bug in `AllowedIPs` generation quietly exposes a management network, so it is
treated very differently from a cosmetic UI bug.

## License

MIT.
