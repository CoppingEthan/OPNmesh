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
   private IPv4 address of the controller host and a port, such as
   `10.0.0.5:3000`. Never use `0.0.0.0`, and do not publish the port on IPv6.
2. **Firewall the port to the proxy's addresses.** A port published by Docker
   bypasses the host's INPUT chain, so `ufw` and ordinary `nftables` input
   rules do not protect it. `opnmesh-backend-firewall` puts its rules in
   Docker's `DOCKER-USER` chain instead. Two systemd units apply them: one
   at boot before Docker starts, so the port is never open, and one that
   re-applies and checks them whenever Docker starts. They drop new connections from anyone not listed
   in `backend-allow`, whether the connection is for the published address
   or routed straight to the container's own address. Docker releases before
   28 let hosts on the same network segment do the latter; the firewall
   catches that by matching the controller's network bridge, which the
   compose file names `opnmesh-br`.

The firewall matters because the controller trusts `X-Forwarded-For` from its
proxy (see §2). If anything else can reach the port, it can claim to be any
client address.

To set it up by hand (take the files from the release you run; its
`controller-files.sha256` lists their SHA-256, and its notes give the image
by digest for `OPNMESH_IMAGE`):

```bash
sudo mkdir -p /opt/opnmesh/data
sudo chown 1000:1000 /opt/opnmesh/data && sudo chmod 700 /opt/opnmesh/data
cd /opt/opnmesh
# copy docker-compose.yml, .env.example (as .env) and backend-allow.example
# (as backend-allow) from deploy/controller/external-proxy/, then edit both
sudo install -m 0755 opnmesh-backend-firewall /usr/local/sbin/
sudo install -m 0644 opnmesh-backend-firewall.service opnmesh-backend-firewall-early.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable opnmesh-backend-firewall-early
sudo docker compose up -d
sudo systemctl enable --now opnmesh-backend-firewall
sudo docker compose logs controller | grep "setup code"
```

After changing `backend-allow`, run
`sudo systemctl restart opnmesh-backend-firewall`.

To confirm the lock works:
- `systemctl status opnmesh-backend-firewall` is active, and its log names
  the allowed sources;
- from the proxy, `curl http://<backend>/api/admin/setup` must answer;
- from any other machine, the same request must time out.

### How the firewall behaves

- **It fails closed.** It checks all of `backend-allow` before it changes
  anything, then replaces the allow-list in one step. If a line is wrong, or
  the file is missing or lists no sources, it closes the backend to everyone,
  logs why, and the unit fails. Fix the file and restart the unit.
- **One IPv4 address or network per line.** `#` starts a comment anywhere on
  a line, and Windows line endings are fine. IPv6 addresses, host names,
  ports and networks with host bits set (`10.0.0.2/24`) are refused, with the
  line number.
- **`BACKEND=` must match `OPNMESH_BACKEND_BIND` in `.env`.** Without a
  `BACKEND=` line the firewall uses the `.env` value. If the two differ, it
  closes both.
- **It checks what Docker really publishes.** A port published on IPv6 is
  an error: this firewall filters IPv4 only, so it closes the IPv4 backend
  and the unit fails until `OPNMESH_BACKEND_BIND` names one private IPv4
  address. So is a port published on `0.0.0.0` while the `opnmesh-br`
  bridge is missing, since nothing would then filter the other addresses.
  With the bridge, `0.0.0.0` only draws a warning: the bridge rule filters
  it. A published address the files do not name is filtered as well.
- **It runs after the host's own firewall at boot.** The early unit is
  ordered after `netfilter-persistent`, `nftables`, `firewalld` and
  `iptables` (whichever exist; it does not start them), because loading a
  saved rule set can flush its rules.
- **It refuses to run with Docker's nftables firewall backend** (Docker 29
  and later with `"firewall-backend": "nftables"`), because that backend
  ignores `DOCKER-USER`. Keep Docker's default iptables backend, or write
  equivalent rules in an nftables table of your own.
- **A network created before the `opnmesh-br` name** gets it the next time
  `docker compose up -d` runs with the current compose file. Until then the
  firewall warns and filters only the published address.

### The controller container

The compose file runs the controller with a read-only root filesystem, no
Linux capabilities, no way to gain privileges, a 1 GiB memory limit and a
process limit, under a minimal init that passes `docker stop`'s signal on
and reaps stray processes. It writes only to `./data` and to small in-memory
mounts for `/tmp` and the Next.js cache. Temporary files, such as the copy of the
database a backup makes, go to `./data`. The standard layout runs Caddy the
same way, keeping only the capability to bind ports 80 and 443.

`./data` holds the database and `secret.key`. It must belong to uid 1000,
which the image runs as, with mode 700. On the host that uid is often the
first login account, which can therefore read the controller's secrets.

## 2. What the proxy must do

| Requirement | Why |
|---|---|
| Serve `OPNMESH_PUBLIC_URL` over HTTPS with a certificate browsers trust | Gateways verify it with the system's trusted CAs, so install commands need no CA fingerprint. |
| Forward to `http://<OPNMESH_BACKEND_BIND>/` | The backend is plain HTTP. Do not enable "HTTPS to backend". |
| Keep the original `Host` header, or set `X-Forwarded-Host` to the public name | The controller compares it with the browser's `Origin`. If they differ, every change in the UI fails with "cross-origin request refused". |
| Set `X-Forwarded-For` to the visitor's address, and set `OPNMESH_TRUST_PROXY` to the number of proxies in front (normally `1`) | Login throttling and the audit log use the client address. The controller takes it that many entries from the right, where a visitor cannot forge it. Better still, have the proxy drop any `X-Forwarded-For` the visitor sent. |
| Stream responses: no buffering, and an idle timeout of at least several minutes, for `/api/admin/live` | The live dashboard is a server-sent event stream that sends an event every second while open. |
| Pass the `Authorization` header through unchanged | Gateways authenticate with a bearer token. |
| Pass request bodies up to 1 MiB (capping them there is fine), and cache nothing under `/api/` | The controller refuses bodies over 1 MiB itself, and its API responses are live and per user. |
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
