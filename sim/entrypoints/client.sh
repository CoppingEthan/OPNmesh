#!/bin/bash
# A roaming client on the internet: an ordinary WireGuard install. Brings
# up whatever config the integration suite writes to /etc/opnmesh/client.conf
# and re-applies it whenever the file changes (rotate / restrict / disable).
set -eu
. /opt/sim/lib.sh
mkdir -p /etc/opnmesh
log "waiting for /etc/opnmesh/client.conf"
last=""
while true; do
  if [ -s /etc/opnmesh/client.conf ]; then
    sum="$(sha256sum /etc/opnmesh/client.conf | cut -d' ' -f1)"
    if [ "$sum" != "$last" ]; then
      wg-quick down /etc/opnmesh/client.conf 2>/dev/null || true
      # wg-quick refuses configs with "world accessible" perms only with a warning.
      cp /etc/opnmesh/client.conf /tmp/client.conf && chmod 600 /tmp/client.conf
      if wg-quick up /tmp/client.conf; then
        log "client config applied ($sum)"
      else
        log "client config failed to apply"
      fi
      last="$sum"
    fi
  elif [ -n "$last" ]; then
    wg-quick down /tmp/client.conf 2>/dev/null || true
    last=""
    log "client config removed; tunnel down"
  fi
  sleep 1
done
