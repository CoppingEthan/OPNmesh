# OPNmesh relay (optional)

A relay is a role a gateway can additionally hold. It runs a reverse proxy that
publishes the control node's agent API and UI on a public address and forwards
requests **over the mesh** to the control node's tunnel IP.

**You only need a relay when the control node sits at a site that cannot expose
its web/API port** — e.g. the control node's site is behind CGNAT. It is *not*
required in the reference topology, where the control node's site has a static
WAN and can forward the API port directly.

The relay never terminates trust: agents still authenticate to the control node
with their per-node tokens, and TLS is still to the control node's certificate.
The relay only moves bytes.

## How it fits

```
agent  --HTTPS-->  relay (public IP, on a capable gateway)  --over wg0-->  control node (10.99.0.x)
```

- The relay gateway already has a mesh tunnel to the control node's site, so it
  can reach the control node's tunnel IP.
- Point enrolment and `agent.json` `server_url` at the relay's public address
  instead of the control node's.

## nginx example

`nginx.conf.example` is a minimal stream/HTTP proxy. Set:

- `RELAY_LISTEN` — the public `host:port` agents dial.
- `CONTROL_UPSTREAM` — the control node's `tunnel-ip:api-port` (e.g.
  `10.99.0.1:8080`).

Run it on the relay gateway (as a container or system nginx). Because the relay
is itself a gateway with the agent installed, its own config still comes from
the control node like any other node.
