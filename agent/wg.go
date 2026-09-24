package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// ManagedFiles are the logical names the controller sends. Anything else is
// refused: the controller is authenticated, not trusted with paths.
var ManagedFiles = []string{"wireguard.conf", "nftables.conf", "sysctl.conf"}

func isManagedFile(name string) bool {
	for _, m := range ManagedFiles {
		if name == m {
			return true
		}
	}
	return false
}

// runCmd runs a command and returns its combined output. It is a variable so
// the tests can stand in for the host's tools.
var runCmd = runCommand

func runCommand(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// wgEntry is one line of a WireGuard config that matters, read the way
// wg-quick and validateWireGuard read it: everything from '#' is a comment,
// and section names and keys are compared without regard to case.
type wgEntry struct {
	section string // "interface", "peer", or "" before any section or in an unknown one
	start   bool   // the line opens a section; key and value are empty
	line    string // the line without its comment, trimmed
	key     string // lower case
	value   string
}

func wgEntries(conf string) []wgEntry {
	var out []wgEntry
	section := ""
	for _, raw := range strings.Split(conf, "\n") {
		line, key, value, hasEq := splitWgLine(raw)
		switch {
		case line == "":
		case strings.HasPrefix(line, "["):
			switch asciiLower(line) {
			case "[interface]":
				section = "interface"
			case "[peer]":
				section = "peer"
			default:
				section = ""
			}
			out = append(out, wgEntry{section: section, start: true, line: line})
		case hasEq:
			out = append(out, wgEntry{section: section, line: line, key: asciiLower(key), value: value})
		}
	}
	return out
}

// wgPeer is one [Peer] section: its key, endpoint and every AllowedIPs item
// in order.
type wgPeer struct {
	PublicKey  string
	Endpoint   string
	AllowedIPs []string
}

func wgPeers(conf string) []wgPeer {
	var peers []wgPeer
	var cur *wgPeer
	for _, e := range wgEntries(conf) {
		if e.start {
			cur = nil
			if e.section == "peer" {
				peers = append(peers, wgPeer{})
				cur = &peers[len(peers)-1]
			}
			continue
		}
		if cur == nil {
			continue
		}
		switch e.key {
		case "publickey":
			cur.PublicKey = e.value
		case "endpoint":
			cur.Endpoint = e.value
		case "allowedips":
			for _, item := range strings.Split(e.value, ",") {
				if item = strings.Trim(item, " \t"); item != "" {
					cur.AllowedIPs = append(cur.AllowedIPs, item)
				}
			}
		}
	}
	return peers
}

// interfaceSection returns the [Interface] block with comments stripped, so
// a peers-only change can be told apart from one that needs a restart.
func interfaceSection(conf string) string {
	var lines []string
	for _, e := range wgEntries(conf) {
		if e.section == "interface" && !e.start {
			lines = append(lines, e.line)
		}
	}
	return strings.Join(lines, "\n")
}

// interfaceValue returns the first value of key (lower case) in [Interface].
func interfaceValue(conf, key string) string {
	for _, e := range wgEntries(conf) {
		if e.section == "interface" && e.key == key {
			return e.value
		}
	}
	return ""
}

func listenPortOf(conf string) int {
	p, _ := strconv.Atoi(interfaceValue(conf, "listenport"))
	return p
}

// routeForm writes an IPv4 AllowedIPs item the way `ip route` prints it: a
// /32 as the bare address, a network in its canonical form. IPv6 items and
// anything unparseable are left out (the routes here are IPv4 only).
func routeForm(item string) (string, bool) {
	if a, err := netip.ParseAddr(item); err == nil && a.Is4() {
		return a.String(), true
	}
	p, err := netip.ParsePrefix(item)
	if err != nil || !p.Addr().Is4() {
		return "", false
	}
	if p.Bits() == 32 {
		return p.Addr().String(), true
	}
	return p.Masked().String(), true
}

// allowedPrefixes collects every IPv4 AllowedIPs prefix, normalised the way
// `ip route` prints them (a /32 becomes the bare address).
func allowedPrefixes(conf string) map[string]bool {
	out := map[string]bool{}
	for _, p := range wgPeers(conf) {
		for _, item := range p.AllowedIPs {
			if r, ok := routeForm(item); ok {
				out[r] = true
			}
		}
	}
	return out
}

// peerTunnelIPs maps each peer public key to the first AllowedIPs entry —
// by generation the peer's own tunnel address — for latency probes.
func peerTunnelIPs(conf string) map[string]string {
	out := map[string]string{}
	for _, p := range wgPeers(conf) {
		if p.PublicKey == "" || len(p.AllowedIPs) == 0 {
			continue
		}
		if ip, ok := routeForm(p.AllowedIPs[0]); ok && !strings.Contains(ip, "/") {
			out[p.PublicKey] = ip
		}
	}
	return out
}

// udpPortFree reports whether nothing on this host holds the UDP port. A
// variable so the tests do not depend on the ports free where they run.
var udpPortFree = func(port int) bool {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{Port: port})
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func wgInterfaceExists(iface string) bool {
	_, err := runCmd("wg", "show", iface)
	return err == nil
}

func wgQuickUp(confPath string) error {
	_, err := runCmd("wg-quick", "up", confPath)
	return err
}

func wgQuickDown(confPath string) error {
	_, err := runCmd("wg-quick", "down", confPath)
	return err
}

// privateKeyPathOf extracts the key path from the sanctioned PostUp line.
func privateKeyPathOf(conf string) string {
	for _, e := range wgEntries(conf) {
		if e.section == "interface" && e.key == "postup" {
			if m := allowedPostUp.FindStringSubmatch(e.value); m != nil {
				return m[1]
			}
		}
	}
	return ""
}

// injectPrivateKey adds a PrivateKey line to a stripped config. `wg syncconf`
// replaces the whole [Interface] section from the file, so a file without the
// key would clear the interface's key and silently kill every tunnel.
func injectPrivateKey(stripped, key string) string {
	key = strings.TrimSpace(key)
	if key == "" {
		return stripped
	}
	var out []string
	done := false
	for _, line := range strings.Split(stripped, "\n") {
		out = append(out, line)
		if !done && strings.TrimSpace(line) == "[Interface]" {
			out = append(out, "PrivateKey = "+key)
			done = true
		}
	}
	if !done {
		out = append([]string{"[Interface]", "PrivateKey = " + key}, out...)
	}
	return strings.Join(out, "\n")
}

// wgSyncPeers applies peer changes without recreating the interface. The
// private key is read from the gateway's own key file and included in the
// temporary config (root-only, deleted immediately) so syncconf keeps it.
func wgSyncPeers(iface, confPath, keyPath string) error {
	stripped, err := runCmd("wg-quick", "strip", confPath)
	if err != nil {
		return err
	}
	key := ""
	if keyPath != "" {
		data, err := os.ReadFile(keyPath)
		if err != nil {
			return fmt.Errorf("read private key: %w", err)
		}
		key = string(data)
	}
	tmp, err := os.CreateTemp("", "opnmesh-strip-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(injectPrivateKey(stripped, key)); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	if _, err := runCmd("wg", "syncconf", iface, tmp.Name()); err != nil {
		return err
	}
	return ensurePrivateKey(iface, keyPath)
}

// ensurePrivateKey restores the key if the interface has lost it for any
// reason. Cheap, and the difference between a tunnel and a dead interface.
func ensurePrivateKey(iface, keyPath string) error {
	if keyPath == "" || !wgInterfaceExists(iface) {
		return nil
	}
	out, err := runCmd("wg", "show", iface, "public-key")
	if err != nil {
		return err
	}
	if strings.TrimSpace(out) != "(none)" {
		return nil
	}
	_, err = runCmd("wg", "set", iface, "private-key", keyPath)
	return err
}

// --- routes ------------------------------------------------------------------

type ipRoute struct {
	Dst      string `json:"dst"`
	Protocol string `json:"protocol"`
}

func listRoutes(iface string) ([]ipRoute, error) {
	out, err := runCmd("ip", "-j", "-4", "route", "show", "dev", iface)
	if err != nil {
		return nil, err
	}
	return parseRoutes(out)
}

func parseRoutes(jsonText string) ([]ipRoute, error) {
	var routes []ipRoute
	if strings.TrimSpace(jsonText) == "" {
		return routes, nil
	}
	if err := json.Unmarshal([]byte(jsonText), &routes); err != nil {
		return nil, fmt.Errorf("parse routes: %w", err)
	}
	return routes, nil
}

// routePlan decides which routes to add and delete so the interface carries
// exactly the AllowedIPs prefixes, leaving the kernel's connected route
// alone and not duplicating prefixes it already covers (as wg-quick does).
// A default route on the interface is never desired (AllowedIPs may not hold
// one), so it is always deleted: it would send the host's internet traffic
// into the mesh.
func routePlan(desired map[string]bool, current []ipRoute) (add, del []string) {
	var connected []*net.IPNet
	managed := map[string]bool{}
	for _, r := range current {
		if r.Protocol == "kernel" {
			if _, n, err := net.ParseCIDR(withPrefix(r.Dst)); err == nil {
				connected = append(connected, n)
			}
			continue
		}
		dst := r.Dst
		if dst == "default" {
			dst = "0.0.0.0/0"
		}
		managed[dst] = true
	}
	for p := range desired {
		if managed[p] {
			continue
		}
		covered := false
		if ip, ipn, err := net.ParseCIDR(withPrefix(p)); err == nil {
			for _, c := range connected {
				if c.Contains(ip) && maskLen(c) <= maskLen(ipn) {
					covered = true
					break
				}
			}
		}
		if !covered {
			add = append(add, p)
		}
	}
	for m := range managed {
		if !desired[m] {
			del = append(del, m)
		}
	}
	sortStrings(add)
	sortStrings(del)
	return add, del
}

func withPrefix(p string) string {
	if strings.Contains(p, "/") {
		return p
	}
	return p + "/32"
}

func maskLen(n *net.IPNet) int {
	ones, _ := n.Mask.Size()
	return ones
}

// reconcileRoutes deletes the stale routes first, then adds the missing
// ones, and carries on past a failure so one bad route neither leaves stale
// ones behind nor keeps the others from being added. The first error is
// returned.
func reconcileRoutes(iface, conf string) error {
	current, err := listRoutes(iface)
	if err != nil {
		return err
	}
	add, del := routePlan(allowedPrefixes(conf), current)
	var firstErr error
	for _, p := range del {
		if _, err := runCmd("ip", "-4", "route", "del", withPrefix(p), "dev", iface); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	for _, p := range add {
		if _, err := runCmd("ip", "-4", "route", "add", withPrefix(p), "dev", iface); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// --- wg show dump ------------------------------------------------------------

type PeerStats struct {
	PublicKey       string
	Endpoint        string
	LatestHandshake int64
	RxBytes         int64
	TxBytes         int64
}

func wgDump(iface string) ([]PeerStats, error) {
	out, err := runCmd("wg", "show", iface, "dump")
	if err != nil {
		return nil, err
	}
	return parseWgDump(out), nil
}

// parseWgDump reads `wg show <if> dump`: the first line is the interface,
// each following line a peer (tab-separated: public key, preshared key,
// endpoint, allowed ips, latest handshake, rx, tx, keepalive).
func parseWgDump(text string) []PeerStats {
	var peers []PeerStats
	for i, line := range strings.Split(strings.TrimSpace(text), "\n") {
		if i == 0 || line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) < 7 {
			continue
		}
		hs, _ := strconv.ParseInt(f[4], 10, 64)
		rx, _ := strconv.ParseInt(f[5], 10, 64)
		tx, _ := strconv.ParseInt(f[6], 10, 64)
		ep := f[2]
		if ep == "(none)" {
			ep = ""
		}
		peers = append(peers, PeerStats{PublicKey: f[0], Endpoint: ep, LatestHandshake: hs, RxBytes: rx, TxBytes: tx})
	}
	return peers
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
