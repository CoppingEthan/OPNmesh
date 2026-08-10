package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// AgentSettings mirrors the generator's agent-settings.json — a reconciled
// file, so the control panel can retune the exporter and flow collection
// without touching the agent binary or restarting anything.
type AgentSettings struct {
	MetricsPort     int  `json:"metrics_port"`
	Flows           bool `json:"flows"`
	FlowIntervalSec int  `json:"flow_interval_sec"`
	NeedsReresolve  bool `json:"needs_reresolve"`
}

func defaultSettings() AgentSettings {
	return AgentSettings{MetricsPort: 9586, Flows: false, FlowIntervalSec: 30}
}

func loadSettings(confDir string) AgentSettings {
	s := defaultSettings()
	data, err := os.ReadFile(filepath.Join(confDir, "agent-settings.json"))
	if err != nil {
		return s
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return defaultSettings()
	}
	if s.MetricsPort < 1 || s.MetricsPort > 65535 {
		s.MetricsPort = 9586
	}
	if s.FlowIntervalSec < 5 {
		s.FlowIntervalSec = 30
	}
	return s
}

// MetricsServer exposes tier-1 (wg peer counters/handshakes) and tier-2
// (nftables site-pair counters) plus agent health as Prometheus text format.
// It follows the settings file across reconciles, rebinding when the port
// changes.
type MetricsServer struct {
	cfg AgentConfig
	rec *Reconciler

	mu     sync.Mutex
	server *http.Server
	port   int
}

func NewMetricsServer(cfg AgentConfig, rec *Reconciler) *MetricsServer {
	return &MetricsServer{cfg: cfg, rec: rec}
}

// Ensure (re)starts the listener if the configured port changed.
func (m *MetricsServer) Ensure(port int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.server != nil && m.port == port {
		return
	}
	if m.server != nil {
		_ = m.server.Close()
		m.server = nil
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", m.handleMetrics)
	srv := &http.Server{Addr: fmt.Sprintf(":%d", port), Handler: mux}
	m.server = srv
	m.port = port
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("metrics listener on :%d failed: %v", port, err)
		}
	}()
	log.Printf("metrics exporter listening on :%d", port)
}

func promEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(s)
}

func (m *MetricsServer) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	var b strings.Builder

	b.WriteString("# TYPE wireguard_peer_latest_handshake_seconds gauge\n")
	b.WriteString("# TYPE wireguard_peer_rx_bytes_total counter\n")
	b.WriteString("# TYPE wireguard_peer_tx_bytes_total counter\n")
	for _, p := range wgPeerStats(m.cfg.WgInterface) {
		l := fmt.Sprintf(`{public_key="%s"}`, promEscape(p.PublicKey))
		fmt.Fprintf(&b, "wireguard_peer_latest_handshake_seconds%s %d\n", l, p.LatestHandshake)
		fmt.Fprintf(&b, "wireguard_peer_rx_bytes_total%s %d\n", l, p.RxBytes)
		fmt.Fprintf(&b, "wireguard_peer_tx_bytes_total%s %d\n", l, p.TxBytes)
	}

	b.WriteString("# TYPE opnmesh_nft_counter_bytes counter\n")
	b.WriteString("# TYPE opnmesh_nft_counter_packets counter\n")
	for _, c := range nftCounters() {
		l := fmt.Sprintf(`{name="%s"}`, promEscape(c.Name))
		fmt.Fprintf(&b, "opnmesh_nft_counter_bytes%s %d\n", l, c.Bytes)
		fmt.Fprintf(&b, "opnmesh_nft_counter_packets%s %d\n", l, c.Packets)
	}

	b.WriteString("# TYPE opnmesh_agent_port_bind_error gauge\n")
	bindErr := 0
	if strings.Contains(m.rec.LastError(), "already bound") {
		bindErr = 1
	}
	fmt.Fprintf(&b, "opnmesh_agent_port_bind_error %d\n", bindErr)
	b.WriteString("# TYPE opnmesh_agent_reconcile_error gauge\n")
	recErr := 0
	if m.rec.LastError() != "" {
		recErr = 1
	}
	fmt.Fprintf(&b, "opnmesh_agent_reconcile_error %d\n", recErr)
	fmt.Fprintf(&b, "# TYPE opnmesh_agent_scrape_timestamp_seconds gauge\nopnmesh_agent_scrape_timestamp_seconds %d\n", time.Now().Unix())

	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = w.Write([]byte(b.String()))
}

// NftCounter is one named counter from the opnmesh table.
type NftCounter struct {
	Name    string
	Bytes   int64
	Packets int64
}

// nftCounters reads `nft -j list counters table inet opnmesh`.
func nftCounters() []NftCounter {
	out, err := runCmd("nft", "-j", "list", "counters", "table", "inet", "opnmesh")
	if err != nil {
		return nil
	}
	return parseNftCounters(out)
}

func parseNftCounters(jsonText string) []NftCounter {
	var doc struct {
		Nftables []map[string]json.RawMessage `json:"nftables"`
	}
	if err := json.Unmarshal([]byte(jsonText), &doc); err != nil {
		return nil
	}
	var counters []NftCounter
	for _, entry := range doc.Nftables {
		raw, ok := entry["counter"]
		if !ok {
			continue
		}
		var c struct {
			Name    string `json:"name"`
			Bytes   int64  `json:"bytes"`
			Packets int64  `json:"packets"`
		}
		if err := json.Unmarshal(raw, &c); err != nil || c.Name == "" {
			continue
		}
		counters = append(counters, NftCounter{Name: c.Name, Bytes: c.Bytes, Packets: c.Packets})
	}
	return counters
}
