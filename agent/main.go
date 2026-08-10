// opnmesh-agent: pulls desired configuration from the control node and
// reconciles it onto this machine. The control node never dials in; if it is
// unreachable the agent holds last known good indefinitely and never tears
// down a working tunnel.
//
// Usage:
//
//	opnmesh-agent [-config /etc/opnmesh/agent.json]            run the poll loop
//	opnmesh-agent [-config ...] once                           single reconcile pass
//	opnmesh-agent [-config ...] rollback                       restore last-known-good config (offline)
//	opnmesh-agent [-config ...] rollback-update                flip back to the previous binary (offline)
//	opnmesh-agent version                                      print version
//	opnmesh-agent self-test                                    release self-test (exit 0 = healthy)
package main

import (
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"sync/atomic"
	"time"
)

// SharedState carries cross-goroutine agent status.
type SharedState struct {
	lastReportOK atomic.Int64
	// carried over from a failed update so the control node hears about it
	lastUpdateError atomic.Value
}

func (s *SharedState) LastReportOK() int64 { return s.lastReportOK.Load() }
func (s *SharedState) UpdateError() string {
	if v, ok := s.lastUpdateError.Load().(string); ok {
		return v
	}
	return ""
}

func main() {
	configPath := flag.String("config", "/etc/opnmesh/agent.json", "path to agent.json")
	flag.Parse()

	switch flag.Arg(0) {
	case "version":
		fmt.Println(version)
		return
	case "self-test":
		// Minimal release health check: the binary starts, parses its own
		// flags, and its core parsers work. Deliberately broken test builds
		// fail here or at commit-confirm.
		if listenPortOf("[Interface]\nListenPort = 1\n") != 1 {
			os.Exit(1)
		}
		fmt.Println("ok")
		return
	}

	cfg, err := LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("agent: %v", err)
	}
	rec := NewReconciler(cfg)

	switch flag.Arg(0) {
	case "rollback":
		if err := rec.Rollback(); err != nil {
			log.Fatalf("rollback: %v", err)
		}
		log.Print("rollback: restored last-known-good configuration")
		return
	case "rollback-update":
		st := loadUpdateState(cfg)
		prev := st.Prev
		if prev == "" || prev == version {
			log.Fatalf("rollback-update: no previous version recorded")
		}
		if err := flipTo(cfg, prev); err != nil {
			log.Fatalf("rollback-update: %v", err)
		}
		saveUpdateState(cfg, updateState{})
		log.Printf("rollback-update: flipped back to %s (restart the agent service)", prev)
		return
	case "once":
		client, err := newClient(cfg)
		if err != nil {
			log.Fatalf("agent: %v", err)
		}
		state := &SharedState{}
		rec.Fetch(client)
		rec.Apply()
		report(cfg, rec, client, state, 0)
		return
	case "":
		runLoop(cfg, rec)
	default:
		log.Fatalf("unknown command %q", flag.Arg(0))
	}
}

func newClient(cfg AgentConfig) (*APIClient, error) {
	token, err := cfg.Token()
	if err != nil {
		return nil, err
	}
	return NewAPIClient(cfg.ServerURL, token), nil
}

func runLoop(cfg AgentConfig, rec *Reconciler) {
	start := time.Now()
	state := &SharedState{}
	log.Printf("agent %s: polling %s every %s", version, cfg.ServerURL, cfg.PollInterval())
	if simulateBroken == "yes" {
		log.Print("agent: SIMULATED BROKEN BUILD — will never check in")
	}
	ensureSelfInstalled(cfg)

	// Post-exec bookkeeping: are we a freshly flipped-in version needing
	// commit-confirm, or the old version restored after a failed one?
	st := loadUpdateState(cfg)
	if st.Pending != "" && st.Pending == version {
		go confirmUpdate(cfg, rec, st, state)
	} else if st.Pending != "" && st.Pending != version {
		// Symlink points at us but a pending marker for another version
		// lingers (crash mid-switch) — clear it.
		saveUpdateState(cfg, updateState{FailedVersion: st.Pending, FailedReason: "interrupted switch"})
		st = loadUpdateState(cfg)
	}
	if st.FailedVersion != "" {
		state.lastUpdateError.Store(
			fmt.Sprintf("update to %s rolled back: %s", st.FailedVersion, st.FailedReason))
	}

	go bootWatchdog(cfg, rec, start)

	metrics := NewMetricsServer(cfg, rec)
	flowReporter := NewFlowReporter(cfg)
	for {
		settings := loadSettings(cfg.ConfDir)
		metrics.Ensure(settings.MetricsPort)
		client, err := newClient(cfg)
		if err != nil {
			// Token file missing/unreadable: nothing to do but wait; the
			// tunnel keeps running from on-disk config regardless.
			log.Printf("agent: %v", err)
		} else {
			rec.Fetch(client)
			rec.Apply()
			report(cfg, rec, client, state, int64(time.Since(start).Seconds()))
			flowReporter.MaybeReport(client, loadSettings(cfg.ConfDir))

			// Self-update path: separate from config reconcile, and only
			// when not already mid-confirm.
			if loadUpdateState(cfg).Pending == "" {
				if instr, err := client.FetchUpdate(); err == nil && instr != nil && instr.TargetVersion != version {
					if err := applyUpdate(cfg, rec, client, *instr); err != nil {
						log.Printf("update to %s failed before switch: %v", instr.TargetVersion, err)
						state.lastUpdateError.Store(
							fmt.Sprintf("update to %s failed pre-switch: %v", instr.TargetVersion, err))
					}
					// On success applyUpdate never returns (exec).
				}
			}
		}
		// Jitter so a fleet of agents does not thundering-herd the control node.
		jitter := time.Duration(rand.Int63n(int64(cfg.PollInterval() / 4)))
		time.Sleep(cfg.PollInterval() + jitter)
	}
}

func report(cfg AgentConfig, rec *Reconciler, client *APIClient, state *SharedState, uptime int64) {
	if simulateBroken == "yes" {
		return // test hook: a broken build that never checks in
	}
	nodeID := ""
	if rec.desired != nil {
		nodeID = rec.desired.NodeID
	}
	r := Report{
		NodeID:          nodeID,
		Version:         version,
		AppliedHash:     rec.DesiredHash(),
		DiskHash:        rec.DiskHash(),
		LastError:       rec.LastError(),
		LastUpdateError: state.UpdateError(),
		Peers:           wgPeerStats(cfg.WgInterface),
		AgentUptime:     uptime,
	}
	if err := client.SendReport(r); err != nil {
		log.Printf("report failed (control unreachable is fine): %v", err)
	} else {
		state.lastReportOK.Store(time.Now().Unix())
	}
}
