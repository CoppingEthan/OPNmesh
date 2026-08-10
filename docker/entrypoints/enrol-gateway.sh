#!/bin/bash
# A factory-fresh gateway: no config, no keys, no token. It fetches install.sh
# from the control node's public address and enrols with a one-time token,
# exactly like a real box. It then sits PENDING until an admin approves it,
# at which point the agent pulls config and the tunnels come up.
set -euo pipefail

sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true

if [ ! -f /etc/opnmesh/agent.token ]; then
  echo "enrolling against ${ENROL_SERVER}"
  curl -fsS "${ENROL_SERVER}/install.sh" -o /tmp/install.sh
  sh /tmp/install.sh --token "${ENROL_TOKEN}" --server "${ENROL_SERVER}" \
    --insecure-http --no-deps --no-start
fi

exec opnmesh-agent -config /etc/opnmesh/agent.json
