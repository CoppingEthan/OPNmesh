package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// ManagedFiles are the files the agent reconciles, relative to ConfDir.
var ManagedFiles = []string{"wg0.conf", "nftables.conf", "sysctl.conf", "agent-settings.json"}

func runCmd(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// interfaceSection returns the [Interface] block of a wg-quick config with
// comments and blank lines stripped, for change classification: an unchanged
// interface section means peers-only changes, applied via syncconf with no
// tunnel flap.
func interfaceSection(conf string) string {
	var lines []string
	in := false
	for _, raw := range strings.Split(conf, "\n") {
		line := strings.TrimSpace(raw)
		if line == "[Interface]" {
			in = true
			continue
		}
		if strings.HasPrefix(line, "[") && line != "[Interface]" {
			in = false
			continue
		}
		if in && line != "" && !strings.HasPrefix(line, "#") {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n")
}

// listenPortOf extracts ListenPort from a wg-quick config (0 if absent).
func listenPortOf(conf string) int {
	for _, raw := range strings.Split(conf, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "ListenPort") {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				if p, err := strconv.Atoi(strings.TrimSpace(parts[1])); err == nil {
					return p
				}
			}
		}
	}
	return 0
}

// privateKeyPathOf extracts the key path from the generated
// "PostUp = wg set %i private-key <path>" line.
func privateKeyPathOf(conf string) string {
	for _, raw := range strings.Split(conf, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "PostUp") && strings.Contains(line, "private-key") {
			fields := strings.Fields(line)
			return fields[len(fields)-1]
		}
	}
	return ""
}

// udpPortFree reports whether the agent can bind the given UDP port right
// now. Pre-flight for port changes: never apply a config that cannot bind
// and leave the node dark.
func udpPortFree(port int) bool {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{Port: port})
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// wgUp brings the interface up from the given config path.
func wgUp(confPath string) error {
	_, err := runCmd("wg-quick", "up", confPath)
	return err
}

func wgDown(confPath string) error {
	_, err := runCmd("wg-quick", "down", confPath)
	return err
}

func wgInterfaceExists(iface string) bool {
	err := exec.Command("wg", "show", iface).Run()
	return err == nil
}

// allowedPrefixes collects every AllowedIPs prefix in a config, normalized
// the way `ip route show` prints them (/32 becomes a bare address).
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
			prefix := strings.TrimSpace(p)
			prefix = strings.TrimSuffix(prefix, "/32")
			if prefix != "" {
				out[prefix] = true
			}
		}
	}
	return out
}

// syncRoutes reconciles the kernel routes on the wg interface with the
// config's AllowedIPs. wg-quick installs routes only at `up`; peer changes
// applied via syncconf update crypto but NOT routing — without this, a newly
// added peer is crypto-reachable yet unrouted, which is a silent black hole.
// Connected/kernel-managed routes (the interface's own subnet) are left alone.
func syncRoutes(iface, conf string) error {
	desired := allowedPrefixes(conf)
	out, err := runCmd("ip", "-4", "route", "show", "dev", iface)
	if err != nil {
		return err
	}
	current := map[string]bool{}
	for _, raw := range strings.Split(strings.TrimSpace(out), "\n") {
		if raw == "" || strings.Contains(raw, "proto kernel") {
			continue
		}
		fields := strings.Fields(raw)
		if len(fields) > 0 {
			current[fields[0]] = true
		}
	}
	for p := range desired {
		if !current[p] {
			if _, err := runCmd("ip", "-4", "route", "replace", p, "dev", iface); err != nil {
				return err
			}
		}
	}
	for c := range current {
		if !desired[c] {
			if _, err := runCmd("ip", "-4", "route", "del", c, "dev", iface); err != nil {
				return err
			}
		}
	}
	return nil
}

// wgSyncPeers applies peer-level changes without recreating the interface:
// existing peers with unchanged parameters keep their sessions. The private
// key is re-asserted afterwards because the generated config never carries it
// inline, and kernel routes are reconciled because syncconf does not touch
// routing.
func wgSyncPeers(iface, confPath, keyPath string) error {
	stripped, err := runCmd("wg-quick", "strip", confPath)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp("", "wgsync-*.conf")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(stripped); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	if _, err := runCmd("wg", "syncconf", iface, tmp.Name()); err != nil {
		return err
	}
	if keyPath != "" {
		if _, err := runCmd("wg", "set", iface, "private-key", keyPath); err != nil {
			return err
		}
	}
	conf, err := os.ReadFile(confPath)
	if err != nil {
		return err
	}
	return syncRoutes(iface, string(conf))
}

// wgPeerStats parses `wg show <if> dump`.
func wgPeerStats(iface string) []PeerStat {
	out, err := runCmd("wg", "show", iface, "dump")
	if err != nil {
		return nil
	}
	var stats []PeerStat
	lines := strings.Split(strings.TrimSpace(out), "\n")
	// First line is the interface itself; peers follow.
	for _, line := range lines[1:] {
		f := strings.Split(line, "\t")
		if len(f) < 8 {
			continue
		}
		hs, _ := strconv.ParseInt(f[4], 10, 64)
		rx, _ := strconv.ParseInt(f[5], 10, 64)
		tx, _ := strconv.ParseInt(f[6], 10, 64)
		stats = append(stats, PeerStat{
			PublicKey:       f[0],
			Endpoint:        f[2],
			LatestHandshake: hs,
			RxBytes:         rx,
			TxBytes:         tx,
		})
	}
	return stats
}

func applyNftables(path string) error {
	_, err := runCmd("nft", "-f", path)
	return err
}

func applySysctl(path string) {
	// Apply key-by-key with -w (portable across busybox/procps sysctl).
	// Best-effort: containers may not allow every key; a real node will.
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		kv := strings.Replace(line, " = ", "=", 1)
		_ = exec.Command("sysctl", "-w", kv).Run()
	}
}

func writeFileAtomic(path, content string, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".opnmesh-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Chmod(name, mode); err != nil {
		os.Remove(name)
		return err
	}
	return os.Rename(name, path)
}
