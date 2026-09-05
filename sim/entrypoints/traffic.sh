#!/bin/bash
# Background load with day-like swings, so the dashboard looks like a real
# network: for each target, a slow sine over a few minutes plus jitter and the
# occasional burst, sent as rate-limited iperf3 TCP to a dedicated server port
# (the integration suite keeps port 5201 for itself).
#
# TRAFFIC_TARGETS="ip:port:periodSeconds:phaseSeconds:peakMbit,..."
set -u
. /opt/sim/lib.sh
IFS=',' read -ra TARGETS <<< "${TRAFFIC_TARGETS:-}"
[ ${#TARGETS[@]} -gt 0 ] || exit 0
sleep 25 # let routes and tunnels settle first
start=$SECONDS
log "traffic generator: ${#TARGETS[@]} flow(s)"
while true; do
  t=$((SECONDS - start))
  for spec in "${TARGETS[@]}"; do
    IFS=':' read -r ip port period phase peak <<< "$spec"
    bw=$(awk -v t="$t" -v p="$period" -v ph="$phase" -v a="$peak" 'BEGIN {
      srand();
      v = a * (0.12 + 0.88 * (0.5 + 0.5 * sin(2 * 3.14159265 * (t + ph) / p)));
      v = v * (0.8 + 0.4 * rand());
      if (rand() < 0.07) v = v * 2.0;
      if (v < 0.2) v = 0.2;
      printf "%.2f", v
    }')
    ( iperf3 -c "$ip" -p "$port" -t 5 -b "${bw}M" >/dev/null 2>&1 ) &
  done
  wait
  sleep 0.3
done
