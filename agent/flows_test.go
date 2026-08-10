package main

import "testing"

const conntrackSample = `tcp      6 431999 ESTABLISHED src=10.10.5.20 dst=10.30.5.20 sport=41234 dport=5201 packets=1200 bytes=1800000 src=10.30.5.20 dst=10.10.5.20 sport=5201 dport=41234 packets=800 bytes=52000 [ASSURED] mark=0 use=1
udp      17 29 src=10.99.0.1 dst=10.99.0.3 sport=51820 dport=51820 packets=10 bytes=1480 src=10.99.0.3 dst=10.99.0.1 sport=51820 dport=51820 packets=9 bytes=1332 mark=0 use=1
unknown  2 590 src=10.10.0.2 dst=224.0.0.22 packets=5 bytes=200 [PERMANENT]
`

func TestParseConntrack(t *testing.T) {
	flows := parseConntrack(conntrackSample, 1000)
	if len(flows) != 2 {
		t.Fatalf("expected 2 flows (unknown proto skipped), got %d", len(flows))
	}
	f := flows[0]
	if f.Proto != "tcp" || f.Src != "10.10.5.20" || f.Dst != "10.30.5.20" || f.DstPort != 5201 {
		t.Fatalf("bad origin tuple: %+v", f)
	}
	// Both directions' counters are summed.
	if f.Bytes != 1852000 || f.Packets != 2000 {
		t.Fatalf("bad counters: %+v", f)
	}
	if f.Reported != 1000 {
		t.Fatalf("bad timestamp: %+v", f)
	}
}

const nftCountersSample = `{"nftables": [{"metainfo": {"version": "1.0.9"}}, {"counter": {"family": "inet", "name": "cnt_site_a_to_site_b", "table": "opnmesh", "handle": 1, "packets": 42, "bytes": 4200}}, {"counter": {"family": "inet", "name": "cnt_site_b_to_site_a", "table": "opnmesh", "handle": 2, "packets": 7, "bytes": 700}}]}`

func TestParseNftCounters(t *testing.T) {
	counters := parseNftCounters(nftCountersSample)
	if len(counters) != 2 {
		t.Fatalf("expected 2 counters, got %d", len(counters))
	}
	if counters[0].Name != "cnt_site_a_to_site_b" || counters[0].Bytes != 4200 || counters[0].Packets != 42 {
		t.Fatalf("bad counter: %+v", counters[0])
	}
}
