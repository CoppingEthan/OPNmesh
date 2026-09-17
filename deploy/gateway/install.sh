#!/bin/sh
# OPNmesh gateway installer.
#
#   curl -fsSL __OPNMESH_URL__/install.sh | sudo bash -s -- --token <one-time-token>
#   curl -fsSL __OPNMESH_URL__/install.sh | sudo bash -s -- --upgrade
#
# What it does, in order:
#   1. Installs wireguard-tools, nftables, iproute2 and curl (apt, dnf or apk).
#   2. Downloads the opnmesh-gw agent binary from the controller and verifies
#      its SHA-256 against the controller's published digest.
#   3. Generates a WireGuard keypair LOCALLY. The private key never leaves this
#      machine; only the public key is sent to the controller.
#   4. Enrols with the one-time token (the agent does this itself) and stores
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
#   --token <t>            one-time enrolment token from the OPNmesh UI
#   --token-file <f>       read the token from a file instead (keeps it out of `ps`)
#   --upgrade              update the agent of an already enrolled gateway
#   --controller <url>     override the controller URL baked into this script
#   --ca-fingerprint <hex> SHA-256 of the controller's private CA certificate;
#                          the UI prints it. Downloads and pins the CA so a
#                          private-CA controller is verified, not trusted blind.
#                          A CA pinned by an earlier install is reused.
#   --insecure-http        allow an http:// controller (simulation / lab only)
#   --binary <path>        use a local agent binary instead of downloading
#   --no-deps              skip package installation
#   --no-start             install but do not start the services
#
# Inspect this script before running it; the UI shows its SHA-256.
set -eu

CONTROLLER="__OPNMESH_URL__"
TOKEN="${OPNMESH_TOKEN:-}"
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
    --token-file) TOKEN="$(cat "$2")"; shift 2 ;;
    --upgrade) UPGRADE=1; shift ;;
    --controller) CONTROLLER="$2"; shift 2 ;;
    --ca-fingerprint) CA_FP="$2"; shift 2 ;;
    --insecure-http) ALLOW_HTTP=1; shift ;;
    --binary) LOCAL_BIN="$2"; shift 2 ;;
    --no-deps) INSTALL_DEPS=0; shift ;;
    --no-start) START=0; shift ;;
    -h|--help) sed -n '2,38p' "$0"; exit 0 ;;
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

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac

log() { printf '\033[1;32m[opnmesh]\033[0m %s\n' "$*"; }

# 1. Dependencies -----------------------------------------------------------
if [ "$INSTALL_DEPS" = "1" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    log "installing wireguard-tools, nftables, iproute2, curl (apt)"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -qq -y --no-install-recommends wireguard-tools nftables iproute2 curl ca-certificates >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    log "installing wireguard-tools, nftables, iproute, curl (dnf)"
    dnf install -q -y wireguard-tools nftables iproute curl ca-certificates
  elif command -v apk >/dev/null 2>&1; then
    log "installing wireguard-tools, nftables, iproute2, curl (apk)"
    apk add --no-cache -q wireguard-tools nftables iproute2 curl ca-certificates
  else
    echo "no supported package manager; install wireguard-tools, nftables and iproute2 yourself, then re-run with --no-deps" >&2
    exit 1
  fi
fi
for tool in wg nft ip curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is not installed" >&2; exit 1; }
done
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
CURL_CA=""
if [ -n "$CA_FP" ]; then
  log "downloading the controller's CA certificate"
  curl -fsSk "$CONTROLLER/ca.crt" -o /etc/opnmesh/controller-ca.crt.new
  GOT="$(sha256sum /etc/opnmesh/controller-ca.crt.new | cut -d' ' -f1)"
  WANT="$(printf '%s' "$CA_FP" | tr 'A-F' 'a-f' | tr -cd 'a-f0-9')"
  if [ "$GOT" != "$WANT" ]; then
    rm -f /etc/opnmesh/controller-ca.crt.new
    echo "ABORTING: CA certificate fingerprint mismatch (expected $WANT, got $GOT)." >&2
    echo "Someone may be intercepting this connection. Nothing has been sent." >&2
    exit 1
  fi
  mv /etc/opnmesh/controller-ca.crt.new /etc/opnmesh/controller-ca.crt
  log "CA certificate verified and pinned"
fi
# A CA pinned now or by an earlier install verifies every download below.
[ -f /etc/opnmesh/controller-ca.crt ] && CURL_CA="--cacert /etc/opnmesh/controller-ca.crt"
[ "$ALLOW_HTTP" = "1" ] && CURL_CA="" || true

# 3. Agent binary (staged; installed after enrolment succeeds) ----------------
rm -f "$BIN.new"
if [ -n "$LOCAL_BIN" ]; then
  install -m 0755 "$LOCAL_BIN" "$BIN.new"
  log "staged agent from $LOCAL_BIN"
else
  log "downloading opnmesh-gw for linux/$ARCH"
  # shellcheck disable=SC2086
  curl -fsSL $CURL_CA "$CONTROLLER/dl/opnmesh-gw-linux-$ARCH" -o "$BIN.new"
  # shellcheck disable=SC2086
  WANT_SUM="$(curl -fsSL $CURL_CA "$CONTROLLER/dl/opnmesh-gw-linux-$ARCH.sha256" | cut -d' ' -f1)"
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
  [ -f /etc/opnmesh/controller-ca.crt ] && ENROL_FLAGS="$ENROL_FLAGS --ca /etc/opnmesh/controller-ca.crt"
  log "enrolling with $CONTROLLER"
  # shellcheck disable=SC2086
  if ! "$BIN.new" enrol --controller "$CONTROLLER" --token "$TOKEN" $ENROL_FLAGS; then
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
ProtectHome=yes
PrivateTmp=yes

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
