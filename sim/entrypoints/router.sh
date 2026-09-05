#!/bin/bash
# A site router that behaves like a UniFi gateway: Linux, ip_forward,
# stateful nftables firewall (established/related accepted, invalid dropped,
# LAN → anywhere allowed), masquerade to the WAN, optional DNAT port forwards.
#
# Static routes to remote subnets are NOT pre-provisioned: the integration
# suite applies exactly what OPNmesh's router page prints, proving the page.
#
# Env:
#   LAN_PREFIX   e.g. "10.0.1."       — the LAN this router serves
#   DNAT         e.g. "udp:51820:10.0.250.2,tcp:3000:10.0.1.10" (optional)
#   SEND_REDIRECTS  "0" (default) or "1" — whether to send ICMP redirects
set -eu
. /opt/sim/lib.sh

# sysctls are set by docker-compose at creation (/proc/sys is read-only here);
# these are belt and braces for other runtimes.
sysctl -qw net.ipv4.ip_forward=1 2>/dev/null || true
sysctl -qw net.ipv4.conf.all.send_redirects="${SEND_REDIRECTS:-0}" 2>/dev/null || true
[ "$(cat /proc/sys/net/ipv4/ip_forward)" = "1" ] || { echo "ip_forward is off; set it via compose sysctls" >&2; exit 1; }

WAN_IF="$(iface_for 198.51.100.)"
WAN_IP="$(ip -o -4 addr show dev "$WAN_IF" | awk '{print $4}' | cut -d/ -f1)"
LAN_IF="$(iface_for "$LAN_PREFIX")"
ip route replace default via 198.51.100.254 dev "$WAN_IF"

# Port forwards match the WAN address from any interface, so a LAN host
# reaching the public address is hairpinned like a UniFi gateway does.
DNAT_RULES=""
IFS=',' read -ra ENTRIES <<< "${DNAT:-}"
for e in "${ENTRIES[@]}"; do
  [ -n "$e" ] || continue
  proto="${e%%:*}"; rest="${e#*:}"; port="${rest%%:*}"; to="${rest#*:}"
  DNAT_RULES="$DNAT_RULES
    ip daddr $WAN_IP $proto dport $port dnat ip to $to:$port"
done

nft -f - <<EOF
table inet router {
  chain forward {
    type filter hook forward priority filter; policy drop;
    ct state established,related accept
    ct state invalid drop
    # LAN and any other internal interface may open connections anywhere.
    iifname != "$WAN_IF" accept
    # Port-forwarded inbound connections.
    ct status dnat accept
  }
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;$DNAT_RULES
  }
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    oifname "$WAN_IF" masquerade
  }
}
EOF

log "router up: wan=$WAN_IF ($WAN_IP) lan=$LAN_IF dnat='${DNAT:-none}' send_redirects=${SEND_REDIRECTS:-0}"
exec sleep infinity
