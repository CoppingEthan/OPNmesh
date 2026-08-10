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
#   --token <t>       one-time enrolment token (required)
#   --server <url>    control node base URL, e.g. https://mesh.example:8443
#                     (required; HTTPS enforced unless --insecure-http)
#   --insecure-http   allow http:// (simulation / lab use only)
#   --no-deps         skip package installation
#   --no-start        do not start the agent (the sim's entrypoint starts it)
set -eu

TOKEN=""
SERVER=""
ALLOW_HTTP=0
INSTALL_DEPS=1
START_AGENT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
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
    apt-get update -qq && apt-get install -qq -y wireguard-tools nftables curl >/dev/null
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache -q wireguard-tools nftables curl
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

HOSTNAME_VAL="$(hostname)"
ADDRESSES="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | paste -sd, - || true)"

# 3. Enrol: only the PUBLIC key, hostname and detected addresses are sent.
ADDR_JSON="$(printf '%s' "$ADDRESSES" | awk -F, '{ for (i=1;i<=NF;i++) printf "%s\"%s\"", (i>1?",":""), $i }')"
BODY="$(printf '{"token":"%s","publicKey":"%s","hostname":"%s","addresses":[%s]}' \
  "$TOKEN" "$PUBKEY" "$HOSTNAME_VAL" "$ADDR_JSON")"

RESPONSE="$(curl -fsS -X POST -H 'Content-Type: application/json' -d "$BODY" "$SERVER/api/v1/enrol")" || {
  echo "enrolment failed (token expired, already used, or control unreachable)" >&2
  exit 1
}

NODE_TOKEN="$(printf '%s' "$RESPONSE" | sed -n 's/.*"nodeToken":"\([^"]*\)".*/\1/p')"
[ -n "$NODE_TOKEN" ] || { echo "unexpected enrolment response: $RESPONSE" >&2; exit 1; }

printf '%s\n' "$NODE_TOKEN" > /etc/opnmesh/agent.token

# 4. Agent configuration. The node is pending until approved.
cat > /etc/opnmesh/agent.json <<EOF
{
  "server_url": "$SERVER",
  "token_file": "/etc/opnmesh/agent.token",
  "conf_dir": "/etc/opnmesh",
  "state_dir": "/var/lib/opnmesh",
  "wg_interface": "wg0",
  "poll_interval_sec": 10
}
EOF

echo "enrolled: node is PENDING approval (key fingerprint follows for out-of-band verification)"
printf '%s' "$PUBKEY" | sha256sum | cut -c1-16
echo "approve this node in the OPNmesh UI; it will pull its configuration on the next poll"

if [ "$START_AGENT" = "1" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now opnmesh-agent 2>/dev/null || echo "start the agent manually: opnmesh-agent -config /etc/opnmesh/agent.json"
fi
