#!/bin/sh
# OPNmesh controller installer for Ubuntu 22.04 / 24.04 (Debian 12 works too).
#
#   curl -fsSL https://raw.githubusercontent.com/CoppingEthan/OPNmesh/main/deploy/controller/install.sh | sudo bash -s -- --domain mesh.example.com
#
# Installs Docker if missing (from Docker's apt repository, its signing key
# checked against a pinned fingerprint), creates /opt/opnmesh with a compose
# file, a Caddyfile and a .env, starts everything, and prints the URL and the
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
#   --version <x.y.z>   release to install (default: the one this installer
#                       belongs to, see RELEASE below)
#   --image <ref>       controller image (default: the release's image, pinned
#                       by digest when the release is this installer's own)
#   --http-port <n>     host port for Caddy's HTTP listener (default 80)
#   --https-port <n>    host port for Caddy's HTTPS listener (default 443)
#   --no-start          write files but do not start
#
# Everything runs from main(), called on the last line, so a download cut
# short runs nothing at all.
set -eu

# The release this installer belongs to, and what that release published: the
# digest of its image and the SHA-256 of its compose file and Caddyfile (the
# release notes list all three; docs/TESTING.md, Releasing). A new install
# gets exactly those files and that image, and nothing changes under it when
# main moves on. The image is pinned in .env too: to upgrade, set the new
# release's image in OPNMESH_IMAGE there, then
# docker compose pull && docker compose up -d.
RELEASE=2.1.4
RELEASE_IMAGE_DIGEST=sha256:4afa4b8f618f29f0362e04cc59e75067c4bcca307df362d94a4a80a14eb447f7
RELEASE_FILE_SUMS="4b470c001bbec626a97baf5b63223e783d67600155b31619983d1fbff2fa447b  docker-compose.yml
acd1a7da96d7a6bd1416bf7346bb95a33dfcecf51b787bb601faf71f8ae64db0  Caddyfile"

REPO=CoppingEthan/OPNmesh
IMAGE_REPO=ghcr.io/coppingethan/opnmesh
# The key Docker signs its Ubuntu and Debian packages with, as published at
# https://docs.docker.com/engine/install/ubuntu/.
DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

log() { printf '\033[1;32m[opnmesh]\033[0m %s\n' "$*"; }
die() { echo "$*" >&2; exit 2; }

# A DNS name: lowercase letters, digits and hyphens in dot-separated labels,
# the last of them not all digits (10.0.0.256 is a bad address, not a name).
# It reaches the Caddyfile (Caddy substitutes {$OPNMESH_SITE} before it parses
# the file) and .env, so nothing else may get through.
is_hostname() {
  case "$1" in
    '' | *[!a-z0-9.-]* | .* | *. | *..* | -* | *- | *.-* | *-.*) return 1 ;;
  esac
  case "${1##*.}" in
    *[!0-9]*) ;;
    *) return 1 ;;
  esac
  [ "${#1}" -le 253 ]
}

# A dotted quad, each part 0-255 with no leading zeros.
is_ipv4() {
  case "$1" in
    '' | *[!0-9.]* | .* | *. | *..*) return 1 ;;
  esac
  _ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086 # split on the dots
  set -- $1
  IFS=$_ifs
  [ $# -eq 4 ] || return 1
  for _o; do
    case "$_o" in 0?*) return 1 ;; esac
    [ "${#_o}" -le 3 ] && [ "$_o" -le 255 ] || return 1
  done
}

is_port() {
  case "$1" in
    '' | *[!0-9]* | 0*) return 1 ;;
  esac
  [ "${#1}" -le 5 ] && [ "$1" -le 65535 ]
}

lowercase() { printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]'; }

# check_url <url>: https://<DNS name or IPv4 address>[:port] and nothing more.
# The controller refuses any other public URL, because it pastes this one into
# the commands gateways run as root.
check_url() {
  _hostport=${1#https://}
  [ "$_hostport" != "$1" ] || die "--url must start with https:// (got: $1)"
  case "$_hostport" in
    \[*) die "--url: IPv6 addresses are not supported by this installer; use a DNS name" ;;
    *:*) _host=${_hostport%%:*} _port=${_hostport#*:} ;;
    *) _host=$_hostport _port=443 ;;
  esac
  is_port "$_port" || die "--url: bad port in $1"
  is_ipv4 "$_host" || is_hostname "$_host" ||
    die "--url must be https://<host>[:port] with a DNS name or IPv4 address, and no path (got: $1)"
}

# fetch <url> <file>: download over https only (a redirect cannot leave it),
# or from file:// for a local test run.
fetch() {
  case "$1" in
    https://*) curl -fsSL --proto =https "$1" -o "$2" ;;
    file://*) curl -fsSL --proto =file "$1" -o "$2" ;;
    *) echo "refusing to download $1: only https:// (or file:// for a local test) is allowed" >&2; return 1 ;;
  esac
}

# Docker Engine and its compose plugin from Docker's apt repository, on
# Ubuntu and Debian. The repository's signing key must be the one Docker
# publishes; apt then checks every package against it.
install_docker() {
  # /etc/os-release sets VERSION among others, so read it in subshells.
  # shellcheck source=/dev/null
  _os="$(. /etc/os-release && printf '%s' "${ID:-}")"
  # shellcheck source=/dev/null
  _codename="$(. /etc/os-release && printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")"
  case "$_os" in
    ubuntu | debian) ;;
    *) die "Docker is not installed. Install Docker Engine and its compose plugin (https://docs.docker.com/engine/install/), then run this again." ;;
  esac
  case "$_codename" in
    '' | *[!a-z]*) die "cannot tell which $_os release this is; install Docker yourself (https://docs.docker.com/engine/install/), then run this again" ;;
  esac
  log "installing Docker from Docker's apt repository"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -qq -y --no-install-recommends ca-certificates curl gnupg >/dev/null
  _key="$(mktemp)"
  _gnupg="$(mktemp -d)"
  fetch "https://download.docker.com/linux/$_os/gpg" "$_key"
  _got="$(GNUPGHOME="$_gnupg" gpg --batch --with-colons --show-keys "$_key" 2>/dev/null |
    awk -F: '$1 == "pub" { p = 1; next } $1 == "fpr" && p { print $10; p = 0 }')"
  rm -rf "$_gnupg"
  if [ "$_got" != "$DOCKER_KEY_FINGERPRINT" ]; then
    rm -f "$_key"
    die "ABORTING: Docker's signing key is not the expected $DOCKER_KEY_FINGERPRINT (got: $(printf '%s' "$_got" | tr '\n' ' '))"
  fi
  install -m 0755 -d /etc/apt/keyrings
  install -m 0644 "$_key" /etc/apt/keyrings/docker.asc
  rm -f "$_key"
  printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
    "$_os" "$_codename" "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.sources
  apt-get update -qq
  apt-get install -qq -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
}

main() {
  VERSION="${OPNMESH_VERSION:-$RELEASE}"
  DIR=/opt/opnmesh
  DOMAIN="${OPNMESH_DOMAIN:-}"
  URL="${OPNMESH_PUBLIC_URL:-}"
  IMAGE="${OPNMESH_IMAGE:-}"
  HTTP_PORT="${OPNMESH_HTTP_PORT:-80}"
  HTTPS_PORT="${OPNMESH_HTTPS_PORT:-443}"
  RAW="${OPNMESH_RAW_BASE:-}"
  # Where the expected SHA-256 of the files comes from when RAW is not a
  # release (a local test run); a file in sha256sum's format.
  SUMS="${OPNMESH_FILE_SUMS:-}"
  START=1
  # The image runs as this unprivileged user; the data directory must be its.
  DATA_UID=1000

  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) DIR="$2"; shift 2 ;;
      --domain) DOMAIN="$2"; shift 2 ;;
      --url) URL="$2"; shift 2 ;;
      --version) VERSION="$2"; shift 2 ;;
      --image) IMAGE="$2"; shift 2 ;;
      --http-port) HTTP_PORT="$2"; shift 2 ;;
      --https-port) HTTPS_PORT="$2"; shift 2 ;;
      --no-start) START=0; shift ;;
      *) die "unknown flag: $1" ;;
    esac
  done

  [ "$(id -u)" = "0" ] || die "run as root (sudo)"

  # Check everything given before anything changes. --------------------------
  # 2.1.0 here is v2.1.0 as a git tag; accept either.
  VERSION="${VERSION#v}"
  case "$VERSION" in
    '' | *[!0-9A-Za-z.-]*) die "bad version: $VERSION" ;;
  esac
  case "$DIR" in
    /*) ;;
    *) die "--dir must be an absolute path" ;;
  esac
  is_port "$HTTP_PORT" || die "bad --http-port: $HTTP_PORT"
  is_port "$HTTPS_PORT" || die "bad --https-port: $HTTPS_PORT"
  if [ -n "$DOMAIN" ]; then
    DOMAIN="$(lowercase "$DOMAIN")"
    case "$DOMAIN" in *.*) ;; *) die "--domain must be a public DNS name such as mesh.example.com" ;; esac
    is_hostname "$DOMAIN" || die "--domain must be a DNS name (letters, digits, hyphens and dots), got: $DOMAIN"
  fi
  if [ -n "$URL" ]; then
    URL="$(lowercase "${URL%/}")"
    check_url "$URL"
  fi
  if [ -z "$IMAGE" ]; then
    IMAGE="$IMAGE_REPO:$VERSION"
    if [ "$VERSION" = "$RELEASE" ] && [ -n "$RELEASE_IMAGE_DIGEST" ]; then
      IMAGE="$IMAGE@$RELEASE_IMAGE_DIGEST"
    fi
  fi
  case "$IMAGE" in
    '' | *[!A-Za-z0-9._/:@-]*) die "bad image reference: $IMAGE" ;;
  esac
  RAW="${RAW:-https://raw.githubusercontent.com/$REPO/v$VERSION/deploy/controller}"

  # env_value <name>: one value out of .env, without executing the file.
  # Sourcing it would run any value that contains a space
  # (OPNMESH_TLS="tls internal") as a command.
  env_value() {
    { sed -n "s/^$1=//p" .env 2>/dev/null || true; } | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
  }

  # Docker -------------------------------------------------------------------
  command -v docker >/dev/null 2>&1 || install_docker
  docker compose version >/dev/null 2>&1 ||
    die "the docker compose plugin is missing: install docker-compose-plugin (Docker's repository) or docker-compose-v2 (Ubuntu's)"

  # Files --------------------------------------------------------------------
  mkdir -p "$DIR/data" "$DIR/caddy"
  # The controller runs unprivileged inside its container and must own its
  # data (SQLite, secret.key, the setup code). A root-owned directory would
  # leave it unable to start. The same uid on the host is often the first
  # login user, who can therefore read the secrets; 0700 keeps every other
  # account out. Where uid 1000 is a person, treat that account as a
  # controller admin.
  chown "$DATA_UID:$DATA_UID" "$DIR/data"
  chmod 0700 "$DIR/data"
  cd "$DIR"

  # Each file is downloaded beside its final name and checked against the
  # release's SHA-256 before it takes that name: an existing file is kept on
  # a re-run, so a truncated or altered one must never get there.
  SUMS_TEXT=""
  for f in docker-compose.yml Caddyfile; do
    [ ! -f "$f" ] || continue
    if [ -z "$SUMS_TEXT" ]; then
      if [ -n "$SUMS" ]; then
        _sums="$(mktemp)"
        fetch "$SUMS" "$_sums" || { rm -f "$_sums"; die "could not download the checksums from $SUMS"; }
        SUMS_TEXT="$(cat "$_sums")"
        rm -f "$_sums"
      elif [ "$VERSION" = "$RELEASE" ]; then
        SUMS_TEXT="$RELEASE_FILE_SUMS"
      else
        _sums="$(mktemp)"
        if ! fetch "https://github.com/$REPO/releases/download/v$VERSION/controller-files.sha256" "$_sums"; then
          rm -f "$_sums"
          die "release v$VERSION publishes no checksums for its files (controller-files.sha256). Releases before they did are installed with their own installer: https://raw.githubusercontent.com/$REPO/v$VERSION/deploy/controller/install.sh"
        fi
        SUMS_TEXT="$(cat "$_sums")"
        rm -f "$_sums"
      fi
    fi
    want="$(printf '%s\n' "$SUMS_TEXT" | awk -v f="$f" '$2 == f || $2 == "*" f { print $1; exit }')"
    case "$want" in
      '' | *[!0-9a-f]*) die "no SHA-256 for $f in release $VERSION's checksums" ;;
    esac
    tmp="$(mktemp "$DIR/.$f.XXXXXX")"
    if ! fetch "$RAW/$f" "$tmp"; then
      rm -f "$tmp"
      die "could not download $RAW/$f"
    fi
    got="$(sha256sum "$tmp" | cut -d' ' -f1)"
    if [ "$got" != "$want" ]; then
      rm -f "$tmp"
      die "ABORTING: $RAW/$f is not the file release $VERSION published (SHA-256 $got, expected $want). Nothing was installed."
    fi
    chmod 0644 "$tmp"
    mv "$tmp" "$f"
    log "wrote $DIR/$f (SHA-256 verified)"
  done

  if [ ! -f .env ]; then
    if [ -z "$URL" ]; then
      if [ -n "$DOMAIN" ]; then
        URL="https://$DOMAIN"
      else
        IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1)"
        IP="${IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
        is_ipv4 "$IP" || die "cannot work out this host's IPv4 address; pass --url https://<address or name>"
        URL="https://$IP"
        log "no domain given; using $URL with a private CA (gateways pin it at install)"
      fi
      check_url "$URL"
    fi
    SITE="$DOMAIN"
    if [ -z "$SITE" ]; then
      SITE=${URL#https://}
      SITE=${SITE%%:*}
    fi
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

  # Start --------------------------------------------------------------------
  if [ "$START" = "1" ]; then
    log "starting OPNmesh ($(env_value OPNMESH_IMAGE))"
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
}

main "$@"
