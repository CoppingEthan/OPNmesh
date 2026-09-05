#!/bin/bash
# An OPNmesh gateway VM. Waits for the integration suite to drop a one-time
# enrolment token into /etc/opnmesh/enrol.token, runs the real installer
# (with the locally staged binary, no systemd), then runs the agent exactly
# as the systemd unit would.
#
# Env: ROUTER_IP, CONTROLLER_URL
set -eu
. /opt/sim/lib.sh

sysctl -qw net.ipv4.conf.all.rp_filter=2 || true
ip route replace default via "$ROUTER_IP"
mkdir -p /etc/opnmesh

if [ ! -f /etc/opnmesh/agent.json ]; then
  log "waiting for /etc/opnmesh/enrol.token"
  while [ ! -s /etc/opnmesh/enrol.token ]; do sleep 1; done
  TOKEN="$(tr -d '[:space:]' < /etc/opnmesh/enrol.token)"
  log "enrolling with $CONTROLLER_URL"
  until bash /opt/opnmesh/install.sh --token "$TOKEN" --controller "$CONTROLLER_URL" \
        --insecure-http --binary /opt/opnmesh/opnmesh-gw --no-deps --no-start; do
    log "install failed; retrying in 3s"
    sleep 3
  done
  rm -f /etc/opnmesh/enrol.token
else
  # Rebooted VM: bring the tunnel up from disk before the agent starts, as
  # opnmesh-wg.service does. No controller needed. (A recreated container has
  # lost /usr/local/bin; a real VM keeps it.)
  [ -x /usr/local/bin/opnmesh-gw ] || install -m 0755 /opt/opnmesh/opnmesh-gw /usr/local/bin/opnmesh-gw
  /usr/local/bin/opnmesh-gw up || true
fi

exec /usr/local/bin/opnmesh-gw run
