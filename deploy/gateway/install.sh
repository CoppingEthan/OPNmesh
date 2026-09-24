#!/bin/sh
# OPNmesh gateway installer.
#
#   curl -fsSL __OPNMESH_URL__/install.sh | sudo bash -s -- --token-file <file>
#   curl -fsSL __OPNMESH_URL__/install.sh | sudo bash -s -- --upgrade
#
# The UI prints the enrolment command in full. It has the shell write the
# one-time token to a private temporary file with its built-in printf and
# passes that file, because every argument of every process shows in `ps`
# and in sudo's log.
#
# What it does, in order:
#   1. Installs wireguard-tools, nftables, iproute2, curl and openssl (apt,
#      dnf or apk).
#   2. Downloads the opnmesh-gw agent binary from the controller and verifies
#      its SHA-256 against the controller's published digest.
#   3. Generates a WireGuard keypair LOCALLY. The private key never leaves this
#      machine; only the public key is sent to the controller.
#   4. Enrols with the one-time token (the agent does this itself, reading
#      the token from its environment rather than its arguments) and stores
#      the returned gateway token root-only. The new binary only replaces the
#      installed one once enrolment has succeeded.
#   5. Installs and starts two systemd units: opnmesh-wg (brings the tunnel up
#      from the files on disk at boot, no controller needed) and opnmesh-gw
#      (the agent that keeps those files current and reports telemetry).
#
# With --upgrade, an enrolled gateway only gets the controller's current
# agent binary and systemd units, and the agent is restarted. No token is
# needed, the gateway keeps its identity, and the tunnel stays up throughout.
#
# Flags:
#   --token-file <f>       read the one-time enrolment token from a file
#   --token <t>            the token itself (older commands; visible in `ps`)
#   --upgrade              update the agent of an already enrolled gateway
#   --controller <url>     override the controller URL baked into this script
#                          (scheme://host[:port], nothing more)
#   --ca-fingerprint <hex> SHA-256 of the controller's private CA certificate;
#                          the UI prints it. Either the certificate's own
#                          fingerprint (openssl x509 -fingerprint -sha256, with
#                          or without colons) or the hash of the PEM file.
#                          Downloads and pins the CA so a private-CA controller
#                          is verified, not trusted blind. A CA pinned by an
#                          earlier install is reused.
#   --insecure-http        allow an http:// controller (simulation / lab only)
#   --binary <path>        use a local agent binary instead of downloading
#   --no-deps              skip package installation
#   --no-start             install but do not start the services
#
# Inspect this script before running it; the UI shows its SHA-256. It runs
# from main(), called on its last line, so a download cut short runs nothing.
set -eu

main() {
CONTROLLER="__OPNMESH_URL__"
TOKEN="${OPNMESH_TOKEN:-}"
# Only the agent gets the token, and only when it enrols.
unset OPNMESH_TOKEN
CA_FP=""
ALLOW_HTTP=0
LOCAL_BIN=""
INSTALL_DEPS=1
START=1
UPGRADE=0
BIN=/usr/local/bin/opnmesh-gw

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --token-file)
      [ -f "$2" ] && [ -r "$2" ] || { echo "--token-file: cannot read $2" >&2; exit 2; }
      TOKEN="$(tr -d '[:space:]' < "$2")"
      shift 2 ;;
    --upgrade) UPGRADE=1; shift ;;
    --controller) CONTROLLER="$2"; shift 2 ;;
    --ca-fingerprint) CA_FP="$2"; shift 2 ;;
    --insecure-http) ALLOW_HTTP=1; shift ;;
    --binary) LOCAL_BIN="$2"; shift 2 ;;
    --no-deps) INSTALL_DEPS=0; shift ;;
    --no-start) START=0; shift ;;
    -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "run as root (sudo)" >&2; exit 2; }
if [ "$UPGRADE" = "1" ]; then
  [ -f /etc/opnmesh/agent.json ] || { echo "--upgrade: this machine is not enrolled yet; install it with --token first" >&2; exit 2; }
  [ -f /etc/opnmesh/private.key ] || { echo "--upgrade: /etc/opnmesh/private.key is missing; re-enrol with a new --token" >&2; exit 2; }
  TOKEN=""
else
  [ -n "$TOKEN" ] || { echo "--token is required (create one on the site page in OPNmesh), or --upgrade for an enrolled gateway" >&2; exit 2; }
fi

case "$CONTROLLER" in
  https://*) : ;;
  http://*)
    [ "$ALLOW_HTTP" = "1" ] || { echo "refusing plain http:// controller; pass --insecure-http for a lab" >&2; exit 2; } ;;
  *) echo "controller URL must start with https://" >&2; exit 2 ;;
esac
CONTROLLER="${CONTROLLER%/}"
# The URL goes into curl commands, the agent's configuration and the log, so
# it must be exactly scheme://host[:port]: a DNS name or IPv4 address, or an
# IPv6 address in brackets.
valid_controller() {
  case "$1" in *"
"*) return 1 ;; esac
  printf '%s\n' "$1" | LC_ALL=C grep -Eqx 'https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+])(:[0-9]{1,5})?'
}
if ! valid_controller "$CONTROLLER"; then
  echo "controller URL must be scheme://host[:port] and nothing else, got: $(printf '%s' "$CONTROLLER" | LC_ALL=C tr -cd '[:graph:]')" >&2
  exit 2
fi
# The CA fingerprint is a SHA-256 in hex, in either case, colons allowed.
if [ -n "$CA_FP" ]; then
  CA_FP="$(printf '%s' "$CA_FP" | tr -d ':' | tr 'ABCDEF' 'abcdef')"
  case "$CA_FP" in *[!0123456789abcdef]*) CA_FP="invalid" ;; esac
  if [ "${#CA_FP}" -ne 64 ]; then
    echo "--ca-fingerprint must be a SHA-256 in hex (64 digits, colons allowed)" >&2
    exit 2
  fi
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac

log() { printf '\033[1;32m[opnmesh]\033[0m %s\n' "$*"; }

# 1. Dependencies -----------------------------------------------------------
if [ "$INSTALL_DEPS" = "1" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    log "installing wireguard-tools, nftables, iproute2, curl, openssl (apt)"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -qq -y --no-install-recommends wireguard-tools nftables iproute2 curl openssl ca-certificates >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    log "installing wireguard-tools, nftables, iproute, curl, openssl (dnf)"
    dnf install -q -y wireguard-tools nftables iproute curl openssl ca-certificates
  elif command -v apk >/dev/null 2>&1; then
    log "installing wireguard-tools, nftables, iproute2, curl, openssl (apk)"
    apk add --no-cache -q wireguard-tools nftables iproute2 curl openssl ca-certificates
  else
    echo "no supported package manager; install wireguard-tools, nftables and iproute2 yourself, then re-run with --no-deps" >&2
    exit 1
  fi
fi
for tool in wg nft ip curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is not installed" >&2; exit 1; }
done
if [ -n "$CA_FP" ] && ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is not installed; it is needed to check --ca-fingerprint" >&2
  exit 1
fi
if [ "$UPGRADE" = "0" ]; then
  if ! ip link add opnmesh-probe type wireguard 2>/dev/null; then
    echo "WARNING: the kernel refused to create a WireGuard interface. On Ubuntu 22.04+ WireGuard is built in;" >&2
    echo "         on other kernels install the wireguard module (apt install wireguard) and reboot." >&2
  else
    ip link del opnmesh-probe
  fi
fi

umask 077
mkdir -p /etc/opnmesh /var/lib/opnmesh

# 2. Private CA (optional) ----------------------------------------------------
# Downloads from an https:// controller stay on https, redirects included.
CURL_PROTO="--proto =https"
[ "$ALLOW_HTTP" = "0" ] || CURL_PROTO=""
CA_PIN=/etc/opnmesh/controller-ca.crt
if [ -n "$CA_FP" ]; then
  log "downloading the controller's CA certificate"
  # shellcheck disable=SC2086
  curl -fsSk $CURL_PROTO "$CONTROLLER/ca.crt" -o "$CA_PIN.new"
  # Newer controllers give the certificate's own fingerprint (SHA-256 of its
  # DER form), older ones the SHA-256 of the PEM file; either will do.
  GOT_FILE="$(sha256sum "$CA_PIN.new" | cut -d' ' -f1)"
  GOT_CERT="not a certificate"
  if openssl x509 -in "$CA_PIN.new" -noout 2>/dev/null; then
    GOT_CERT="$(openssl x509 -in "$CA_PIN.new" -outform DER | sha256sum | cut -d' ' -f1)"
  fi
  if [ "$CA_FP" = "$GOT_CERT" ]; then
    # Pin exactly the certificate that matched, and nothing else the
    # unverified download may have carried after it.
    openssl x509 -in "$CA_PIN.new" -out "$CA_PIN.pem"
    mv "$CA_PIN.pem" "$CA_PIN"
    rm -f "$CA_PIN.new"
  elif [ "$CA_FP" = "$GOT_FILE" ]; then
    mv "$CA_PIN.new" "$CA_PIN"
  else
    rm -f "$CA_PIN.new"
    echo "ABORTING: CA certificate fingerprint mismatch (expected $CA_FP; the certificate is $GOT_CERT, the file $GOT_FILE)." >&2
    echo "Someone may be intercepting this connection. Nothing has been sent." >&2
    exit 1
  fi
  log "CA certificate verified and pinned"
fi
# A CA pinned now or by an earlier install verifies every download below.
CURL_OPTS="$CURL_PROTO"
if [ -f "$CA_PIN" ] && [ "$ALLOW_HTTP" = "0" ]; then
  CURL_OPTS="$CURL_OPTS --cacert $CA_PIN"
fi

# 3. Agent binary (staged; installed after enrolment succeeds) ----------------
rm -f "$BIN.new"
if [ -n "$LOCAL_BIN" ]; then
  install -m 0755 "$LOCAL_BIN" "$BIN.new"
  log "staged agent from $LOCAL_BIN"
else
  log "downloading opnmesh-gw for linux/$ARCH"
  # shellcheck disable=SC2086
  curl -fsSL $CURL_OPTS "$CONTROLLER/dl/opnmesh-gw-linux-$ARCH" -o "$BIN.new"
  # shellcheck disable=SC2086
  WANT_SUM="$(curl -fsSL $CURL_OPTS "$CONTROLLER/dl/opnmesh-gw-linux-$ARCH.sha256" | cut -d' ' -f1)"
  GOT_SUM="$(sha256sum "$BIN.new" | cut -d' ' -f1)"
  if [ -z "$WANT_SUM" ] || [ "$WANT_SUM" != "$GOT_SUM" ]; then
    rm -f "$BIN.new"
    echo "ABORTING: agent binary checksum mismatch" >&2
    exit 1
  fi
  chmod 0755 "$BIN.new"
  log "agent binary verified ($("$BIN.new" version))"
fi

# 4. Keypair and enrolment ---------------------------------------------------
if [ "$UPGRADE" = "0" ]; then
  if [ ! -f /etc/opnmesh/private.key ]; then
    wg genkey > /etc/opnmesh/private.key
    chmod 0600 /etc/opnmesh/private.key
    log "generated a new WireGuard keypair (private key stays on this machine)"
  fi

  ENROL_FLAGS=""
  [ "$ALLOW_HTTP" = "1" ] && ENROL_FLAGS="$ENROL_FLAGS --insecure-http"
  [ -f "$CA_PIN" ] && ENROL_FLAGS="$ENROL_FLAGS --ca $CA_PIN"
  log "enrolling with $CONTROLLER"
  # The token travels in the agent's environment, which only root can read,
  # rather than in its arguments, which every user can see in `ps`.
  # shellcheck disable=SC2086
  if ! OPNMESH_TOKEN="$TOKEN" "$BIN.new" enrol --controller "$CONTROLLER" $ENROL_FLAGS; then
    rm -f "$BIN.new"
    echo "ABORTING: enrolment failed; nothing else on this machine was changed." >&2
    exit 1
  fi
fi
PREVIOUS="$([ -x "$BIN" ] && "$BIN" version 2>/dev/null || echo none)"
mv "$BIN.new" "$BIN"
[ "$UPGRADE" = "1" ] && log "agent updated: $PREVIOUS -> $("$BIN" version)"

# 5. systemd units -----------------------------------------------------------
if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
  cat > /etc/systemd/system/opnmesh-wg.service <<'EOF'
# OPNmesh WireGuard interface. Brings the tunnel up from the files already on
# disk, so the site keeps working with no controller reachable.
[Unit]
Description=OPNmesh WireGuard tunnel
After=network-online.target
Wants=network-online.target
Before=opnmesh-gw.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/opnmesh-gw up
ExecStop=/usr/local/bin/opnmesh-gw down

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/opnmesh-gw.service <<'EOF'
# OPNmesh gateway agent: keeps the tunnel configuration current and reports
# telemetry to the controller. Runs as root because it manages WireGuard and
# nftables. Safe to stop: the tunnel stays up.
[Unit]
Description=OPNmesh gateway agent
After=network-online.target opnmesh-wg.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/opnmesh-gw run
Restart=always
RestartSec=5
# The agent runs wg, wg-quick, ip, nft and ufw; writes /etc/opnmesh,
# /var/lib/opnmesh, /proc/sys/net and ufw's rules; and uses netlink, raw and
# packet sockets. None of that is restricted here: file system and address
# family limits would have to follow every one of those tools.
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  if [ "$START" = "1" ]; then
    # opnmesh-wg is left running as it is: restarting it would drop the tunnel.
    systemctl enable --now opnmesh-wg.service >/dev/null 2>&1 || true
    if systemctl is-active --quiet opnmesh-gw.service; then
      systemctl restart opnmesh-gw.service
      log "agent restarted on the new binary"
    else
      systemctl enable --now opnmesh-gw.service
      log "services started: opnmesh-wg, opnmesh-gw"
    fi
  else
    systemctl enable opnmesh-wg.service opnmesh-gw.service >/dev/null 2>&1 || true
    log "services installed but not started (--no-start)"
  fi
else
  log "no systemd found; start the agent yourself: /usr/local/bin/opnmesh-gw run"
fi

if [ "$UPGRADE" = "1" ]; then
  log "done. The gateway keeps its identity; OPNmesh shows the new agent version within a minute."
else
  log "done. This gateway will appear in OPNmesh within a minute."
fi
log "Public key fingerprint (compare with the UI): $(printf '%s' "$(wg pubkey < /etc/opnmesh/private.key)" | sha256sum | cut -c1-16)"
}

main "$@"
