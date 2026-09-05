# Testing — everything runs on Ubuntu

The rule for this repository: a change is not done until its tests have run
on Ubuntu. Locally that means inside Ubuntu 24.04 containers under Docker
(Docker Desktop's WSL2 kernel ships WireGuard, so kernel WireGuard works in
containers exactly as on a real VM); in CI it means GitHub's Ubuntu runners.

## Layers

| Layer | Command | Runs where | Time |
|---|---|---|---|
| Unit (core, server logic) | `npm test` | Node 22 on Ubuntu (`npm run test:ubuntu` wraps it in a container) | seconds |
| API route handlers | part of `npm test` | same | seconds |
| Go agent | `npm run agent:test` | `golang` container | seconds |
| Build (typecheck + next build + agent binaries) | `npm run build:all` | container | ~2 min |
| Simulation | `npm run sim:up && npm run sim:test` | Docker compose, Ubuntu 24.04 images | ~5–10 min |
| UI smoke | `npm run ui:test` | container | ~1 min |

`npm run check` runs unit + Go + typecheck; `npm run check:full` adds build,
UI smoke and the simulation. CI runs `check:full`.

## The simulation

`sim/docker-compose.yml` builds a realistic four-site network from Ubuntu
24.04 images:

```
wan 198.51.100.0/24 ─┬─ router-a (198.51.100.10)  ── lan-a 10.0.1.0/24 ── host-a (10.0.1.20), controller (10.0.1.10)
                     │      └─ transit-a 10.0.250.0/29 ── gw-a (10.0.250.2)   [layout: transit, reachable]
                     │      └─ port-forward udp/51820 → gw-a ; tcp/3000 → controller (hairpin NAT too)
                     ├─ router-b (198.51.100.20)  ── lan-b 192.168.20.0/24 ── host-b, gw-b (192.168.20.2)  [layout: same-lan, reachable]
                     │      └─ UniFi-like nftables: accept est/rel, drop invalid, LAN→any accept; no ICMP redirects
                     │      └─ port-forward udp/51820 → gw-b
                     ├─ router-c (198.51.100.30)  ── lan-c 10.30.0.0/24 ── host-c, gw-c (10.30.0.2)  [layout: masquerade, outbound-only]
                     │      └─ masquerade to WAN, NO port forward, NO static routes
                     ├─ router-d (198.51.100.40)  ── lan-d 10.40.0.0/24 ── host-d
                     │      └─ transit-d 10.40.250.0/29 ── gw-d (10.40.250.2)  [layout: transit, outbound-only → C↔D relay through A]
                     └─ client (198.51.100.100)   roaming WireGuard client
```

Routers are plain Ubuntu containers with `ip_forward=1`, nftables and static
routes — the same kernel behaviour a UniFi gateway exhibits (Linux, conntrack).
LAN hosts also run a background traffic generator (`sim/entrypoints/traffic.sh`):
slow sine-wave swings over a few minutes with jitter and bursts, sent as
rate-limited iperf3 flows to ports 5202/5203, so the dashboard shows realistic
movement; the suite keeps port 5201 for its own measurements.
Gateways run the real `opnmesh-gw` binary; the container entrypoint mirrors
`opnmesh-wg.service` then execs the agent. The controller is the real image
with `OPNMESH_INSECURE_HTTP=1`. Hosts ignore ICMP redirects and routers never
send them, so the same-LAN layout is tested in its worst case.

Two Docker details matter and are set in the compose file: `/proc/sys` is
read-only inside containers, so every sysctl is declared per service; and
Docker's own per-network MASQUERADE rule (applied to bridged frames because
`bridge-nf-call-iptables` is on) rewrites packets a router has just DNAT-ed,
so IP masquerade is disabled on every simulation network.

`sim/test/*.test.ts` drives the controller's admin API exactly as the UI does:

1. Setup admin, create sites/LANs with their layouts, create enrolment tokens.
2. Start gateways with those tokens; wait for `active`.
3. Assert connectivity: `host-a ↔ host-b` ping and iperf3 (TCP), `host-a ↔
   host-c`, `host-b ↔ host-c` (transits gw-a), client → every host; that the
   source address seen at host-b from host-a is `10.0.1.20` (no NAT), and at
   host-c is `10.30.0.2` (masquerade layout).
4. Run the health checks at every site through the API and assert nothing
   fails (router probes pass at A, B and D; skipped at C, the masquerade site);
   then delete one static route on router-b and assert the office gateway's
   router probe names exactly that network; restore it and assert it passes.
5. Assert the same-LAN trap: remove the all-states policy on router-b and show
   TCP from host-b fails while ping succeeds; restore and show it works. (This
   test documents the behaviour rather than merely believing it.)
6. Kill the controller; everything above still passes. Restart it.
7. Restart gw-a; b↔c transit is interrupted and recovers; a↔b recovers.
8. Change a LAN in the admin API; both gateways report the new version within
   15 s; new subnet is reachable.
9. Subscribe to `/api/admin/live` and assert throughput for a↔b is non-zero
   while an iperf3 run is in progress, and the pair counters increase.
10. Client lifecycle: create, fetch config via one-time invite, bring up in the
   client container, reach every site; disable → handshakes stop; site
   restriction → only allowed site reachable.
11. UniFi integration against `sim/fake-unifi` (a small Node server
    implementing the subset of classic + v2 endpoints): link a site, assert the
    routes created, change topology, assert reconciliation, delete a LAN,
    assert the managed route is removed and an unmanaged one untouched.

## Conventions

- Tests never need real keys or real networks; the sim generates everything.
- Golden files in `test/golden/` change only via `npm run goldens:update`
  followed by a reviewed diff.
- A generator or validator change without a test is rejected in review.
