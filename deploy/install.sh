#!/bin/sh
# OPNmesh node installer / enrolment script.
#
#   curl -fsSL https://<control-host>:<port>/install.sh | sudo bash -s -- --token <one-time-token>
#
# What it does, in order:
#   1. Installs dependencies (wireguard-tools, nftables) via apt or apk.
#   2. Generates a WireGuard keypair LOCALLY. The private key never leaves
#      this machine — only the public key is sent to the control node.
#   3. Enrols over HTTPS with the one-time token; stores the returned node
#      token root-only.
#   4. Writes the agent configuration. The node stays "pending" (no
#      configuration, no access) until an admin approves it in the UI.
#
# Inspect this script before piping it to a shell; the UI shows its SHA-256
# beside the enrolment command.
#
# Flags:
#   --token <t>       one-time enrolment token. Visible in `ps` to local users
#                     for the life of the process — prefer --token-file or
#                     OPNMESH_TOKEN in the environment on shared machines.
#   --token-file <f>  read the enrolment token from a file instead
#   --server <url>    control node base URL, e.g. https://mesh.example:8443
#                     (required; HTTPS enforced unless --insecure-http)
#   --insecure-http   allow http:// (simulation / lab use only)
#   --no-deps         skip package installation
#   --no-start        do not start the agent (the sim's entrypoint starts it)
set -eu

TOKEN="${OPNMESH_TOKEN:-}"
SERVER=""
ALLOW_HTTP=0
INSTALL_DEPS=1
START_AGENT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --token-file) TOKEN="$(cat "$2")"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --insecure-http) ALLOW_HTTP=1; shift ;;
    --no-deps) INSTALL_DEPS=0; shift ;;
    --no-start) START_AGENT=0; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

[ -n "$TOKEN" ] || { echo "--token is required" >&2; exit 2; }
[ -n "$SERVER" ] || { echo "--server is required" >&2; exit 2; }

case "$SERVER" in
  https://*) : ;;
  http://*)
    if [ "$ALLOW_HTTP" != "1" ]; then
      echo "refusing plain http server URL; use --insecure-http for lab setups" >&2
      exit 2
    fi
    ;;
  *) echo "server URL must start with https://" >&2; exit 2 ;;
esac

if [ "$INSTALL_DEPS" = "1" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq && apt-get install -qq -y wireguard-tools nftables curl openssl minisign >/dev/null
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache -q wireguard-tools nftables curl openssl minisign
  else
    echo "no supported package manager found; install wireguard-tools and nftables manually" >&2
  fi
fi

umask 077
mkdir -p /etc/opnmesh/keys /var/lib/opnmesh

# 2. Keypair, generated locally. Never printed, never transmitted.
if [ ! -f /etc/opnmesh/keys/wg0.key ]; then
  wg genkey > /etc/opnmesh/keys/wg0.key
fi
PUBKEY="$(wg pubkey < /etc/opnmesh/keys/wg0.key)"

# Strip anything that is not a safe JSON scalar. A quote or backslash in a
# hostname would otherwise inject arbitrary keys into the enrolment body.
json_clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9._:-' | cut -c1-253; }

HOSTNAME_VAL="$(json_clean "$(hostname)")"
ADDRESSES="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | paste -sd, - || true)"

# 3. Record the control node's certificate public key (SPKI) so the agent pins
#    it from here on. A private mesh then needs no public CA, and a swapped or
#    mis-issued certificate is refused even if it chains to a trusted root.
PIN=""
if [ "$ALLOW_HTTP" != "1" ]; then
  HOSTPORT="${SERVER#https://}"
  HOSTPORT="${HOSTPORT%%/*}"
  case "$HOSTPORT" in *:*) : ;; *) HOSTPORT="$HOSTPORT:443" ;; esac
  PIN="$(echo | openssl s_client -connect "$HOSTPORT" -servername "${HOSTPORT%%:*}" 2>/dev/null \
    | openssl x509 -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform der 2>/dev/null \
    | openssl dgst -sha256 -hex 2>/dev/null | awk '{print $NF}')" || true
  if [ -z "$PIN" ]; then
    echo "could not read the control node's certificate in order to pin it" >&2
    exit 1
  fi
  echo "pinning control node certificate: ${PIN}"
fi

# 4. Enrol: only the PUBLIC key, hostname and detected addresses are sent.
ADDR_JSON="$(printf '%s' "$ADDRESSES" | awk -F, '{ for (i=1;i<=NF;i++) if ($i != "") printf "%s\"%s\"", (i>1?",":""), $i }')"
BODY="$(printf '{"token":"%s","publicKey":"%s","hostname":"%s","addresses":[%s]}' \
  "$TOKEN" "$PUBKEY" "$HOSTNAME_VAL" "$ADDR_JSON")"

RESPONSE="$(curl -fsS -X POST -H 'Content-Type: application/json' --data-binary "$BODY" "$SERVER/api/v1/enrol")" || {
  echo "enrolment failed (token expired, already used, or control unreachable)" >&2
  exit 1
}

NODE_TOKEN="$(printf '%s' "$RESPONSE" | sed -n 's/.*"nodeToken":"\([^"]*\)".*/\1/p')"
[ -n "$NODE_TOKEN" ] || { echo "unexpected enrolment response: $RESPONSE" >&2; exit 1; }

printf '%s\n' "$NODE_TOKEN" > /etc/opnmesh/agent.token

# 5. Agent configuration. The node is pending until approved.
cat > /etc/opnmesh/agent.json <<EOF
{
  "server_url": "$SERVER",
  "token_file": "/etc/opnmesh/agent.token",
  "conf_dir": "/etc/opnmesh",
  "state_dir": "/var/lib/opnmesh",
  "wg_interface": "wg0",
  "poll_interval_sec": 10,
  "commit_confirm_sec": 90,
  "boot_watchdog_sec": 180,
  "server_pin_sha256": "$PIN",
  "insecure_transport": $([ "$ALLOW_HTTP" = "1" ] && echo true || echo false)
}
EOF
chmod 0600 /etc/opnmesh/agent.json

# 6. Install units if they were staged alongside the script (real installer
#    ships them next to install.sh). The agent binary and helpers go in
#    /usr/local/bin; the A/B wrapper prefers a flipped-in version.
STAGE="$(dirname "$0")"
for unit in opnmesh-agent.service opnmesh-reresolve-dns.service opnmesh-reresolve-dns.timer; do
  [ -f "$STAGE/$unit" ] && install -m 0644 "$STAGE/$unit" /etc/systemd/system/ 2>/dev/null || true
done
for bin in opnmesh-agent-wrapper opnmesh-reresolve-dns; do
  [ -f "$STAGE/$bin" ] && install -m 0755 "$STAGE/$bin" /usr/local/bin/ 2>/dev/null || true
done
# The minisign public key gates every future self-update. Without it the agent
# refuses all updates (fail closed), so ship it with the installer.
[ -f "$STAGE/minisign.pub" ] && install -m 0644 "$STAGE/minisign.pub" /etc/opnmesh/minisign.pub 2>/dev/null || true
if [ ! -f /etc/opnmesh/minisign.pub ]; then
  echo "note: no /etc/opnmesh/minisign.pub — this node will refuse self-updates until you install the release signing key" >&2
fi

echo "enrolled: node is PENDING approval (key fingerprint follows for out-of-band verification)"
printf '%s' "$PUBKEY" | sha256sum | cut -c1-16
echo "approve this node in the OPNmesh UI; it will pull its configuration on the next poll"

if [ "$START_AGENT" = "1" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable --now opnmesh-agent 2>/dev/null \
    || echo "start the agent manually: opnmesh-agent -config /etc/opnmesh/agent.json"
  # The reresolve-dns timer is enabled once config arrives and a peer endpoint
  # is a hostname (agent-settings.json needs_reresolve); enabling it here is
  # harmless when no hostname peers exist.
  systemctl enable --now opnmesh-reresolve-dns.timer 2>/dev/null || true
fi
