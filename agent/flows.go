package main

import (
	"log"
	"strconv"
	"strings"
	"time"
)

// Tier-3 flow records (§13): who talked to whom, sourced from conntrack
// accounting. Opt-in per gateway via agent-settings.json; when enabled, the
// agent periodically snapshots the conntrack table and reports flows to the
// control node, which stores them with a retention window. These never go to
// Prometheus — per-host, per-port series are unbounded cardinality.

// FlowRecord is one aggregated conntrack entry.
type FlowRecord struct {
	Proto    string `json:"proto"`
	Src      string `json:"src"`
	Dst      string `json:"dst"`
	DstPort  int    `json:"dstPort"`
	Bytes    int64  `json:"bytes"`
	Packets  int64  `json:"packets"`
	Reported int64  `json:"reported"`
}

// collectFlows parses `conntrack -L` output (one line per flow, both
// directions' counters when nf_conntrack_acct=1).
func collectFlows() []FlowRecord {
	out, err := runCmd("conntrack", "-L")
	if err != nil {
		log.Printf("flows: conntrack unavailable: %v", err)
		return nil
	}
	return parseConntrack(out, time.Now().Unix())
}

// parseConntrack extracts origin-direction src/dst/dport and sums both
// directions' byte/packet counters.
func parseConntrack(out string, now int64) []FlowRecord {
	var flows []FlowRecord
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		proto := fields[0]
		if proto != "tcp" && proto != "udp" && proto != "icmp" {
			continue
		}
		var src, dst string
		var dport int
		var bytes, packets int64
		seenReply := false
		for _, f := range fields {
			switch {
			case strings.HasPrefix(f, "src="):
				if src == "" {
					src = f[4:]
				} else {
					seenReply = true
				}
			case strings.HasPrefix(f, "dst="):
				if !seenReply && dst == "" {
					dst = f[4:]
				}
			case strings.HasPrefix(f, "dport="):
				if dport == 0 {
					dport, _ = strconv.Atoi(f[6:])
				}
			case strings.HasPrefix(f, "bytes="):
				v, _ := strconv.ParseInt(f[6:], 10, 64)
				bytes += v
			case strings.HasPrefix(f, "packets="):
				v, _ := strconv.ParseInt(f[8:], 10, 64)
				packets += v
			}
		}
		if src == "" || dst == "" {
			continue
		}
		flows = append(flows, FlowRecord{
			Proto:    proto,
			Src:      src,
			Dst:      dst,
			DstPort:  dport,
			Bytes:    bytes,
			Packets:  packets,
			Reported: now,
		})
	}
	return flows
}

// FlowReporter posts flow snapshots while enabled in settings.
type FlowReporter struct {
	cfg      AgentConfig
	lastSent time.Time
}

func NewFlowReporter(cfg AgentConfig) *FlowReporter {
	return &FlowReporter{cfg: cfg}
}

func (f *FlowReporter) MaybeReport(client *APIClient, settings AgentSettings) {
	if !settings.Flows {
		return
	}
	if time.Since(f.lastSent) < time.Duration(settings.FlowIntervalSec)*time.Second {
		return
	}
	flows := collectFlows()
	if flows == nil {
		return
	}
	if err := client.SendFlows(flows); err != nil {
		log.Printf("flow report failed: %v", err)
		return
	}
	f.lastSent = time.Now()
}
