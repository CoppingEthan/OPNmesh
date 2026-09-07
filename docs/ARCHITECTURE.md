# OPNmesh v2 — How everything works

OPNmesh joins the networks at several sites into one routed network using
WireGuard, and lets people working from home join that network with a QR code.
A machine on `192.168.20.0/24` at an office pings a machine on `10.0.1.0/24` in
a datacentre 200 miles away, by its real address, with no VPN software on
either machine.

This document is the design for version 2. It is written so that someone who
has never seen the code can understand what runs where, what talks to what,
and why each decision was made. It is also the specification the code is
built and tested against.

Contents

1. [What OPNmesh is, in one picture](#1-what-opnmesh-is-in-one-picture)
2. [Design principles](#2-design-principles)
3. [Components](#3-components)
4. [How traffic flows](#4-how-traffic-flows)
5. [Topology: which gateway talks to which](#5-topology-which-gateway-talks-to-which)
6. [Roaming clients (home workers)](#6-roaming-clients-home-workers)
7. [The site router: three layouts](#7-the-site-router-three-layouts)
8. [Data model](#8-data-model)
9. [Generated configuration](#9-generated-configuration)
10. [Controller ⇄ gateway protocol](#10-controller--gateway-protocol)
11. [Real-time traffic and the dashboard](#11-real-time-traffic-and-the-dashboard)
12. [Security model](#12-security-model)
13. [Deployment](#13-deployment)
14. [Repository layout](#14-repository-layout)
15. [Testing strategy](#15-testing-strategy)
16. [What changed from v1 and why](#16-what-changed-from-v1-and-why)
17. [Build phases](#17-build-phases)
18. [Out of scope for 2.0](#18-out-of-scope-for-20)

---

## 1. What OPNmesh is, in one picture

```
            Home worker (laptop / phone, WireGuard app, QR code)
                          │  WireGuard over the internet
                          ▼
   ┌─────────────────── Internet ───────────────────────────────┐
   │                                                            │
   │   Site A: UK datacentre          Site B: Office            │
   │   ┌────────────────────┐         ┌────────────────────┐    │
   │   │ UniFi router       │         │ UniFi router       │    │
   │   │  UDP 51820 ─► VM   │◄═══════►│  UDP 51820 ─► VM   │    │
   │   │  static routes ─►  │ WireGuard│  static routes ─►  │    │
   │   │ ┌────────────────┐ │  tunnel │ ┌────────────────┐ │    │
   │   │ │ OPNmesh gateway│ │         │ │ OPNmesh gateway│ │    │
   │   │ │ (Ubuntu VM)    │ │         │ │ (Ubuntu VM)    │ │    │
   │   │ └────────────────┘ │         │ └────────────────┘ │    │
   │   │ LANs 10.0.1.0/24   │         │ LANs 192.168.20.0/24│   │
   │   │      10.0.99.0/24  │         │      192.168.30.0/24│   │
   │   └────────────────────┘         └────────────────────┘    │
   │                                                            │
   │   Site C: Warehouse (no inbound port, CGNAT)               │
   │   ┌────────────────────┐   dials out to A and B            │
   │   │ router → VM        │═══════════════════════════════►   │
   │   └────────────────────┘                                   │
   └────────────────────────────────────────────────────────────┘

   Controller (Next.js + SQLite, one container) — runs at site A,
   or anywhere with HTTPS reachable by the gateways. Never in the data path.
```

Three kinds of thing exist:

| Thing | What it is | Runs on |
|---|---|---|
| **Controller** | The web app. Holds the list of sites, networks, gateways and clients; generates WireGuard config; shows the live dashboard; pushes routes into UniFi. | One Docker container, anywhere the gateways can reach over HTTPS. |
| **Gateway** | A small Go agent on an Ubuntu VM at each site. Runs the WireGuard tunnel and forwards traffic between the site LAN and the mesh. | One Ubuntu 22.04/24.04 VM (or LXC/bare metal) per site, e.g. on Proxmox. |
| **Client** | A standard WireGuard app on a laptop or phone. Gets a config from the controller by QR code, file or one-time link. | Any device with a WireGuard app. |

Plus one thing OPNmesh does **not** run but must cooperate with:

| Thing | What OPNmesh needs from it |
|---|---|
| **Site router** (UniFi in our case) | Forward one UDP port to the gateway VM (if the site accepts inbound tunnels), and route the *remote* subnets to the gateway VM's IP. OPNmesh prints the exact routes, and can push them into UniFi automatically. |

## 2. Design principles

1. **Not in the data path.** Traffic between sites flows gateway ⇄ gateway over
   WireGuard. The controller can be switched off and the network keeps
   working; it just cannot be changed or observed until it is back. This was
   v1's best decision and it stays.
2. **One container, one binary, one command.** The controller is one Docker
   container with one volume. A gateway is one static binary installed by one
   `curl | bash` line printed by the UI. There is no Prometheus, Grafana,
   Alertmanager, git repository or YAML file to manage.
3. **The database is the truth.** Sites, networks, gateways and clients live in
   SQLite. Everything on every gateway is *derived* from that, deterministically,
   so the same database always produces byte-identical config. There is no
   hand-edited configuration anywhere.
4. **Real addresses end to end.** No NAT inside the mesh. A packet from
   `192.168.20.15` arrives at `10.0.1.7` with source `192.168.20.15`. This is
   what makes firewall rules, logs and access control at each site meaningful.
   (A per-site masquerade *fallback* exists for routers that cannot add routes;
   it is opt-in and clearly labelled.)
5. **Works with any router, best with UniFi.** The router contract is tiny:
   port-forward one UDP port, add static routes to one next hop. Any router can
   do that. For UniFi OPNmesh also does it *for* you through the UniFi API.
6. **Nothing hardcoded.** Ports, subnets, MTU, keepalive, interface names and
   poll intervals are settings with sensible defaults.
7. **Gateways never trust the controller blindly.** The agent writes only its
   own known files, refuses any config that would run commands, and holds its
   last known good configuration if the controller disappears.
8. **Tested on Ubuntu, always.** Every layer has automated tests that run inside
   Ubuntu 24.04 containers with kernel WireGuard, including a full simulated
   four-site network with routers, so behaviour on a real Ubuntu VM is what
   was tested, not what was assumed.

## 3. Components

### 3.1 Controller

A single Next.js 16 application (App Router, TypeScript, Tailwind v4) with an
embedded SQLite database (better-sqlite3 via Drizzle ORM). It serves:

- **The admin UI** — the dashboard and every management page.
- **The admin API** — route handlers under `/api/admin/*`, used by the UI.
- **The gateway API** — route handlers under `/api/agent/*`, used by gateway
  agents (enrol, fetch config, report telemetry).
- **Enrolment assets** — `/install.sh` and `/dl/opnmesh-gw-<os>-<arch>`, the
  installer and agent binaries, served from the controller so a site never
  depends on GitHub being reachable during install.
- **A live event stream** — `/api/admin/live` (Server-Sent Events) that pushes
  gateway/tunnel/client state to open dashboards every few seconds.
- **UniFi integration** — a module that talks to a UniFi console's local API
  to create and reconcile static routes and firewall policies for a site.

Long-lived state the controller keeps in memory (rebuilt on start):

- last telemetry report per gateway (peers, counters, probes);
- computed throughput per tunnel (difference of successive byte counters);
- SSE subscriber list.

Everything durable is in SQLite. Time-series samples for charts are stored in
SQLite too, downsampled on a schedule (see §11).

TLS is terminated by **Caddy** in the same compose file: automatic Let's
Encrypt certificates when a public hostname is configured, otherwise a private
CA that gateways are taught to trust at install time (§12.2).

### 3.2 Gateway agent (`opnmesh-gw`)

A single static Go binary (Linux amd64/arm64) run by systemd as root on an
Ubuntu VM. It is deliberately small. It:

1. **Enrols** once, with a one-time token: generates a WireGuard keypair
   locally, sends only the public key, receives a per-gateway API token.
2. **Polls** the controller for its desired configuration: `opnmesh0.conf`
   (WireGuard), `nftables.conf` (forwarding rules and counters) and
   `sysctl.conf` (IP forwarding). It applies changes only when the content
   differs from disk, using `wg syncconf` for peer-only changes so the tunnel
   never flaps for a routine edit.
3. **Reports telemetry** every few seconds: per-peer byte counters and
   handshake age from the kernel, round-trip latency to each peer's tunnel
   address (ICMP), the per-site-pair byte counters from nftables, and host
   facts (version, uptime, load, interface addresses).
4. **Holds last known good.** If the controller is unreachable the tunnel keeps
   running from the files already on disk, forever. Boot works with no
   controller: systemd brings up `opnmesh0` from disk before the agent even
   starts.

Why Go and not Node/TypeScript: the gateway VM should need no runtime. A
static binary is ~8 MB, starts instantly, and is trivially built for arm64
(Raspberry Pi as a small-site gateway). The agent is the only non-TypeScript
code in the repository and is kept under ~2,000 lines.

### 3.3 Roaming clients

Ordinary WireGuard apps (Windows, macOS, iOS, Android, Linux). The controller
generates the keypair and the `.conf`, shows it as a QR code and a download,
and can issue a one-time link so the person collects it themselves. See §6.

### 3.4 Site routers

Not managed by OPNmesh, except through the optional UniFi integration. See §7
and [ROUTERS.md](ROUTERS.md).

## 4. How traffic flows

Take host `192.168.20.15` at the office (site B) opening the Proxmox UI at
`10.0.1.7` in the datacentre (site A). Site B's gateway VM is `192.168.250.2`
on a dedicated transit VLAN (§7.1); site A's is `10.0.250.2`.

```
1. 192.168.20.15 → default gateway (UniFi router B)          "where is 10.0.1.0/24?"
2. Router B: static route 10.0.1.0/24 via 192.168.250.2       → gateway VM B
3. Gateway B: kernel route 10.0.1.0/24 dev opnmesh0           (from AllowedIPs)
   WireGuard: which peer has 10.0.1.0/24 in AllowedIPs? → peer "site-a"
   encrypt, send UDP to A's public IP:51820
4. Router A: port-forward UDP 51820 → 10.0.250.2              → gateway VM A
5. Gateway A: decrypt; source 192.168.20.15 is in peer B's AllowedIPs → accepted
   nftables forward chain: LAN-set(B) → LAN-set(A) counter, accept
   kernel route 10.0.1.0/24 via router A's transit address    → router A
6. Router A → 10.0.1.7 (directly connected VLAN)
7. Reply 10.0.1.7 → router A: static route 192.168.20.0/24 via 10.0.250.2
8. Gateway A → WireGuard peer B → gateway B → router B → 192.168.20.15
```

Four facts make this work, and every one is generated and tested:

- **AllowedIPs is both a route and a filter.** On gateway B, peer A's
  AllowedIPs is exactly A's tunnel address plus A's shared subnets (plus any
  subnets A relays for, §5). wg-quick installs kernel routes for these, and
  WireGuard drops any decrypted packet whose source is not in the sending
  peer's AllowedIPs. A misgenerated AllowedIPs is a security bug, not a
  cosmetic one, so the generator is the most heavily tested code in the
  project and its output is independently re-parsed by validators.
- **The gateway forwards.** `net.ipv4.ip_forward=1`, and the nftables forward
  chain accepts LAN ⇄ mesh traffic for shared subnets.
- **The router knows the way back.** Without the static route in step 7 the
  reply would go out to the internet and die. This is the one thing the site
  router must do.
- **MSS clamping.** WireGuard costs 60 bytes of overhead (80 with IPv6 outer),
  so the tunnel MTU is 1420. The forward chain clamps TCP MSS to the path MTU
  in both directions so large transfers do not stall while ping still works.

## 5. Topology: which gateway talks to which

Every gateway is either **reachable** (its site can port-forward a UDP port to
it, so it has a public endpoint) or **outbound-only** (behind CGNAT, a
double NAT, or a router someone cannot change).

Rules, applied deterministically from the database so every gateway computes
the same answer:

1. Two reachable gateways peer **directly**.
2. An outbound-only gateway peers directly with **every** reachable gateway
   (it dials them; `PersistentKeepalive` holds the NAT mapping open).
3. Two outbound-only gateways cannot reach each other directly. Their traffic
   **transits** the highest-priority reachable gateway (the "hub"). The hub's
   AllowedIPs on each side carries the other side's subnets, and the hub's
   forward chain accepts mesh → mesh traffic for exactly those pairs.
4. A pair with no possible path is a validation error shown in the UI ("open
   a UDP port at one of these sites").

This produces a full mesh whenever it can, and hub-and-spoke only where the
network forces it, with no configuration. Each reachable gateway has a **hub
priority** (drag to reorder in Settings); the first one is the default hub.
The dashboard's connectivity view says, per pair, "direct" or "via Site A",
and what would be cut off if any one site went down (single point of failure
report).

Prefix ownership invariant: across one gateway's `opnmesh0.conf`, every prefix
appears in exactly one peer's AllowedIPs. The validators check this on every
generation.

## 6. Roaming clients (home workers)

A client is a WireGuard peer that belongs to a person, not a site.

- **Address**: one `/32` from the client range (default `10.99.1.0/24`).
- **Keys**: generated by the controller (X25519 via Node's `crypto`), the
  private key stored encrypted at rest with the controller's secret (§12.4).
  Storing it is a deliberate trade-off: it lets an admin re-show a QR code or
  re-send a config months later, which is what small IT teams actually need.
  "Rotate keys" regenerates the pair and invalidates the old config; per
  client "expires on" disables the peer automatically.
- **Entry points**: the client peers with *every* reachable gateway. Each peer
  carries that site's subnets, so the laptop reaches each site directly, not
  via a hub. Subnets of outbound-only sites are carried by the client's
  **preferred site** (default: the first hub), which relays for them.
- **Reach**: by default a client can reach every shared subnet at every site.
  Optionally restrict a client to a list of sites; the generator then omits
  the other sites' subnets from its AllowedIPs and the gateways' forward
  chains drop anything else from that client. Both mechanisms are generated
  from the same data.
- **Isolation**: clients may open connections into sites; sites cannot open
  connections to clients (stateful rule on every gateway); clients cannot see
  each other. A per-client "allow inbound" switch relaxes the second rule for
  cases like remote support to a laptop.
- **Delivery**: the client page shows a QR code (scan in the WireGuard mobile
  app), a `.conf` download (desktop apps), and a **one-time link**
  (`https://controller/invite/<token>`) that shows the QR/config once and then
  expires, so the admin can send a link over Teams/email without pasting keys.
- **DNS**: optional. A site can declare a DNS server; clients get it in their
  config with the site's search domain. No DNS proxying in 2.0.

Config the client receives (illustrative):

```ini
[Interface]
Address = 10.99.1.10/32
PrivateKey = <generated>
MTU = 1420
DNS = 10.0.1.53

[Peer]  # site-a (datacentre)
PublicKey = ...
Endpoint = dc.example.com:51820
AllowedIPs = 10.99.0.1/32, 10.0.1.0/24, 10.0.99.0/24, 10.30.0.0/16   # + warehouse via A
PersistentKeepalive = 25

[Peer]  # site-b (office)
PublicKey = ...
Endpoint = 203.0.113.20:51820
AllowedIPs = 10.99.0.2/32, 192.168.20.0/24, 192.168.30.0/24
PersistentKeepalive = 25
```

## 7. The site router: three layouts

The gateway VM sits *beside* the router, not in front of it. Hosts keep their
normal default gateway. The router must send traffic for remote subnets to the
VM. How the VM is attached decides how clean that is. OPNmesh supports three
layouts per site, chosen on the site page; the printed router instructions and
the UniFi automation follow the choice.

### 7.1 Transit network (recommended)

Give the gateway VM its own small VLAN/network — e.g. `192.168.250.0/29`, VM at
`.2`, router at `.1` — with no other hosts on it. Router static routes for each
remote subnet point at `192.168.250.2`.

```
LAN hosts ──► router ──► (transit VLAN) ──► gateway VM ──► tunnel
LAN hosts ◄── router ◄── (transit VLAN) ◄── gateway VM ◄── tunnel
```

Every packet in both directions crosses the router, so routing is
**symmetric**: the router's stateful firewall sees whole connections, no ICMP
redirects are involved, and the router's firewall policies (UniFi zones) can
control exactly which local VLANs may talk to which remote subnets. This is
how a router-to-router VPN would behave, which is what the router expects.

Cost: one extra hop through the router (wire speed on any UniFi gateway) and
one VLAN. This is the layout the UniFi automation sets up by default.

### 7.2 Same LAN (simple, but asymmetric)

Put the VM on an existing LAN, e.g. `192.168.20.2`. Router static routes point
at it. Forward traffic goes host → router → VM (the router hairpins it back out
the same interface); **return traffic goes VM → host directly**, never touching
the router.

```
LAN host ──► router ──► gateway VM ──► tunnel
LAN host ◄─────────────  gateway VM ◄── tunnel
```

Consequences, all real and all seen with UniFi:

- The router sends an ICMP redirect ("send this straight to `.2`") and most
  hosts obey, so after the first packet the router drops out of the path.
  Hosts that ignore redirects keep hairpinning through the router.
- The router's connection tracker sees only half of each connection. After a
  SYN it expects a SYN-ACK; instead it sees the client's ACK, which Linux
  conntrack classifies as **INVALID**. UniFi's default rules drop invalid
  packets, so *ping works and TCP hangs* — the classic symptom. The fix is a
  firewall policy on the router that allows traffic from the local networks to
  the remote subnets with **all connection states** (including invalid), placed
  above the defaults. OPNmesh prints that policy and the UniFi integration
  creates it.

This layout is supported because it is what people try first, and with the
policy it works. The UI labels it "works, but asymmetric" and suggests 7.1.

### 7.3 No router changes (masquerade fallback)

For a site whose router cannot take static routes at all. The gateway
**SNATs traffic entering the site from the mesh** to its own LAN address, so
LAN hosts reply to the VM as if it were the client. Nothing on the router
changes; the site still accepts inbound tunnels if you can port-forward, or
dials out if you cannot.

Limits, stated plainly in the UI: remote sites and roaming clients can reach
this site's hosts, but the hosts see the gateway's address, not the real
source; and hosts at this site cannot *initiate* connections to remote sites
unless they have a manual route to the VM. This is the same trade-off NetBird
and Tailscale document for their masquerade defaults. It is opt-in per site
and the only place NAT exists in OPNmesh.

### 7.4 Inbound port

A site that accepts tunnels needs one UDP port (default 51820) forwarded from
the router's WAN to the VM. A site with a dynamic public IP uses a DDNS
hostname as its endpoint. WireGuard resolves a name only once, when the peer
is set, so the agent re-applies a peer's hostname endpoint whenever that
peer's handshake is more than 135 seconds old (at most every 30 seconds per
peer), the same remedy as wg-quick's reresolve-dns script. A site whose
public address changes is back within a few minutes with nobody involved.

### 7.5 UniFi automation

For UniFi sites the site page has a "Connect to UniFi" panel: console URL,
API key (Settings → Control Plane → Integrations on the console), and the
UniFi site name (usually `default`). OPNmesh then **owns** a set of objects
on that console, named `OPNmesh: …`, and keeps them equal to what the mesh
needs:

- one static route per remote shared subnet (and one for the client range and
  the tunnel range), next hop = the VM's address, distance 1;
- for the same-LAN layout, the all-states allow policy;
- the WAN port forward for the listen port is *shown*, not created, because
  port-forwards are security-sensitive and take seconds by hand.

It reconciles on every topology change and every 10 minutes, shows "in sync"
or a diff, and never touches objects it did not create. Details, endpoints and
research in [ROUTERS.md](ROUTERS.md).

## 8. Data model

SQLite, managed with Drizzle migrations. Identifiers are short random strings;
names are for humans and may change freely.

```
settings          singleton: network_name, gateway_cidr (10.99.0.0/24),
                  client_cidr (10.99.1.0/24), listen_port (51820), mtu (1420),
                  keepalive (25), interface_name (opnmesh0), telemetry_interval_s (5),
                  public_url, config_version (monotonic), setup_complete,
                  smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc,
                  smtp_from, alert_to
users             id, email, password_hash (argon2id), created_at
sessions          id (hash), user_id, created_at, last_seen_at, expires_at
sites             id, name, slug, notes, router_layout (transit|same_lan|masquerade),
                  hub_priority, dns_server?, dns_domain?, alert_email, created_at
lans              id, site_id, cidr, name, vlan?, shared (bool), sort
gateways          id, site_id, name, hostname, public_key, tunnel_ip, lan_ip,
                  endpoint_host?, listen_port?, mtu?, token_hash, status
                  (pending|active|disabled), enrolled_at, approved_at, last_seen_at,
                  agent_version, os, arch, addresses (json), last_error, applied_hash,
                  disk_hash, alert_state, diag_requested_at?, diag_at?, diag_json?
enrol_tokens      id, site_id, token_hash, auto_approve, expires_at, used_at,
                  created_by
clients           id, name, owner?, tunnel_ip, public_key, private_key_enc,
                  psk_enc?, enabled, expires_at?, preferred_site_id?,
                  allowed_site_ids? (json; null = all), allow_inbound (bool),
                  created_at, last_handshake_at
invites           id, client_id, token_hash, expires_at, used_at
unifi_links       id, site_id, base_url, unifi_site, auth_kind (api_key|password),
                  secret_enc, cert_fingerprint?, managed_ids (json), last_sync_at,
                  last_sync_status, last_sync_detail
telemetry_5s      ts, gateway_id, peer_key, rx_bytes, tx_bytes, handshake_age_s,
                  rtt_ms?   (raw samples, kept 2 hours)
telemetry_1m      ts, gateway_id, peer_key, rx_bps, tx_bps, rtt_ms  (kept 30 days)
telemetry_1h      ts, gateway_id, peer_key, rx_bps, tx_bps, rtt_ms  (kept 2 years)
pair_5s/1m/1h     ts, gateway_id, from_slug, to_slug, bps (+ bytes on pair_5s): routed
                  site-to-site traffic from the nftables counters, same retention
                  as the telemetry tables
events            ts, actor, kind, subject, message, detail (json)
```

Derived, never stored: which pairs peer, who transits for whom, every
AllowedIPs list, every nftables set. `config_version` increments on any write
that changes generated output; agents compare it to what they applied.

## 9. Generated configuration

One pure function: `generate(snapshot) → Bundle`, where `snapshot` is the
whole relevant database read in one transaction and `Bundle` is:

```
bundle.gateways[gatewayId] = {
  files: { "wireguard.conf": …, "nftables.conf": …, "sysctl.conf": … },
  meta:  { interfaceName, listenPort, needsReresolve, privateKeyPath },
  hash:  sha256 of the files (what the agent applies and reports back)
}
bundle.clients[clientId]   = { conf: "…" }
bundle.routers[siteId]     = { routes: [{cidr, via, label}], portForward?, firewallNotes: [...] }
bundle.hash                = sha256 of everything above
```

Properties enforced by tests:

- **Deterministic**: same snapshot → byte-identical bundle (peers sorted by
  tunnel IP, no timestamps).
- **No secrets**: gateway private keys never leave the gateway (the config
  loads it from a root-only file via one sanctioned `PostUp`); client private
  keys appear only in client `.conf`.
- **AllowedIPs exactly right**: an independent validator re-parses every
  generated `.conf` and recomputes the expected set from topology rules.
- **No NAT** except the explicit masquerade layout, and only on that gateway.
- **Golden files**: reference scenarios (single site, two reachable sites,
  hub-and-spoke with two outbound-only sites, multi-VLAN, restricted client,
  masquerade site) have committed golden outputs; a change to any generated
  byte must be reviewed in a diff.

### 9.1 `opnmesh0.conf` (gateway)

```ini
# Generated by OPNmesh v2 — do not edit; overwritten on reconcile.
# gateway: office (site-b)
[Interface]
Address = 10.99.0.2/24
ListenPort = 51820
MTU = 1420
PostUp = wg set %i private-key /etc/opnmesh/private.key

[Peer]
# site-a
PublicKey = …
Endpoint = dc.example.com:51820
AllowedIPs = 10.99.0.1/32, 10.0.1.0/24, 10.0.99.0/24, 10.99.0.3/32, 10.30.0.0/16
# (10.30.0.0/16 belongs to the warehouse, outbound-only, relayed by site-a)

[Peer]
# client: alice-laptop
PublicKey = …
AllowedIPs = 10.99.1.10/32
```

### 9.2 `nftables.conf` (gateway)

Everything lives in `table inet opnmesh`, replaced atomically on reload; the
operator's own tables are untouched.

```
table inet opnmesh {
  set lan_self   { type ipv4_addr; flags interval; elements = { 192.168.20.0/24, 192.168.30.0/24 } }
  set lan_site_a { … }
  set clients    { … 10.99.1.0/24 … }
  set clients_restricted_x { … }   # only when a client has a site restriction

  counter c_site_b_to_site_a {}   # one per ordered site pair this gateway sees
  counter c_site_a_to_site_b {}

  chain forward {
    type filter hook forward priority filter; policy drop;
    ct state established,related accept
    ct state invalid drop
    # MSS clamp both ways
    oifname "opnmesh0" tcp flags syn tcp option maxseg size set rt mtu
    iifname "opnmesh0" tcp flags syn tcp option maxseg size set rt mtu
    # sites cannot open connections to clients (unless allow_inbound)
    oifname "opnmesh0" ip daddr @clients ct state new drop
    # restricted clients: drop anything outside their allowed sites
    iifname "opnmesh0" ip saddr @clients_restricted_x ip daddr != @lan_site_a drop
    # per-pair counters and accepts
    ip saddr @lan_self ip daddr @lan_site_a counter name "c_site_b_to_site_a" accept
    ip saddr @lan_site_a ip daddr @lan_self counter name "c_site_a_to_site_b" accept
    # clients into this site
    iifname "opnmesh0" ip saddr @clients ip daddr @lan_self accept
    # transit pairs (hubs only)
    iifname "opnmesh0" oifname "opnmesh0" ip saddr @lan_site_c ip daddr @lan_site_a accept
  }
  chain postrouting {                # only on masquerade-layout sites
    type nat hook postrouting priority srcnat;
    iifname "opnmesh0" oifname != "opnmesh0" masquerade
  }
}
```

### 9.3 Router instructions

Rendered from `bundle.routers[siteId]` as a plain-language page: the static
routes with the exact next hop, the port forward, the firewall policy for the
same-LAN layout, and UniFi-specific click paths for Network 9.x and 10.x.

## 10. Controller ⇄ gateway protocol

HTTPS, JSON, gateway always initiates. The controller never dials a gateway.

| Call | Auth | Purpose |
|---|---|---|
| `GET /install.sh` | none | Installer script. The UI shows its SHA-256 next to the one-liner. |
| `GET /dl/opnmesh-gw-linux-{amd64,arm64}` | none | Agent binary (+ `.sha256`). |
| `POST /api/agent/enrol` | one-time token | `{token, publicKey, hostname, os, arch, addresses}` → `{gatewayId, gatewayToken, status}`. Token is single-use, bound to a site, 30-minute TTL. |
| `GET /api/agent/config` | gateway token | `If-None-Match: <version>` → `304`, or `200 {version, files, meta}`, or `202 {status:"pending"}` before approval. |
| `POST /api/agent/telemetry` | gateway token | Body §11.1. Response `{configHash, intervalSeconds, actions}` so a changed config is fetched on the very next tick without a second poll loop; `actions` carries anything the admin asked for (§11.4). |
| `POST /api/agent/diagnostics` | gateway token | The gateway's answer to a `diagnose` action: `{id, ranAt, checks[]}` (§11.4). |

Agent loop, every `intervalSeconds` (default 5, jittered ±20%):

```
report telemetry ─► response.configVersion ≠ applied? ─► GET config ─► apply
                                                          (diff on disk, validate hooks,
                                                           write atomically, wg syncconf
                                                           or wg-quick down/up, nft -f)
```

Apply rules (from v1, kept because they were right):

- Files are written only under `/etc/opnmesh/` by exact allowlisted name.
  The logical `wireguard.conf` lands as `/etc/opnmesh/<interface>.conf`
  because wg-quick takes the interface name from the file name.
- The only `PostUp`/`PreUp`/`PostDown`/`PreDown` accepted is
  `wg set %i private-key /etc/opnmesh/private.key`. Anything else is refused
  and reported; the existing tunnel is left alone.
- If only `[Peer]` sections changed, `wg syncconf` is used (no flap). The
  temporary file handed to syncconf has the private key injected from the
  gateway's key file, because syncconf replaces the whole `[Interface]` and a
  file without the key would clear it and kill every tunnel (found in the
  simulation, wireguard-tools 1.0.20210914). A self-check on every loop tick
  restores the key if the interface ever loses it. If the `[Interface]`
  changed (port, address, MTU) the tunnel is restarted, after checking the
  new port can be bound.
- Before overwriting, the previous files are kept as `*.prev`; `opnmesh-gw
  rollback` restores them offline.
- A change that needs a restart and fails is rolled back on the spot: the
  previous files come back and the tunnel is brought up from them, the error
  is reported to the controller, and that configuration is not tried again
  for five minutes unless the controller changes it. A change applied with
  `wg syncconf` that fails leaves the running interface as it was.
- Every tick, before talking to the controller, the agent brings the
  interface up from disk if it is missing (a boot before DNS was ready, a
  manual `wg-quick down`), restores a lost private key, and re-resolves
  stale hostname endpoints (§7.4).

## 11. Real-time traffic and the dashboard

### 11.1 What a gateway reports

```json
{
  "version": "2.0.3", "uptimeSeconds": 8123, "appliedVersion": 41, "diskHash": "…",
  "lastError": "",
  "peers": [
    { "publicKey": "…", "endpoint": "203.0.113.20:51820", "latestHandshake": 1757000000,
      "rxBytes": 123456789, "txBytes": 98765432, "rttMs": 14.2 }
  ],
  "pairCounters": [ { "from": "site-b", "to": "site-a", "bytes": 55555, "packets": 444 } ],
  "host": { "load1": 0.12, "memUsedPct": 31, "addresses": ["192.168.250.2/29"] }
}
```

`rttMs` comes from an ICMP echo to each peer's tunnel address, sent by the
agent between reports; a peer that answers is *proven* reachable end to end,
which is a stronger signal than a recent handshake.

### 11.2 What the controller derives

- **Throughput per tunnel** = Δbytes / Δt between successive reports, per
  direction, taking the fresher of the two ends' counters.
- **Site-to-site matrix** = Δpair counters / Δt. Because counters live on the
  forwarding gateway, this is the *routed* traffic between two sites' LANs,
  not just tunnel bytes, and includes traffic transiting a hub.
- **Status** per gateway: `online` (report < 3 intervals old), `stale`,
  `offline`, `pending`, plus `attention` when the last apply failed or disk
  differs from desired.
- **Status** per tunnel: `up` (handshake < 3 min and RTT answered), `handshake
  only`, `down`.
- **Client presence**: last handshake seen by any gateway.

Samples are written to `telemetry_5s`; a scheduled job rolls up to 1-minute and
1-hour averages and prunes. All of this is a few hundred rows per gateway per
hour; SQLite handles years of it in a file.

### 11.2a Live series and history ranges

Alongside the durable samples, the controller keeps an in-memory ring of
the last 120 seconds of per-site throughput, sampled once a second from the
live rates, and pushes it with every dashboard update (once a second). The
overview graph's "Live" range draws from that ring, so every viewer sees the
same last-60-seconds curve and a freshly opened page has history at once.
History ranges (1 h, 6 h, 24 h, 7 d, 30 d, 1 y) come from the telemetry
tables, choosing the coarsest rollup that fits (5 s samples for hours,
minutes for days, hours for months and the year) and bucketing to at most
about 600 points per series, so a year renders as quickly as an hour. Hourly
rows are kept for two years; per-second detail exists only in the ring.

Figures shown live in the UI are eased on the client (about 10% of the
remaining gap per frame) so a rate that arrives in steps every few seconds
glides rather than jumps.

### 11.2b Email alerts

Settings hold an SMTP server, from address and recipient list (password
sealed at rest). Every 15 seconds the controller evaluates each site that has
alerts switched on (the default for new sites): a gateway whose health drops
to *offline* produces one "not responding" email; its return to *online*
produces one "is back" email. The last notified state is stored on the
gateway row, so a controller restart never re-sends, and a two-minute grace
after start avoids a storm of mails for gateways that simply have not
reported yet. Send failures are written to the event log. A "send a test
email" button exercises the real path.

### 11.2c Adaptive reporting

Gateways report every `telemetryIntervalS` (default 5 s). While an overview
page is open — its live stream connects with `?fast=1` — the telemetry
response asks for `intervalSeconds: 1` instead, and keeps doing so for 20 s
after the last such viewer leaves so a page reload does not flap. Nothing on
the gateway side knows about "modes": it simply honours the interval in each
response. Health thresholds scale with the *configured* interval, so faster
reports only ever make a gateway look more alive, never less.

### 11.2d Motion on the dashboard

Three things move, and each is smoothed the same way: an exponential
approach toward the latest sample with a time constant, computed per frame
from real elapsed time so it is identical at any refresh rate.

- The map shows traffic by link weight alone (a hairline at rest, bold under
  load, log scale from 100 kbit/s to 100 Mbit/s), eased with a 700 ms constant.
  No figures or particles on the lines; figures are in the hover card.
- Live numbers ease with a 1.2 s constant, and the headline "traffic between
  sites" with 2.2 s, which also low-passes sample-to-sample noise.
- The live graph glides right to left continuously: samples are laid out
  against the latest sample time and one SVG transform, updated every frame
  from the controller's clock, slides the plot. The right edge lags the
  clock by 1.5 s, so each new sample enters from beyond the edge instead of
  appearing at it; nothing ever jumps when data arrives.

### 11.2e Visual system

Dark only, frosted glass over a wallpaper. Three things make it read as glass
rather than as translucent cards, and all three live in `app/globals.css`:

- The panes are mostly transparent (36% near-black) with
  `backdrop-filter: blur(18px) saturate(1.9)`, a light hairline edge and an
  inset top highlight. Opaque panes have nothing to blur.
- A wallpaper sits under the content (fixed, `body::before`): an Unsplash
  gradient compressed to a 15 kB WebP at 2000 px, softened with a 4 px blur
  so compression never shows through the glass, drawn at 35% opacity over
  solid black so it glows rather than shouts (`--wallpaper-opacity` is the
  one number to tune). The blur only samples what is directly behind an
  element, so the wallpaper's colour has to be under the panes, which a
  full-bleed image guarantees.
- There is no light mode: the tokens carry one set of values and
  `color-scheme: dark` keeps native controls and scrollbars dark too.
- A faint SVG noise grain (`body::after`, 4.5% opacity) gives the frosting
  texture.

Ink stays near-white, so text contrast is unaffected by the tints behind it.
Status tints and hover fills are translucent so they sit on glass.

### 11.3 The dashboard

- **Headline**: one sentence — "Everything is working", "Warehouse has not
  reported for 4 minutes", "Config change waiting for 2 gateways".
- **Live map**: sites as nodes, tunnels as links, clients as small satellites.
  Link brightness and an animated flow follow current throughput; hovering
  shows Mbit/s each way, RTT and handshake age; colour is reserved for
  problems. Updates arrive over SSE; the picture eases between samples rather
  than stepping.
- **Traffic**: the site-to-site matrix as a heat table, a per-tunnel table
  (rate, RTT, handshake, totals), and 1h / 24h / 7d / 30d charts per pair.
- **Sites**: cards with status, LANs, layout, router-sync state.
- **Clients**: list with online dot, last seen, owner, expiry; detail page with
  QR/config/invite.
- **Events**: audit log (who changed what, gateway joins, apply failures,
  UniFi syncs).

The UI is plain-language first ("connects directly", "routes through the
datacentre — if it goes down these two lose contact"), with the technical
detail one click deeper. Design tokens are custom (Tailwind v4 `@theme`): a
neutral dark surface, a single accent, and colour used only for status.

### 11.4 Health checks

"Run checks" on a site page answers the questions a person would otherwise
work through by hand, and says what to do about each. Two halves:

**Controller side** (computed on every read, no gateway involvement): is the
gateway reporting, is its configuration current, did the last apply fail, is
the interface up, does the public name resolve, does every direct peer have a
fresh handshake *and* a round-trip time, and can anything dial in. The
inbound check uses evidence rather than a probe — WireGuard silently ignores
packets from unknown keys, so an external UDP probe proves nothing — and
reads it from the peers that must dial this site (outbound-only sites and
clients): if one of them reaches other sites but never this one, the port
forward here is the culprit.

**Gateway side** (on request; the request rides on the next telemetry
response as `actions: [{type: "diagnose", request}]` and the answer is posted
to `/api/agent/diagnostics`):

| Check | How |
|---|---|
| IP forwarding | `/proc/sys/net/ipv4/ip_forward` |
| Interface up, listen port | `wg show`, compared with what other sites are told to dial |
| Firewall loaded | `nft list table inet opnmesh` |
| Host firewall | `ufw status`, when ufw is active |
| Peer names resolve | `LookupHost` for every hostname endpoint |
| Routes | `ip route get` for a host in each remote LAN must name the tunnel interface. The tunnel address ranges are deliberately not checked this way: clients get per-client /32 routes and the gateway range is a connected route, so neither appears as a whole. |
| **Site router routes** | For each remote network, a UDP probe addressed to a host in it (the first host, or the last when the first is one of the gateway's own addresses, which the kernel would deliver locally) is handed to the default router with **TTL 2**. It is steered there by a policy-routing rule matching only the probe's own source address (table 250, pref 11000, removed straight after), so the main table is untouched, no other traffic is affected, and an existing tunnel route for the same destination (a connected roaming client's /32, say) cannot capture it. A router with the static route sends it straight back to the gateway, where a packet socket on the LAN interface sees it; a router without it sends the probe to the internet, where the TTL expires. Skipped for the masquerade layout. |
| Packet size | A ping with fragmentation forbidden, sized to the tunnel MTU, to each direct peer; EMSGSIZE or silence means the path cannot carry full-size packets |

The router probe catches the classic "I added the VLAN but forgot the route"
and "the route points at the old VM" mistakes in one click, without touching
the router. Results are stored per gateway (last run only) and shown
problems-first, with passed checks folded away.

## 12. Security model

### 12.1 Trust boundaries

| Tier | Holds | Can do |
|---|---|---|
| Public | anyone reaching the controller's HTTPS port | download installer/binaries; call enrol (rate-limited, token-gated); open an invite link (token-gated). |
| Gateway | one 256-bit bearer token per gateway, stored root-only on the VM, hash stored in SQLite | fetch *its own* config; post *its own* telemetry. Nothing else. |
| Admin | a logged-in browser session | everything in the UI/admin API. |

### 12.2 Transport

Caddy terminates TLS. With `OPNMESH_DOMAIN` set it obtains Let's Encrypt
certificates; agents verify with system roots. Without a domain Caddy runs a
private CA; the install one-liner carries the CA fingerprint, the installer
downloads the root, checks the fingerprint, and the agent trusts *only* that
root from then on. A swapped certificate is refused. Caddy only picks its
internal CA by itself for IP addresses and a few reserved suffixes, so the
controller installer sets `tls internal` explicitly whenever no public
domain is given; a private hostname works the same way as an address. Caddy
keeps the CA root file root-only; the compose file makes just that one file
readable so the controller (which runs unprivileged) can serve it at
`/ca.crt` and print its fingerprint into install commands.
One more Docker detail: a client that connects to an IP address sends no
server name, and Caddy then looks for a certificate matching the
connection's local address, which behind Docker's port forwarding is the
container's internal IP rather than the site's. The Caddyfile sets
`default_sni` to the site so such connections are served the site's
certificate; without it every IP-address deployment failed the TLS
handshake from outside the container. Plain HTTP is allowed only
with `OPNMESH_INSECURE_HTTP=1`, which exists for the simulation.

### 12.3 Admin authentication

One local admin account created on first run (a setup code is printed to the
container log). Passwords are argon2id; sessions are server-side, hashed, with
idle and absolute timeouts; login failures are throttled per source and
globally; `X-Forwarded-For` is trusted only from Caddy. TOTP is planned for
2.1. Security headers and same-site cookies throughout.

### 12.4 Secrets at rest

The sealing secret (`OPNMESH_SECRET`, or `secret.key`, which the controller
generates on first start and keeps in the data volume) derives the key that encrypts client private keys, pre-shared keys
and UniFi credentials (AES-256-GCM, per-row nonce). Gateway private keys are
never on the controller. A database backup is useless without the secret; the
backup page says so.

### 12.5 Gateway hardening

Inherited from v1: managed-file allowlist, hook allowlist, atomic writes,
rollback, no command execution requested by the controller, tunnel kept up
when the controller is down. The agent runs as root because it must manage
WireGuard and nftables; it makes no outbound connections other than to the
controller URL and the WireGuard peers.

### 12.6 What the repository never contains

No private keys, tokens or real topologies. CI greps every commit for key
material and fails the build. `.env` files and data volumes are gitignored.

## 13. Deployment

### 13.1 Controller

```bash
curl -fsSL https://raw.githubusercontent.com/CoppingEthan/OPNmesh/main/deploy/controller/install.sh | sudo bash
```

On any Ubuntu 22.04/24.04 with Docker, this creates `/opt/opnmesh/` with a
`docker-compose.yml`, `.env` (site name, public URL, ports, TLS mode),
starts Caddy + the controller, and prints the URL and one-time setup code.
The data directory is owned by uid 1000, the unprivileged user the image runs
as. Upgrading is `docker compose pull && docker compose up -d`. Backup is the
`/opt/opnmesh/data` directory (or the database download in Settings, which
is consistent while the controller runs) plus `.env`.

Where to run it: the recommended place is a small VM at the primary site
(the datacentre), with the router forwarding TCP 443 to it so gateways at
other sites can enrol. It may share the VM with that site's gateway. Any VPS
works too. After enrolment gateways may also reach it over the mesh, but the
design does not depend on that.

### 13.2 Gateway

In the UI: Sites → *site* → Gateway → "Install". Copy the one-liner:

```bash
curl -fsSL https://mesh.example.com/install.sh | sudo bash -s -- --token 3f9c…
```

It installs `wireguard-tools`, `nftables` and `iproute2`, downloads the agent
binary for the CPU, generates the keypair, enrols, installs the systemd units
(`opnmesh-gw.service` for the agent, `opnmesh-wg.service` bringing up
`opnmesh0` from disk at boot) and starts them. Sixty seconds later the site
shows "online" and the router instructions page shows the routes to add.

Ubuntu 22.04 and 24.04 are the supported gateway OS. Debian 12 works and is
tested opportunistically; anything with systemd, kernel WireGuard and nftables
should work.

### 13.3 Sizing

A 1 vCPU / 512 MB VM forwards several hundred Mbit/s of WireGuard on modern
hardware. The controller needs 1 vCPU / 1 GB.

## 14. Repository layout

```
opnmesh/
  README.md                     what it is, quick start, links to docs
  docs/                         this document, ROUTERS.md, PRIOR-ART.md, TESTING.md
  LICENSE                       MIT
  package.json                  Next.js app + tooling
  app/                          Next.js App Router: pages, layouts, route handlers
    (app)/…                     dashboard, sites, clients, traffic, events, settings
    (public)/…                  setup, login, invite pickup
    api/admin/…                 admin route handlers (+ /api/admin/live SSE)
    api/agent/…                 enrol, config, telemetry
    install.sh/route.ts         installer served with the controller URL baked in
    dl/[file]/route.ts          agent binaries
    invite/[token]/…            one-time client pickup page
  src/
    core/                       pure, framework-free TypeScript: the heart
      ip.ts                     CIDR maths
      model.ts                  snapshot types
      topology.ts               peering, transit, SPOF
      generate/                 wireguard.ts, nftables.ts, sysctl.ts, router.ts, index.ts
      validate.ts               independent re-parse checks
      crypto.ts                 X25519 keys, sealing
    db/                         Drizzle schema, migrations, repository functions
    server/                     controller runtime: live state, rates, rollups,
                                auth, rate limits, unifi/, telemetry ingest
    ui/                         shared React components, design tokens
  agent/                        Go: opnmesh-gw (go.mod, main.go, …, *_test.go)
  deploy/
    controller/                 install.sh, docker-compose.yml, Caddyfile, .env.example
    gateway/                    install.sh (the systemd units are embedded in it)
  scripts/                      agent build/test in Docker, sim driver, UI and deployment smoke tests
  sim/                          docker compose simulation: 4 sites with routers, hosts, client
  test/                         vitest unit + integration suites, golden files
  .github/workflows/            ci.yml (unit, go, sim), release.yml (image + binaries)
  Dockerfile                    multi-stage: builds agent binaries and the Next.js app
```

The `src/core` package has no imports from Next.js, the database or Node
APIs beyond `crypto`, so it is testable in isolation and reusable by scripts.

## 15. Testing strategy

Everything runs on Ubuntu, either in CI (GitHub-hosted Ubuntu runners) or in
Ubuntu 24.04 containers locally under Docker Desktop, whose kernel has
WireGuard built in. Full detail in [TESTING.md](TESTING.md).

1. **Unit (vitest)** — `src/core` and `src/server` pure logic: CIDR maths,
   topology, generators against golden files, validators, crypto sealing,
   telemetry rate maths, rollups, UniFi reconciler diffing against a fake
   console.
2. **Database** — repository functions against a temporary SQLite file.
3. **API** — route handlers invoked directly with `Request` objects: enrolment
   lifecycle, auth tiers (a gateway token must not read admin routes, etc.),
   config ETag flow, telemetry ingest, invite pickup.
4. **Agent (Go)** — parsers, hook validation, diff/apply decisions, telemetry
   collection against recorded `wg show dump` output.
5. **Simulation** — `sim/docker-compose.yml`: four sites, each an Ubuntu
   router container (ip_forward, conntrack firewall mimicking UniFi's
   defaults, port-forward/NAT) plus a gateway container running the real agent
   binary plus a LAN host; a roaming client on the WAN; the real controller
   image. Site A uses the transit layout, site B same-LAN, site C
   outbound-only behind NAT with masquerade, site D transit and outbound-only
   (so C and D relay through A). The integration suite drives the
   real admin API to build the network and asserts: hosts ping each other by
   real address across every pair, TCP transfers succeed (iperf3), the client
   reaches every site, source addresses survive (except at C, by design), a
   gateway restart keeps the others up, killing the controller changes nothing,
   an approved config change lands within 15 s, the dashboard's live stream
   reports the traffic the test generated.
6. **UI smoke** — build the app and load every page with a session, against
   the standalone server the image runs.
7. **Deployment smoke** — build the image, run the real controller installer
   against it on the CI runner (private CA, unprivileged container, bind-
   mounted data directory), and check the first-install flow end to end:
   TLS with the CA Caddy issued, `/ca.crt`, first-run setup, an install
   command carrying the CA fingerprint, the agent download over TLS.
8. **CI** — every push runs 1–4, 6 and 7 in minutes and 5 in about ten
   minutes; a release tag builds the multi-arch image and the agent binaries.

## 16. What changed from v1 and why

v1 (github.com/CoppingEthan/OPNmesh) proved the architecture — gateways as
site subnet routers, deterministic generation, a pull-only agent, plain
language UI — and its generator/validator discipline was excellent. It was
hard to deploy. v2 keeps the ideas and removes the weight:

| v1 | v2 | Why |
|---|---|---|
| Config in `sites.yml`, edited via UI, committed to a local git repo | SQLite, edited via UI, audit log in a table | One less concept; no YAML/git failure modes; proper relational integrity. |
| Two processes (dev control server + Next.js UI) sharing files | One Next.js process with route handlers | Half the code, one port, one log. |
| Prometheus + Alertmanager + Grafana + mailpit for observability | Built-in telemetry, rollups and charts in SQLite; optional `/metrics` | The dashboard is the product; the stack was four extra services to run. |
| Minisign-signed self-updates with A/B installs, commit-confirm, boot watchdog | Agent is updated by re-running the installer, which downloads the binary from the controller and verifies its SHA-256 | The failsafe machinery was more code than the rest of the agent and solved a problem small fleets do not have. |
| Coordinated mesh-wide port-change transaction | Change port; agents apply on next tick; UI shows which have not | Simpler mental model; a failed change is visible and reversible in the same place. |
| Full-mesh / multi-hub / single-hub as an explicit topology setting | Derived automatically from which sites are reachable, plus a hub priority list | Zero-config topology; the setting existed to describe a fact the data already knew. |
| Client private keys never on the controller (placeholder in config) | Generated and stored encrypted; QR is complete and re-showable | Admins send QR codes; that requires the key. |
| Enrolment token → pending → assign site/subnets → approve | Token pre-bound to a site, optional auto-approve | One click instead of a form; matches how NetBird setup keys and Tailscale auth keys work. |
| Guest/management LAN roles with ACL sets | LAN `shared` yes/no; per-client site restriction; everything else at the router (UniFi zones) | Keeps OPNmesh's rule set small; the router is where the admin already manages policy. |
| Same-LAN layout assumed | Transit-VLAN layout recommended, same-LAN and masquerade supported | Removes the asymmetric-routing trap that made UniFi deployments flaky. |
| Router instructions printed | Printed **and** pushed into UniFi via its API | The user's sites are all UniFi; this turns a 15-minute manual job into a checkbox. |
| Per-host flow records, packet capture | Dropped from 2.0 | Nice, but not what "realtime traffic between networks" needs first. |

## 17. Build phases

Each phase ends with its tests green on Ubuntu (locally in Docker and in CI).

1. **Foundation** — repo, Next.js 16 + Tailwind v4 + TypeScript strict,
   Drizzle/SQLite, `src/core` (ip, model, topology, generators, validators,
   crypto) with unit tests and golden files, CI running them.
2. **Controller API** — schema/migrations, settings, sites/LANs/gateways/
   clients repositories, enrolment tokens, agent endpoints, admin auth, admin
   API, installer/binary serving, tests.
3. **Agent** — Go binary: enrol, poll/apply, telemetry, rollback, systemd
   units, installer script; Go tests; Dockerfile builds it.
4. **Simulation** — `sim/` compose with routers, gateways, hosts, client,
   controller; integration suite proving cross-site connectivity for all three
   router layouts; CI job.
5. **Dashboard** — design tokens, layout, overview with live map (SSE), sites,
   clients (QR/conf/invite), traffic (matrix, charts), events, settings,
   setup/login.
6. **UniFi integration** — client for the classic API (API key + password
   modes, CSRF, cert pinning), reconciler, UI panel, fake-console tests.
7. **Packaging** — controller installer, compose + Caddy, multi-arch image,
   release workflow, docs polish, README.

## 18. Out of scope for 2.0

- IPv6 inside the mesh (the outer transport may be IPv6; inner addressing is
  IPv4 only in 2.0).
- Multiple gateways per site with failover (planned: two VMs sharing a VIP via
  keepalived, router points at the VIP).
- UDP hole punching / relays for two outbound-only sites (they transit a hub).
- DNS proxying / split DNS.
- Per-host flow records and packet capture.
- SSO / OIDC (2.1 will add TOTP first).
- Managing routers other than UniFi via API (instructions are printed for all).
