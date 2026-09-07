package main

import (
	"log"
	"net"
	"strings"
	"time"
)

// WireGuard resolves a peer's Endpoint hostname once, when the peer is set.
// A site behind a dynamic public address therefore drops off the mesh when
// its address changes, until something sets the endpoint again. This is the
// same remedy as wg-quick's contrib reresolve-dns script: for every peer
// whose Endpoint is a name, re-apply that endpoint (which resolves it
// afresh) whenever the handshake has gone stale.

// Handshakes repeat about every two minutes while a tunnel is healthy, so a
// handshake older than this means the peer is not answering; 135 s is the
// threshold reresolve-dns uses.
const reresolveAfter = 135 * time.Second

// A peer that is simply down must not cost a DNS lookup on every tick.
const reresolveEvery = 30 * time.Second

type hostnamePeer struct {
	PublicKey string
	Endpoint  string // host:port exactly as written in the config
}

// hostnamePeers returns the peers whose Endpoint is a DNS name rather than an
// IP literal, in config order.
func hostnamePeers(conf string) []hostnamePeer {
	var out []hostnamePeer
	var key, endpoint string
	flush := func() {
		if key != "" && endpoint != "" && endpointIsHostname(endpoint) {
			out = append(out, hostnamePeer{PublicKey: key, Endpoint: endpoint})
		}
		key, endpoint = "", ""
	}
	for _, raw := range strings.Split(conf, "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case strings.HasPrefix(line, "["):
			flush()
		case strings.HasPrefix(line, "PublicKey"):
			key = confValue(line, "PublicKey")
		case strings.HasPrefix(line, "Endpoint"):
			endpoint = confValue(line, "Endpoint")
		}
	}
	flush()
	return out
}

func endpointIsHostname(endpoint string) bool {
	host, _, err := net.SplitHostPort(endpoint)
	if err != nil {
		return false
	}
	return host != "" && net.ParseIP(host) == nil
}

// staleHostnamePeers picks the hostname peers that are on the interface and
// whose latest handshake is missing or older than reresolveAfter.
func staleHostnamePeers(peers []hostnamePeer, stats []PeerStats, now time.Time) []hostnamePeer {
	last := map[string]int64{}
	for _, s := range stats {
		last[s.PublicKey] = s.LatestHandshake
	}
	var out []hostnamePeer
	for _, p := range peers {
		hs, known := last[p.PublicKey]
		if !known {
			continue
		}
		if hs == 0 || now.Sub(time.Unix(hs, 0)) > reresolveAfter {
			out = append(out, p)
		}
	}
	return out
}

// reresolver remembers when each peer's endpoint was last re-applied.
type reresolver struct {
	lastAttempt map[string]time.Time
}

func newReresolver() *reresolver { return &reresolver{lastAttempt: map[string]time.Time{}} }

// run re-applies the endpoint of every stale hostname peer, at most once per
// peer per reresolveEvery. A name that does not resolve right now is logged
// and tried again on a later tick.
func (r *reresolver) run(iface, conf string) {
	peers := hostnamePeers(conf)
	if len(peers) == 0 || !wgInterfaceExists(iface) {
		return
	}
	stats, err := wgDump(iface)
	if err != nil {
		return
	}
	now := time.Now()
	for _, p := range staleHostnamePeers(peers, stats, now) {
		if now.Sub(r.lastAttempt[p.PublicKey]) < reresolveEvery {
			continue
		}
		r.lastAttempt[p.PublicKey] = now
		if _, err := runCmd("wg", "set", iface, "peer", p.PublicKey, "endpoint", p.Endpoint); err != nil {
			log.Printf("re-resolve %s: %v", p.Endpoint, err)
		}
	}
}
