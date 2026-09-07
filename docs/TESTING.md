# Testing — everything runs on Ubuntu

The rule for this repository: a change is not done until its tests have run
on Ubuntu. Locally that means inside Ubuntu 24.04 containers under Docker
(Docker Desktop's WSL2 kernel ships WireGuard, so kernel WireGuard works in
containers exactly as on a real VM); in CI it means GitHub's Ubuntu runners.

## Layers

| Layer | Command | Runs where | Time |
|---|---|---|---|
| Typecheck and lint | `npm run typecheck && npm run lint` | host | seconds |
| Unit (core, server logic) | `npm test` | Node 22 on Ubuntu (`npm run test:ubuntu` wraps it in a container) | seconds |
| API route handlers | part of `npm test` | same | seconds |
| Go agent | `npm run agent:test` | `golang` container | seconds |
| Production build + UI smoke | `npm run ui:test` | host or container | ~2 min |
| Simulation | `npm run sim:up && npm run sim:test` | Docker compose, Ubuntu 24.04 images | ~5–10 min |
| Deployment smoke | `deploy/controller/install.sh` + `scripts/deploy-smoke.mjs` | CI (a Linux host with Docker) | ~5 min |

`npm run check` runs typecheck, lint, unit and Go; `npm run check:full` adds
the production build, the UI smoke test and the simulation. CI runs all of
that plus the deployment smoke test, which needs a Linux host where it can
bind ports and run the real installer.

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

One thing the simulation deliberately does not reproduce: the controller
runs as root there so it can set its default route. The production image
runs unprivileged; the deployment smoke test below covers that.

`sim/test/mesh.test.ts` drives the controller's admin API exactly as the UI does:

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
11. Health checks still pass with the client connected (its /32 route must
    not capture the router probe for the client range).

The UniFi integration is covered by the unit suite against
`test/server/fake-unifi.ts`, a small http server implementing the subset of
classic and v2 endpoints OPNmesh uses: link a site, assert the routes created,
change the topology, assert reconciliation, delete a LAN, assert the managed
route is removed and an unmanaged one left alone. Certificate pinning against
a real console has not been exercised automatically.

## The deployment smoke test

The simulation reaches the controller over plain HTTP as root. The production
path is different in three ways that have each hidden a bug: Caddy terminates
TLS with a private CA whose root the controller must be able to read; the
controller runs as the image's unprivileged user against a bind-mounted data
directory; and the gateway installer downloads the agent over that TLS. CI
therefore builds the image, runs the real `deploy/controller/install.sh`
against it on the runner (with `OPNMESH_RAW_BASE` pointed at the checkout so
the compose file and Caddyfile come from the branch under test), and then
`scripts/deploy-smoke.mjs` checks the first-install flow end to end: the CA
root appears where the compose file expects it, `/api/admin/setup` answers
over TLS signed by that CA, `/ca.crt` serves the same root, the controller
process is uid 1000, first-run setup works with the persisted code, the
install command carries the CA fingerprint, and the agent checksum downloads
over TLS. It runs against any deployment made by the installer:

```bash
sudo -E node scripts/deploy-smoke.mjs --dir /opt/opnmesh --url https://<host>
```

## Conventions

- Tests never need real keys or real networks; the sim generates everything.
- Golden files in `test/golden/` change only via `npm run goldens:update`
  followed by a reviewed diff.
- A generator or validator change without a test is rejected in review.
- Never pipe a test runner through `tail` or `head` when its exit code
  matters: the pipe returns the pager's status and buffers the output.
