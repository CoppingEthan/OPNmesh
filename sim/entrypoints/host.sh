#!/bin/bash
# A plain LAN host: no VPN software, default gateway = the site router,
# an HTTP server that logs the client address (to prove real source
# addresses survive the mesh) and an iperf3 server for throughput tests.
#
# Env: ROUTER_IP
set -eu
. /opt/sim/lib.sh

# Like a hardened host: do not learn routes from ICMP redirects, so the
# router really is in the path for every packet (the pessimistic case).
sysctl -qw net.ipv4.conf.all.accept_redirects=0 2>/dev/null || true
ip route replace default via "$ROUTER_IP"

mkdir -p /srv/www && head -c 1048576 /dev/urandom > /srv/www/1m.bin
cd /srv/www && python3 -m http.server 8000 --bind 0.0.0.0 > /var/log/http.log 2>&1 &
# 5201 for the integration suite; 5202/5203 for the background traffic generator.
iperf3 -s -D
iperf3 -s -p 5202 -D
iperf3 -s -p 5203 -D
if [ -n "${TRAFFIC_TARGETS:-}" ]; then
  /opt/sim/traffic.sh > /var/log/traffic.log 2>&1 &
fi
log "host up behind $ROUTER_IP ($(ip -o -4 addr show scope global | awk '{print $4}' | paste -sd, -))"
exec sleep infinity
