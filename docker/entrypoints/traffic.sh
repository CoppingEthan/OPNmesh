#!/bin/bash
# Traffic generator: continuous cross-site flows so the observability views
# have something to show. Lives on lan-a behind gw-a like any other host.
set -euo pipefail

ip route replace default via "${GW_IP}"
echo "traffic generator up"

while true; do
  iperf3 -c 10.20.5.20 -t 5 >/dev/null 2>&1 || true
  iperf3 -c 10.30.5.20 -t 5 -R >/dev/null 2>&1 || true
  ping -c 5 -i 0.2 10.20.5.20 >/dev/null 2>&1 || true
  ping -c 5 -i 0.2 10.30.5.20 >/dev/null 2>&1 || true
  sleep 10
done
