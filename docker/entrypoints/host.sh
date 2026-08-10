#!/bin/bash
# Plain LAN host: no VPN software, default gateway pointed at the site's
# WireGuard gateway. Runs an iperf3 server so there is something to talk to.
set -euo pipefail

ip route replace default via "${GW_IP}"
iperf3 -s -D
echo "host up behind ${GW_IP}"
exec sleep infinity
