#!/bin/sh
# OPNmesh controller installer for Ubuntu 22.04 / 24.04 (Debian 12 works too).
#
#   curl -fsSL https://raw.githubusercontent.com/CoppingEthan/OPNmesh/main/deploy/controller/install.sh | sudo bash
#
# Installs Docker if missing, creates /opt/opnmesh with a compose file, a
# Caddyfile and a .env, starts everything, and prints the URL and the
# first-run setup code. Re-running is safe: existing files are kept.
#
# Flags / env:
#   --dir <path>        install directory (default /opt/opnmesh)
#   --domain <name>     public DNS name for automatic Let's Encrypt certificates
#   --url <url>         public URL if not derived from the domain (e.g. https://203.0.113.5)
#   --image <ref>       controller image (default ghcr.io/coppingethan/opnmesh:latest)
#   --no-start          write files but do not start
set -eu

DIR=/opt/opnmesh
DOMAIN="${OPNMESH_DOMAIN:-}"
URL="${OPNMESH_PUBLIC_URL:-}"
IMAGE="${OPNMESH_IMAGE:-ghcr.io/coppingethan/opnmesh:latest}"
RAW="${OPNMESH_RAW_BASE:-https://raw.githubusercontent.com/CoppingEthan/OPNmesh/main/deploy/controller}"
START=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "run as root (sudo)" >&2; exit 2; }
log() { printf '\033[1;32m[opnmesh]\033[0m %s\n' "$*"; }

# Docker -------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin missing; install docker-compose-plugin" >&2; exit 1; }

# Files ----------------------------------------------------------------------
mkdir -p "$DIR/data" "$DIR/caddy"
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
  {
    echo "OPNMESH_SITE=$SITE"
    echo "OPNMESH_PUBLIC_URL=$URL"
    echo "OPNMESH_HTTP_PORT=80"
    echo "OPNMESH_HTTPS_PORT=443"
    echo "OPNMESH_IMAGE=$IMAGE"
  } > .env
  chmod 0600 .env
  log "wrote $DIR/.env"
fi

# Start ----------------------------------------------------------------------
if [ "$START" = "1" ]; then
  log "starting OPNmesh"
  docker compose pull -q
  docker compose up -d
  sleep 4
  . ./.env
  echo
  log "OPNmesh is starting at ${OPNMESH_PUBLIC_URL}"
  log "first-run setup code (also in: docker compose logs controller):"
  docker compose logs controller 2>/dev/null | grep -o 'setup code:  [A-Z0-9]*' | tail -1 || true
  [ -f data/setup-code ] && log "  $(cat data/setup-code)" || true
  if [ -f caddy/pki/authorities/local/root.crt ]; then
    log "private CA fingerprint (shown in the UI next to install commands):"
    sha256sum caddy/pki/authorities/local/root.crt | cut -d' ' -f1
  fi
  echo
  log "next: open the URL above, enter the setup code, add your first site."
else
  log "files written to $DIR; start with: cd $DIR && docker compose up -d"
fi
