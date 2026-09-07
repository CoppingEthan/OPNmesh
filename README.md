# OPNmesh

Open-source site-to-site networking on WireGuard for small multi-site
organisations. One Ubuntu VM per site, one controller anywhere, and every
machine at every site can reach every other by its real address, no VPN
software on the machines themselves. Home workers join with a QR code. A live
dashboard shows the traffic between sites. Built to sit beside UniFi routers
(and any other router that can add a static route), and to push those routes
into UniFi for you.

```
   Office 192.168.20.0/24  ◄══ WireGuard ══►  Datacentre 10.0.1.0/24
          ▲                                          ▲
   UniFi router → gateway VM               UniFi router → gateway VM
          ▲
   laptop at home (WireGuard app, QR code)
```

## How it works, in one paragraph

Each site gets a small Ubuntu VM running the OPNmesh gateway agent. The
controller (one Docker container) generates the WireGuard and firewall
configuration for every gateway from the list of sites, networks and clients
you enter, and the agents keep their VM equal to it. The site router sends
traffic for the other sites to the gateway VM (a few static routes; OPNmesh
prints them and can create them on UniFi). The controller is never in the
data path: switch it off and the tunnels keep running.

Full design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Router details and
the UniFi specifics: [docs/ROUTERS.md](docs/ROUTERS.md).

## Install

**Controller** (any Ubuntu 22.04/24.04 host with a public address or a
forwarded port; the datacentre is a good place):

```bash
curl -fsSL https://raw.githubusercontent.com/CoppingEthan/OPNmesh/main/deploy/controller/install.sh | sudo bash -s -- --domain mesh.example.com
```

With `--domain`, Caddy obtains Let's Encrypt certificates (ports 80 and 443
must be reachable from the internet). Omit it to use a private certificate
authority instead: the controller is then reached by its IP address (or pass
`--url https://mesh.lan` for a private name), and every gateway install
command carries the CA fingerprint so the installer verifies what it
downloads before trusting it. The script prints the URL and a one-time setup
code; open the URL, enter the code, and create the admin account.

**Gateways**: in the UI, add a site, then click *Generate install command*
and paste it into an Ubuntu VM at that site:

```bash
curl -fsSL https://mesh.example.com/install.sh | sudo bash -s -- --token <one-time-token>
```

Within a minute the site shows online and its *Router setup* page lists the
routes to add (or connect the site to its UniFi console and let OPNmesh add
them).

**Clients**: add a client, then scan the QR code, download the `.conf`, or
send the person a one-time link.

## Running it

- **Where things live**: `/opt/opnmesh` holds `docker-compose.yml`, the
  `Caddyfile`, `.env` (site name, public URL, ports, TLS mode) and two
  directories: `data` (the SQLite database and `secret.key`, owned by uid
  1000, the unprivileged user the image runs as) and `caddy` (certificates).
- **Upgrades**: `cd /opt/opnmesh && docker compose pull && docker compose up -d`.
  Gateways are upgraded by re-running their install command; the binary comes
  from the controller and is checked against its SHA-256.
- **Backups**: back up `data` as a whole. `secret.key` encrypts the client
  private keys stored in the database, so neither file is useful without the
  other. *Settings → Download database backup* gives a consistent copy while
  the controller runs (copying the file by hand can miss recent writes); keep
  it with a copy of `secret.key`.
- **Public address**: install commands, invite links and alert emails use
  `OPNMESH_PUBLIC_URL` from `.env`; *Settings → Public URL* overrides it
  without a restart, for instance when the controller gains a proper name.
- **Lost admin password**: there is one admin account and no reset email.
  Remove it and run first-run setup again with the setup code the controller
  keeps in its data directory:

  ```bash
  cd /opt/opnmesh
  docker compose exec controller node -e "require('better-sqlite3')('/data/opnmesh.db').exec('DELETE FROM users')"
  sudo cat data/setup-code      # then open https://<controller>/setup
  ```

- **Logs**: `docker compose logs -f controller` on the controller;
  `journalctl -u opnmesh-gw -f` on a gateway. Every change and every gateway
  event is also in the *Events* page.

## What you get

- **Any-to-any routing between sites** with real source addresses, full mesh
  where sites can accept connections and hub relay where they cannot.
- **Roaming clients** with per-client keys, optional site restrictions,
  expiry and one-time invite links.
- **Live dashboard**: a map of sites and tunnels with the current rate
  written on every line, a per-site traffic graph (live last 60 seconds, or
  1 hour to 1 year of history), a site-to-site traffic matrix, per-tunnel
  latency and handshake state, client presence, and an audit log.
- **Email alerts** when a site's gateway stops responding (and when it is
  back), with a per-site switch and a test button.
- **Health checks** on every site: one click runs tests on the controller
  and on the gateway itself, including a probe that proves whether the site
  router really sends each remote network to the gateway, and says what to fix.
- **UniFi automation**: static routes (and the firewall policy the same-LAN
  layout needs) created and kept in sync on the console through its API,
  with certificate pinning.
- **Three router layouts** per site: transit VLAN (recommended), same LAN,
  or no router changes at all (masquerade).
- **Safety**: gateways hold their last good configuration when the
  controller is unreachable, roll back on the spot if a change fails to come
  up, refuse anything that would run commands, come up from disk at boot,
  and re-resolve dynamic DNS endpoints so a site whose public address changes
  rejoins on its own.

## Development

```bash
npm install
npm run dev              # http://localhost:3000 (setup code is printed in the terminal)
npm test                 # unit + API tests
npm run typecheck
npm run lint
npm run agent:test       # Go agent tests (in Docker)
npm run agent:build      # agent binaries into agent/bin
npm run ui:test          # production build + page smoke test
npm run sim:up           # four-site Ubuntu simulation with real routers (Docker)
npm run sim:test         # the integration suite against it
npm run sim:down
```

Requires Node 22 and Docker (Docker Desktop is fine: its kernel has
WireGuard). Everything is tested on Ubuntu, in containers locally and on
GitHub's runners in CI, including a deployment smoke test that runs the real
controller installer. See [docs/TESTING.md](docs/TESTING.md).

## Repository map

| Path | What |
|---|---|
| `src/core/` | Pure TypeScript: IP maths, topology, WireGuard/nftables/router generators, validators, crypto |
| `src/server/` | Controller runtime: SQLite repositories, auth, telemetry, live state, UniFi integration |
| `app/` | Next.js pages and API route handlers |
| `src/ui/` | React components, the live map, charts |
| `agent/` | The Go gateway agent (`opnmesh-gw`) |
| `deploy/` | Controller installer + compose + Caddyfile; gateway installer |
| `scripts/` | Agent build and tests in Docker, simulation driver, UI and deployment smoke tests |
| `sim/` | The four-site Docker simulation and its integration suite |
| `docs/` | Architecture, routers/UniFi, testing, prior art |

## License

MIT. The dashboard wallpaper is a gradient photograph from
[Unsplash](https://unsplash.com/photos/rcVkESi_JTQ), used under the Unsplash
License.
