#!/bin/bash
# Gateway node: boot from the config already on disk (the data plane never
# depends on the control node being reachable), then hand over to the agent,
# which polls the control node and reconciles differences.
set -euo pipefail

# ip_forward is set via compose sysctls; this is belt-and-braces for other runtimes.
sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true

if [ -f /etc/opnmesh/nftables.conf ]; then
  nft -f /etc/opnmesh/nftables.conf
fi
if [ -f /etc/opnmesh/wg0.conf ]; then
  wg-quick up /etc/opnmesh/wg0.conf
  echo "gateway up: $(wg show wg0 public-key)"
fi

exec opnmesh-agent -config /etc/opnmesh/agent.json
