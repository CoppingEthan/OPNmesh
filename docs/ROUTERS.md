# Site routers — what they must do, and how OPNmesh does it for UniFi

OPNmesh never replaces the site router. The router keeps doing DHCP, NAT to the
internet, Wi-Fi, VLANs and its firewall. OPNmesh asks it for exactly two
things, both of which every business router can do:

1. **Forward one UDP port** from the WAN to the gateway VM, if this site should
   accept incoming tunnels. Sites that cannot (CGNAT, no control of the router)
   skip this and dial out instead.
2. **Route the remote subnets** — the other sites' LANs, the tunnel range and
   the roaming-client range — to the gateway VM's IP address ("next hop").

Everything below is about doing (2) without falling into the asymmetric-routing
trap, and about having OPNmesh do it automatically on UniFi.

## 1. The trap: a next hop on the same LAN as the hosts

Suppose the gateway VM is `192.168.20.2` on the office LAN and a workstation
`192.168.20.15` opens a TCP connection to `10.0.1.7` at the datacentre.

```
SYN      192.168.20.15 → router (.1) → hairpin → VM (.2) → tunnel → 10.0.1.7
SYN-ACK  10.0.1.7 → tunnel → VM (.2) → 192.168.20.15 directly (same L2)   ← router never sees it
ACK      192.168.20.15 → router (.1) → ???
```

The router's connection tracker recorded the SYN and is waiting for a SYN-ACK.
It never sees one. The next packet it sees is the workstation's ACK, which
Linux conntrack classifies as **INVALID** (an ACK in the original direction
from state SYN_SENT). UniFi gateways drop invalid packets by default, so the
handshake never completes. Ping from the workstation works (the router saw the
request, so the reply is expected), TCP hangs. This is the exact symptom v1's
README warned about with "a static route alone is not enough on UniFi".

The reverse direction is worse. A connection *from* a remote site to the
workstation arrives gateway → workstation directly, so the router never sees
it; the workstation's replies go to the router, which has no matching
connection and drops every one of them as invalid — TCP and ping alike. The
simulation reproduces both cases (`sim/test/mesh.test.ts`, "same-LAN trap").

Two things can rescue the same-LAN layout:

- **ICMP redirects.** A Linux router forwarding a packet back out the interface
  it arrived on sends the source an ICMP redirect ("use .2 directly"). Most
  hosts honour it and the router leaves the path, so only the first connection
  is affected. Not all hosts honour redirects, redirects are cached per
  destination and expire, and some UniFi firmware disables sending them, so
  this cannot be relied on.
- **A firewall policy that allows all connection states** for traffic from the
  local networks to the remote subnets, evaluated before the drop-invalid rule.
  This works reliably and is what OPNmesh prints/creates for the same-LAN
  layout.

Or you can avoid the trap entirely:

## 2. Recommended layout: a transit network for the gateway VM

Create a small VLAN/network on the router just for the gateway VM:

| Setting | Example |
|---|---|
| Network name | `OPNmesh transit` |
| VLAN ID | 250 |
| Subnet | `192.168.250.0/29` (router `.1`, VM `.2`) |
| DHCP | off (VM has a static address) |
| Zone (UniFi 9+) | Internal (default) |

Attach the VM's virtual NIC to VLAN 250 (on Proxmox: set the VLAN tag on the
bridge port, or give the VM a NIC on a VLAN-aware bridge). Now every packet
crosses the router in both directions:

```
192.168.20.15 → router → VLAN250 → VM → tunnel → … → tunnel → VM → VLAN250 → router → 192.168.20.15
```

Routing is symmetric, conntrack on the router sees both halves, no ICMP
redirects, and UniFi's zone firewall can decide which local VLANs may talk to
which remote subnets in the normal way. This is the layout the UniFi
automation configures by default and the one the simulation tests as "site A".

## 3. What to type into UniFi (by hand)

OPNmesh prints these values on each site's *Router setup* page with your real
addresses filled in. Menu names differ slightly by Network application
version; both current paths are given.

### 3.1 Static routes

One route per remote shared subnet, plus one for the tunnel range and one for
the roaming-client range.

- **Network 9.x**: Settings → Policy Engine → *Static Routes* tab → Create New
  (older 9.x builds: Settings → Routing → Static Routes).
- **Network 10.x**: Settings → Policy Table → Create New Policy → **Route** →
  choose **Static Route**.

Fields:

| Field | Value |
|---|---|
| Name | `OPNmesh: Datacentre LAN` (any name; OPNmesh-managed ones start with `OPNmesh:`) |
| Destination network | `10.0.1.0/24` |
| Type | **Next Hop** |
| Next hop | `192.168.250.2` (the gateway VM) |
| Distance | `1` |
| Enabled | yes |

Do not use "Interface" routes or policy-based routes for this; policy routes
on UniFi are firewall marks, not kernel routes, and return traffic will not
follow them.

### 3.2 Port forward (sites that accept inbound tunnels)

- **Network 9.x**: Settings → Firewall & Security → Port Forwarding → Create
  New.
- **Network 10.x**: Settings → Policy Table → Create New Policy → Port Forward.

| Field | Value |
|---|---|
| Name | `OPNmesh WireGuard` |
| From | Any |
| Port | `51820` |
| Forward IP | `192.168.250.2` |
| Forward port | `51820` |
| Protocol | **UDP** |

### 3.3 Firewall

**Transit layout**: nothing extra is required with default zones — the transit
network and the LANs are all in the *Internal* zone and Internal → Internal
is allowed by default. To restrict, create a zone `Mesh`, move the transit
network into it, and write Internal ⇄ Mesh policies per VLAN as you would for
any other segment.

**Same-LAN layout**: create one policy, ordered above the built-ins:

| Field | Value |
|---|---|
| Name | `OPNmesh: allow all states to remote sites` |
| Source zone / network | Internal / the LAN(s) that host the VM and users |
| Destination zone | Internal |
| Destination | IP/CIDR list: every remote subnet, the tunnel range, the client range |
| Action | Allow |
| Connection state | **All** (new, established, related **and invalid**) |

Pre-9.0 (classic firewall) equivalent: a *LAN In* rule, "Apply before
predefined rules", action Accept, states all, destination = address group of
the remote subnets.

### 3.4 Roaming clients and inbound protection

OPNmesh's gateways already block sites from opening connections to roaming
clients. If you also want the router to enforce it, add an Internal → Internal
policy: source = LANs, destination = the client range, connection state New,
action Block. It is optional and OPNmesh prints it as "belt and braces".

## 4. Automating UniFi from OPNmesh

### 4.1 Which API

UniFi consoles running Network 9.3+ have an official **Network Integration
API** (`/proxy/network/integration/v1/...`, header `X-API-KEY`). As of the
current documentation it covers sites, devices, clients, networks, WiFi,
vouchers and — in newer builds — firewall zones and policies, but **not static
routes or port forwards**. Those remain on the long-standing **classic API**
(`/proxy/network/api/s/{site}/rest/...`), which the same API key also
authenticates on UniFi OS consoles. OPNmesh therefore uses:

| Object | Endpoint | Notes |
|---|---|---|
| Static routes | `GET/POST/PUT/DELETE /proxy/network/api/s/{site}/rest/routing[/{id}]` | The endpoint every UniFi Terraform/Pulumi provider uses. |
| Networks (to find the transit network id / VLAN) | `GET /proxy/network/api/s/{site}/rest/networkconf` | Read-only. |
| Zone-based firewall policies | `GET/POST/PUT/DELETE /proxy/network/v2/api/site/{site}/firewall-policies[/{id}]` | Network 9.0+. |
| Firewall zones | `GET /proxy/network/v2/api/site/{site}/firewall/zones` | Read-only, to resolve zone ids. |
| Console info | `GET /proxy/network/api/s/{site}/self`, `GET /api/system` | Connectivity test and version detection. |

Static route JSON as the classic API stores it (field names are literal):

```json
{
  "name": "OPNmesh: Datacentre LAN",
  "enabled": true,
  "type": "static-route",
  "static-route_network": "10.0.1.0/24",
  "static-route_type": "nexthop-route",
  "static-route_nexthop": "192.168.250.2",
  "static-route_distance": 1
}
```

### 4.2 Authentication

Two modes, chosen per site:

1. **API key** (recommended). Created on the console at Settings → Control
   Plane → Integrations. Sent as `X-API-KEY`. No cookies, no CSRF token. Works
   on UniFi OS consoles (UDM, UDM Pro/SE, UCG, UXG, UDR, Cloud Key Gen2+ on
   UniFi OS).
2. **Local admin username + password**, for self-hosted Network application
   installs without UniFi OS. `POST /api/auth/login` (UniFi OS) or
   `POST /api/login` (standalone), keep the cookie, send the `X-CSRF-Token`
   header returned at login on every write. Must be a *local* account, not a
   UniFi cloud account, and should be a dedicated one with the minimum role.

Consoles use a self-signed certificate unless the admin installed one. OPNmesh
does **not** turn off certificate checking: on first connect it shows the
console's certificate fingerprint and asks the admin to confirm it; the
fingerprint is pinned for that site from then on.

### 4.3 Reconciliation

OPNmesh treats the routes and policies it created as its own and nothing else
on the console as its business:

1. Compute the desired set for the site from the current topology.
2. `GET` the existing routes; select those whose `_id` is in
   `unifi_links.managed_ids` **or** whose name starts with `OPNmesh:`.
3. Create missing, update differing, delete managed ones no longer desired.
   Record ids.
4. Store status (`in sync` / `changed 3` / error text) and show it on the site
   page; log an event.

Runs when: the site's link is saved, any change alters the site's router
bundle, every 10 minutes, or the admin presses *Sync now*. The port forward is
shown for manual creation and its presence is *checked* (`rest/portforward`),
not created.

### 4.4 Failure handling

The console being unreachable never affects the mesh; it only affects route
sync, which is reported. Every API response is validated before use (Zod), the
sync has a 20 s budget, and nothing is deleted unless the delete target is
positively identified as OPNmesh-managed.

## 5. Other routers

For any router: add the printed static routes (next hop = the VM), the port
forward if applicable, and if the VM shares a LAN with the hosts, allow all
connection states for the remote subnets or (better) use a transit VLAN.
Notes for common platforms:

| Router | Where |
|---|---|
| pfSense / OPNsense | System → Routing → Gateways (add VM as a gateway) then Static Routes. Firewall: allow LAN → remote subnets; the "bypass firewall rules for traffic on the same interface" option addresses the asymmetric case. |
| MikroTik | `/ip route add dst-address=10.0.1.0/24 gateway=192.168.250.2`. |
| OpenWrt | Network → Static Routes; firewall zone forwarding LAN → LAN. |
| Fortigate / Sophos / Draytek / Cisco | Static route with next-hop IP; a policy allowing the routed subnets. |

## 6. Sources consulted

- LazyAdmin, "How to use UniFi Static Routes" (Network 9.2) — menu path and
  fields. https://lazyadmin.nl/home-network/unifi-static-routes/
- Interpipes, "Create a static route or policy based route on Unifi router"
  (Network 10 Policy Table path).
  https://interpip.es/uncategorized/create-a-static-route-or-policy-based-route-on-unifi-router-ucg-udm-uxg-etc/
- Karolis Tamutis, "UniFi Site-to-Site WireGuard Setup" — why policy routes
  are not kernel routes and return traffic vanishes.
  https://tamutis.com/posts/unifi-site2site-wireguard-setup/
- Ubiquiti Help Center, "Zone-Based Firewalls in UniFi" — zones, default
  policies, connection states.
  https://help.ui.com/hc/en-us/articles/115003173168-Zone-Based-Firewalls-in-UniFi
- Ubiquiti developer portal — Network Integration API scope (firewall zones,
  policies; no static routes). https://developer.ui.com/network
- uchkunr/unifi-best-practices — API key header, classic vs integration
  coverage, CSRF handling. https://github.com/uchkunr/unifi-best-practices
- paultyng/go-unifi `routing.generated.go` — exact `rest/routing` field names.
  https://github.com/paultyng/go-unifi
- sirkirby/unifi-network-rules — v2 firewall-policies/trafficroutes endpoints
  in practice. https://github.com/sirkirby/unifi-network-rules
- Ubiquiti community wiki, UniFi controller API — login flow and
  `/proxy/network` prefix. https://ubntwiki.com/products/software/unifi-controller/api
- Tailscale, "Site-to-site networking" — subnet routers, SNAT off, static
  routes on the LAN router, MSS clamp. https://tailscale.com/kb/1214/site-to-site
- NetBird, "Routing traffic to private networks" — masquerade off requires
  return routes. https://docs.netbird.io/how-to/routing-traffic-to-private-networks
