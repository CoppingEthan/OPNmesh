# Running the controller behind your own reverse proxy

The controller container serves plain HTTP on port 3000. The standard
installer puts Caddy in front of it. You can use your own reverse proxy
instead: nginx, HAProxy, Traefik, a cloud load balancer or a web application
firewall. This page covers what that proxy must do, which paths gateways need
so you can protect the dashboard without cutting them off, and how to keep
the backend port private.

The layout for this lives in
[`deploy/controller/external-proxy/`](../deploy/controller/external-proxy/).

## 1. Keep the backend private

The proxy talks to the controller over plain HTTP, so only the proxy may reach
that port.

1. **Bind the port to a private address.** Set `OPNMESH_BACKEND_BIND` to a
   private address of the controller host and a port, such as
   `10.0.0.5:3000`. Never use `0.0.0.0`.
2. **Firewall the port to the proxy's addresses.** A port published by Docker
   bypasses the host's INPUT chain, so `ufw` and ordinary `nftables` input
   rules do not protect it. `opnmesh-backend-firewall` puts the rule in
   Docker's `DOCKER-USER` chain instead. It matches the original destination
   and drops new connections from anyone not listed in `backend-allow`, and a
   systemd unit re-applies it whenever Docker starts.

The firewall matters because the controller trusts `X-Forwarded-For` from its
proxy (see §2). If anything else can reach the port, it can claim to be any
client address.

To set it up by hand:

```bash
sudo mkdir -p /opt/opnmesh/data && sudo chown 1000:1000 /opt/opnmesh/data
cd /opt/opnmesh
# copy docker-compose.yml, .env.example (as .env) and backend-allow.example
# (as backend-allow) from deploy/controller/external-proxy/, then edit both
sudo install -m 0755 opnmesh-backend-firewall /usr/local/sbin/
sudo install -m 0644 opnmesh-backend-firewall.service /etc/systemd/system/
sudo docker compose up -d
sudo systemctl daemon-reload
sudo systemctl enable --now opnmesh-backend-firewall
sudo docker compose logs controller | grep "setup code"
```

To confirm the lock works:
- from the proxy, `curl http://<backend>/api/admin/setup` must answer;
- from any other machine, the same request must time out.

## 2. What the proxy must do

| Requirement | Why |
|---|---|
| Serve `OPNMESH_PUBLIC_URL` over HTTPS with a certificate browsers trust | Gateways verify it with the system's trusted CAs, so install commands need no CA fingerprint. |
| Forward to `http://<OPNMESH_BACKEND_BIND>/` | The backend is plain HTTP. Do not enable "HTTPS to backend". |
| Keep the original `Host` header, or set `X-Forwarded-Host` to the public name | The controller compares it with the browser's `Origin`. If they differ, every change in the UI fails with "cross-origin request refused". |
| Set `X-Forwarded-For` to the visitor's address, and set `OPNMESH_TRUST_PROXY` to the number of proxies in front (normally `1`) | Login throttling and the audit log use the client address. The controller takes it that many entries from the right, where a visitor cannot forge it. Better still, have the proxy drop any `X-Forwarded-For` the visitor sent. |
| Stream responses: no buffering, and an idle timeout of at least several minutes, for `/api/admin/live` | The live dashboard is a server-sent event stream that sends an event every second while open. |
| Pass the `Authorization` header through unchanged | Gateways authenticate with a bearer token. |
| Allow request bodies of at least 1 MB, and cache nothing under `/api/` | These are the controller's own limits and responses. |
| Redirect HTTP to HTTPS and send `Strict-Transport-Security` | The session cookie is HTTPS-only. |
| Health check `GET /api/admin/setup` (always 200) | The site root redirects to the login page. |

## 3. Who uses which paths

| Path | Used by | Protected by | Expose to |
|---|---|---|---|
| `/api/agent/telemetry`, `/api/agent/config`, `/api/agent/diagnostics` | gateways, every few seconds | the gateway's own bearer token | **the gateways** |
| `/api/agent/enrol` | the gateway installer | a one-time token (valid 30 minutes); 20 attempts per 15 minutes per client | **the gateways** |
| `/install.sh`, `/dl/…` | gateway installs and agent upgrades | nothing (public by design; the installer and agent are checksummed) | **the gateways** |
| `/invite/…`, `/api/invite/…`, plus `/_next/static/…`, `/icon.svg`, `/wallpaper.webp` | people collecting a client configuration from a one-time link | a one-time token; 60 requests per 15 minutes per client | **anywhere**, if you use invite links |
| `/ca.crt` | only the bundled Caddy private CA | nothing | not needed (answers 404 behind your own proxy) |
| everything else: `/`, the dashboard pages, `/login`, `/setup`, `/api/admin/…`, `/_next/…` | administrators | an admin session; first-run setup also needs the setup code | **administrators only** |

The controller is never in the data path. A gateway that cannot reach it keeps
its tunnels running, but it stops reporting, cannot pick up changes, and
raises a "not responding" alert after about a minute.

## 4. A recommended rule set

1. **Allow `/api/agent/`, `/install.sh` and `/dl/` from any address.** Each
   request is already authenticated or public by design, and this avoids two
   traps:
   - A gateway at the proxy's own site often reaches the proxy through the
     router's hairpin NAT, and then appears as the router's inside address
     rather than the site's public one.
   - A site whose ISP address changes would stop reporting until someone
     updated the list.

   If you do restrict these paths, list every site's public address and
   check the proxy's log for the address each gateway actually arrives from.
2. **If you send invite links,** allow `/invite/`, `/api/invite/`,
   `/_next/static/`, `/icon.svg` and `/wallpaper.webp` from any address.
3. **Allow everything else only from your administrators' addresses.**
4. **Optionally, rate-limit `/api/admin/login` and `/api/admin/setup` at the
   edge as well.** The controller already throttles failed sign-ins per client
   and globally, but an edge limit keeps the noise away from it.

## 5. Check it

- **Through the proxy,** `https://<name>/api/admin/setup` answers 200 with a
  trusted certificate.
- **From a gateway,**
  `curl -sS -X POST https://<name>/api/agent/telemetry` answers **401**
  `invalid gateway token`. That means the path is open to it; a 403 from the
  proxy means it is blocked.
- **From an address that is not an administrator's,** `https://<name>/` is
  refused by the proxy.
- **Signing in and changing a setting works.** If you see "cross-origin
  request refused", fix the `Host` / `X-Forwarded-Host` handling.
- **Forged addresses are ignored.** Send a sign-in with a wrong password and
  the header `X-Forwarded-For: 203.0.113.99`. The Events page must show your
  real address, not the forged one.
- **The live stream holds up.** The overview updates every second and stays
  live for more than five minutes.
- **The backend port is closed.** Connecting to it from anywhere except the
  proxy times out.
