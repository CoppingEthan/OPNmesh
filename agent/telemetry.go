package main

import (
	"encoding/json"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// Report mirrors the controller's telemetry schema exactly.
type Report struct {
	Version       string          `json:"version"`
	UptimeSeconds int64           `json:"uptimeSeconds"`
	AppliedHash   string          `json:"appliedHash"`
	DiskHash      string          `json:"diskHash"`
	LastError     string          `json:"lastError"`
	InterfaceUp   bool            `json:"interfaceUp"`
	Peers         []PeerReport    `json:"peers"`
	Counters      []CounterReport `json:"counters"`
	Host          HostReport      `json:"host"`
}

type PeerReport struct {
	PublicKey       string   `json:"publicKey"`
	Endpoint        *string  `json:"endpoint"`
	LatestHandshake int64    `json:"latestHandshake"`
	RxBytes         int64    `json:"rxBytes"`
	TxBytes         int64    `json:"txBytes"`
	RttMs           *float64 `json:"rttMs"`
}

type CounterReport struct {
	Name    string `json:"name"`
	Bytes   int64  `json:"bytes"`
	Packets int64  `json:"packets"`
}

type HostReport struct {
	Load1      *float64 `json:"load1"`
	MemUsedPct *float64 `json:"memUsedPct"`
	Addresses  []string `json:"addresses"`
	Kernel     string   `json:"kernel"`
}

func collectReport(cfg Config, started time.Time, appliedHash, lastError string) Report {
	meta := cfg.loadMeta()
	iface := meta.Interface
	files := diskFiles(cfg, iface)
	r := Report{
		Version:       version,
		UptimeSeconds: int64(time.Since(started).Seconds()),
		AppliedHash:   appliedHash,
		DiskHash:      hashFiles(files),
		LastError:     lastError,
		Peers:         []PeerReport{},
		Counters:      []CounterReport{},
		Host:          hostFacts(),
	}
	if !wgInterfaceExists(iface) {
		return r
	}
	r.InterfaceUp = true
	stats, err := wgDump(iface)
	if err == nil {
		// Probe every peer that has an endpoint (known, or learned from a
		// handshake). A reachable↔reachable pair has no keepalive, so nothing
		// would ever trigger its first handshake without this: the probe is
		// the packet that brings the tunnel up and then proves it end to end.
		targets := peerTunnelIPs(files["wireguard.conf"])
		probe := map[string]string{}
		for _, p := range stats {
			if ip, ok := targets[p.PublicKey]; ok && (p.Endpoint != "" || p.LatestHandshake > 0) {
				probe[p.PublicKey] = ip
			}
		}
		rtts := pingAll(probe, 1500*time.Millisecond)
		for _, p := range stats {
			pr := PeerReport{PublicKey: p.PublicKey, LatestHandshake: p.LatestHandshake, RxBytes: p.RxBytes, TxBytes: p.TxBytes}
			if p.Endpoint != "" {
				ep := p.Endpoint
				pr.Endpoint = &ep
			}
			if ms, ok := rtts[p.PublicKey]; ok {
				v := ms
				pr.RttMs = &v
			}
			r.Peers = append(r.Peers, pr)
		}
	}
	if counters, err := nftCounters(); err == nil {
		r.Counters = counters
	}
	return r
}

// nftCounters reads the named counters in table inet opnmesh.
func nftCounters() ([]CounterReport, error) {
	out, err := runCmd("nft", "-j", "list", "counters", "table", "inet", "opnmesh")
	if err != nil {
		return nil, err
	}
	return parseNftCounters(out)
}

func parseNftCounters(jsonText string) ([]CounterReport, error) {
	var doc struct {
		Nftables []struct {
			Counter *struct {
				Name    string `json:"name"`
				Packets int64  `json:"packets"`
				Bytes   int64  `json:"bytes"`
			} `json:"counter"`
		} `json:"nftables"`
	}
	if err := json.Unmarshal([]byte(jsonText), &doc); err != nil {
		return nil, err
	}
	out := []CounterReport{}
	for _, e := range doc.Nftables {
		if e.Counter != nil {
			out = append(out, CounterReport{Name: e.Counter.Name, Bytes: e.Counter.Bytes, Packets: e.Counter.Packets})
		}
	}
	return out, nil
}

func hostFacts() HostReport {
	h := HostReport{Addresses: []string{}}
	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		if f := strings.Fields(string(data)); len(f) > 0 {
			if v, err := strconv.ParseFloat(f[0], 64); err == nil {
				h.Load1 = &v
			}
		}
	}
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		var total, avail float64
		for _, line := range strings.Split(string(data), "\n") {
			f := strings.Fields(line)
			if len(f) < 2 {
				continue
			}
			v, _ := strconv.ParseFloat(f[1], 64)
			switch f[0] {
			case "MemTotal:":
				total = v
			case "MemAvailable:":
				avail = v
			}
		}
		if total > 0 {
			pct := (total - avail) / total * 100
			h.MemUsedPct = &pct
		}
	}
	if data, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		h.Kernel = strings.TrimSpace(string(data))
	}
	h.Addresses = globalIPv4Addresses()
	return h
}

func globalIPv4Addresses() []string {
	out := []string{}
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, i := range ifaces {
		if i.Flags&net.FlagLoopback != 0 || i.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := i.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok {
				if v4 := n.IP.To4(); v4 != nil && !v4.IsLoopback() && !v4.IsLinkLocalUnicast() {
					ones, _ := n.Mask.Size()
					out = append(out, v4.String()+"/"+strconv.Itoa(ones))
				}
			}
		}
	}
	return out
}
