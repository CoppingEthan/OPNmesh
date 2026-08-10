#!/bin/bash
# Gateway node: nftables ruleset + wg-quick, exactly as a real deployment.
set -euo pipefail

# ip_forward is set via compose sysctls; this is belt-and-braces for other runtimes.
sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true

nft -f /etc/opnmesh/nftables.conf
wg-quick up /etc/opnmesh/wg0.conf

echo "gateway up: $(wg show wg0 public-key)"
exec sleep infinity
