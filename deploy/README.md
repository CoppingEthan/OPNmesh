# Deploying OPNmesh

Contents:

- `control-node/` — Docker Compose + Dockerfile for the control VM (UI + agent
  API in one container, plus Prometheus, Alertmanager, Grafana). Copy
  `.env.example` to `.env.local`, set your ports and SMTP, `docker compose up -d`.
- `agent/` — systemd units installed on each gateway by `install.sh`:
  - `opnmesh-agent.service` runs the agent (via the A/B wrapper).
  - `opnmesh-reresolve-dns.{service,timer}` re-resolves DDNS peer endpoints;
    enabled automatically when any peer endpoint is a hostname.
- `install.sh` — the enrolment one-liner target. Generates the keypair locally,
  posts only the public key, and leaves the node pending approval.
- `prometheus/`, `alertmanager/`, `grafana/` — provisioning, verbatim, used by
  both the control-node compose and the simulation.

## Grafana dashboards

`grafana/provisioning/` wires the Prometheus datasource and a file-based
dashboard provider; `grafana/dashboards/mesh-overview.json` is the shipped
at-a-glance dashboard (per-tunnel throughput, handshake age, the site matrix,
drift/errors). Add your own JSON dashboards to that folder — they load on
Grafana start. Grafana holds the deep historical views; the OPNmesh UI shows
the live at-a-glance ones.

## Packet capture (tier 4)

Capture is initiated from the UI (**Traffic → on-demand capture**): choose a
gateway, an optional tcpdump filter, a duration (≤60s) and a size cap (≤10 MiB),
both enforced server-side. The control node queues the job; the agent (which
the control node never dials — it pulls, like everything else) runs a
time-boxed `tcpdump` on `wg0`, uploads the pcap, and the UI offers it for
download. Every capture is written to the audit log.

## TLS

Terminate TLS in front of the control container (a reverse proxy, or your own
certificate mounted into it). Agents pin the control node's certificate at
enrolment; the optional `relay/` only forwards the encrypted stream and never
terminates trust.
