#!/bin/bash
# Roaming client: WireGuard up, plus an iperf3 server that the isolation tests
# try (and must fail) to reach from LAN hosts.
set -euo pipefail

wg-quick up /etc/opnmesh/wg0.conf
iperf3 -s -D
echo "client up: $(wg show wg0 public-key)"
exec sleep infinity
