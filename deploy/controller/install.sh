#!/bin/sh
# OPNmesh controller installer for Ubuntu 22.04 / 24.04 (Debian 12 works too).
#
#   curl -fsSL https://raw.githubusercontent.com/CoppingEthan/OPNmesh/main/deploy/controller/install.sh | sudo bash -s -- --domain mesh.example.com
#
# Installs Docker if missing, creates /opt/opnmesh with a compose file, a
# Caddyfile and a .env, starts everything, and prints the URL and the
# first-run setup code. Re-running is safe: existing files are kept.
#
# Flags / env:
#   --dir <path>        install directory (default /opt/opnmesh)
#   --domain <name>     public DNS name; Caddy obtains Let's Encrypt certificates
#                       (ports 80 and 443 must be reachable from the internet)
#   --url <url>         public URL when there is no public domain, e.g.
#                       https://203.0.113.5 or https://mesh.lan (default: this
#                       host's address); Caddy then issues certificates from a
#                       private CA that gateways pin at install time
#   --image <ref>       controller image (default ghcr.io/coppingethan/opnmesh:latest)
#   --http-port <n>     host port for Caddy's HTTP listener (default 80)
#   --https-port <n>    host port for Caddy's HTTPS listener (default 443)
#   --no-start          write files but do not start
set -eu

DIR=/opt/opnmesh
DOMAIN="${OPNMESH_DOMAIN:-}"
URL="${OPNMESH_PUBLIC_URL:-}"
IMAGE="${OPNMESH_IMAGE:-ghcr.io/coppingethan/opnmesh:latest}"
HTTP_PORT="${OPNMESH_HTTP_PORT:-80}"
HTTPS_PORT="${OPNMESH_HTTPS_PORT:-443}"
RAW="${OPNMESH_RAW_BASE:-https://raw.githubusercontent.com/CoppingEthan/OPNmesh/main/deploy/controller}"
START=1
# The image runs as this unprivileged user; the data directory must be its.
DATA_UID=1000

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --http-port) HTTP_PORT="$2"; shift 2 ;;
    --https-port) HTTPS_PORT="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "run as root (sudo)" >&2; exit 2; }
log() { printf '\033[1;32m[opnmesh]\033[0m %s\n' "$*"; }

# Read one value out of .env without executing the file. Sourcing it would run
# any value that contains a space (OPNMESH_TLS="tls internal") as a command,
# and .env is read back here both after writing it and when this script is
# re-run against an install that already has one.
env_value() {
  { sed -n "s/^$1=//p" .env 2>/dev/null || true; } | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# Docker -------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin missing; install docker-compose-plugin" >&2; exit 1; }

# Files ----------------------------------------------------------------------
mkdir -p "$DIR/data" "$DIR/caddy"
# The controller runs unprivileged inside its container and must own its data
# (SQLite, secret.key, the setup code). A root-owned directory would leave it
# unable to start.
chown "$DATA_UID:$DATA_UID" "$DIR/data"
chmod 0700 "$DIR/data"
cd "$DIR"
for f in docker-compose.yml Caddyfile; do
  if [ ! -f "$f" ]; then
    curl -fsSL "$RAW/$f" -o "$f"
    log "wrote $DIR/$f"
  fi
done

if [ ! -f .env ]; then
  if [ -z "$URL" ]; then
    if [ -n "$DOMAIN" ]; then
      URL="https://$DOMAIN"
    else
      IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1)"
      URL="https://${IP:-$(hostname -I | awk '{print $1}')}"
      log "no domain given; using $URL with a private CA (gateways pin it at install)"
    fi
  fi
  SITE="${DOMAIN:-$(printf '%s' "$URL" | sed -E 's#^https?://##; s#[:/].*$##')}"
  # Caddy chooses its own CA for IP addresses by itself, but not for private
  # names such as mesh.lan; say so explicitly whenever there is no public domain.
  TLS=""
  [ -n "$DOMAIN" ] || TLS="tls internal"
  {
    echo "OPNMESH_SITE=$SITE"
    echo "OPNMESH_PUBLIC_URL=$URL"
    # Quoted because the value contains a space. Compose strips the quotes;
    # without them any shell reading this file would try to run "internal".
    echo "OPNMESH_TLS=\"$TLS\""
    echo "OPNMESH_HTTP_PORT=$HTTP_PORT"
    echo "OPNMESH_HTTPS_PORT=$HTTPS_PORT"
    echo "OPNMESH_IMAGE=$IMAGE"
  } > .env
  chmod 0600 .env
  log "wrote $DIR/.env"
fi

# Start ----------------------------------------------------------------------
if [ "$START" = "1" ]; then
  log "starting OPNmesh"
  docker compose pull -q --ignore-pull-failures
  docker compose up -d
  PUBLIC_URL="$(env_value OPNMESH_PUBLIC_URL)"
  TLS_MODE="$(env_value OPNMESH_TLS)"
  # The controller writes its setup code, and Caddy its CA root, within seconds.
  CA=caddy/caddy/pki/authorities/local/root.crt
  ready() {
    [ -f data/setup-code ] || return 1
    if [ -n "$TLS_MODE" ]; then [ -f "$CA" ] || return 1; fi
    return 0
  }
  n=0
  while [ $n -lt 30 ] && ! ready; do sleep 1; n=$((n + 1)); done
  echo
  log "OPNmesh is starting at $PUBLIC_URL"
  log "first-run setup code (also in: docker compose logs controller):"
  if [ -f data/setup-code ]; then
    log "  $(cat data/setup-code)"
  else
    docker compose logs controller 2>/dev/null | grep -o 'setup code:  [A-Z0-9]*' | tail -1 || true
  fi
  if [ -f "$CA" ]; then
    log "private CA fingerprint (the UI puts it in every gateway install command):"
    log "  $(sha256sum "$CA" | cut -d' ' -f1)"
  fi
  echo
  log "next: open the URL above, enter the setup code, add your first site."
else
  log "files written to $DIR; start with: cd $DIR && docker compose up -d"
fi
