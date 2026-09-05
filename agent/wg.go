package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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

// allowedPostUp is the only hook the controller may place in the WireGuard
// config: loading this gateway's own private key from a path under ConfDir.
var allowedPostUp = regexp.MustCompile(`^PostUp\s*=\s*wg set %i private-key ([A-Za-z0-9._/-]+)$`)

// validateHooks refuses any wg-quick hook other than the sanctioned PostUp.
// wg-quick runs hooks as root through a shell, so without this a compromised
// controller would have root on every gateway.
func validateHooks(conf, confDir string) error {
	confDir = filepath.Clean(confDir)
	for _, raw := range strings.Split(conf, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(line[:eq]))
		switch key {
		case "preup", "predown", "postdown":
			return fmt.Errorf("refusing config: %s hook present", strings.TrimSpace(line[:eq]))
		case "postup":
			m := allowedPostUp.FindStringSubmatch(line)
			if m == nil {
				return fmt.Errorf("refusing config: PostUp may only load the private key, got %q", line)
			}
			p := filepath.Clean(m[1])
			if p != confDir && !strings.HasPrefix(p, confDir+string(os.PathSeparator)) {
				return fmt.Errorf("refusing config: private-key path %q is outside %s", m[1], confDir)
			}
		case "privatekey":
			return fmt.Errorf("refusing config: it contains a PrivateKey line")
		}
	}
	return nil
}

func runCmd(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// interfaceSection returns the [Interface] block with comments stripped, so
// a peers-only change can be told apart from one that needs a restart.
func interfaceSection(conf string) string {
	var lines []string
	in := false
	for _, raw := range strings.Split(conf, "\n") {
		line := strings.TrimSpace(raw)
		if line == "[Interface]" {
			in = true
			continue
		}
		if strings.HasPrefix(line, "[") {
			in = false
			continue
		}
		if in && line != "" && !strings.HasPrefix(line, "#") {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n")
}

func confValue(conf, key string) string {
	for _, raw := range strings.Split(conf, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, key) {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 && strings.TrimSpace(parts[0]) == key {
				return strings.TrimSpace(parts[1])
			}
		}
	}
	return ""
}

func listenPortOf(conf string) int {
	p, _ := strconv.Atoi(confValue(conf, "ListenPort"))
	return p
}

// allowedPrefixes collects every AllowedIPs prefix, normalised the way
// `ip route` prints them (a /32 becomes the bare address).
func allowedPrefixes(conf string) map[string]bool {
	out := map[string]bool{}
	for _, raw := range strings.Split(conf, "\n") {
		line := strings.TrimSpace(raw)
		if !strings.HasPrefix(line, "AllowedIPs") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		for _, p := range strings.Split(parts[1], ",") {
			prefix := strings.TrimSuffix(strings.TrimSpace(p), "/32")
			if prefix != "" {
				out[prefix] = true
			}
		}
	}
	return out
}

// peerTunnelIPs maps each peer public key to the first AllowedIPs entry —
// by generation the peer's own tunnel address — for latency probes.
func peerTunnelIPs(conf string) map[string]string {
	out := map[string]string{}
	var key string
	for _, raw := range strings.Split(conf, "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case line == "[Peer]":
			key = ""
		case strings.HasPrefix(line, "PublicKey"):
			key = confValue(line, "PublicKey")
		case strings.HasPrefix(line, "AllowedIPs") && key != "":
			first := strings.TrimSpace(strings.SplitN(strings.SplitN(line, "=", 2)[1], ",", 2)[0])
			ip := strings.TrimSuffix(first, "/32")
			if !strings.Contains(ip, "/") {
				out[key] = ip
			}
			key = ""
		}
	}
	return out
}

func udpPortFree(port int) bool {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{Port: port})
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func wgInterfaceExists(iface string) bool {
	return exec.Command("wg", "show", iface).Run() == nil
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
	for _, raw := range strings.Split(conf, "\n") {
		if m := allowedPostUp.FindStringSubmatch(strings.TrimSpace(raw)); m != nil {
			return m[1]
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
		if r.Dst == "default" {
			continue
		}
		managed[r.Dst] = true
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

func reconcileRoutes(iface, conf string) error {
	current, err := listRoutes(iface)
	if err != nil {
		return err
	}
	add, del := routePlan(allowedPrefixes(conf), current)
	for _, p := range add {
		if _, err := runCmd("ip", "-4", "route", "add", withPrefix(p), "dev", iface); err != nil {
			return err
		}
	}
	for _, p := range del {
		if _, err := runCmd("ip", "-4", "route", "del", withPrefix(p), "dev", iface); err != nil {
			return err
		}
	}
	return nil
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
