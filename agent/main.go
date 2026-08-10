// opnmesh-agent: pulls desired configuration from the control node and
// reconciles it onto this machine. The control node never dials in; if it is
// unreachable the agent holds last known good indefinitely and never tears
// down a working tunnel.
//
// Usage:
//
//	opnmesh-agent [-config /etc/opnmesh/agent.json]            run the poll loop
//	opnmesh-agent [-config ...] once                           single reconcile pass
//	opnmesh-agent [-config ...] rollback                       restore last-known-good (offline)
package main

import (
	"flag"
	"log"
	"math/rand"
	"time"
)

func main() {
	configPath := flag.String("config", "/etc/opnmesh/agent.json", "path to agent.json")
	flag.Parse()

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
	case "once":
		client, err := newClient(cfg)
		if err != nil {
			log.Fatalf("agent: %v", err)
		}
		rec.Fetch(client)
		rec.Apply()
		report(cfg, rec, client)
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
	log.Printf("agent: polling %s every %s", cfg.ServerURL, cfg.PollInterval())
	start := time.Now()
	for {
		client, err := newClient(cfg)
		if err != nil {
			// Token file missing/unreadable: nothing to do but wait; the
			// tunnel keeps running from on-disk config regardless.
			log.Printf("agent: %v", err)
		} else {
			rec.Fetch(client)
			rec.Apply()
			reportWithUptime(cfg, rec, client, int64(time.Since(start).Seconds()))
		}
		// Jitter so a fleet of agents does not thundering-herd the control node.
		jitter := time.Duration(rand.Int63n(int64(cfg.PollInterval() / 4)))
		time.Sleep(cfg.PollInterval() + jitter)
	}
}

func report(cfg AgentConfig, rec *Reconciler, client *APIClient) {
	reportWithUptime(cfg, rec, client, 0)
}

func reportWithUptime(cfg AgentConfig, rec *Reconciler, client *APIClient, uptime int64) {
	nodeID := ""
	if rec.desired != nil {
		nodeID = rec.desired.NodeID
	}
	r := Report{
		NodeID:      nodeID,
		AppliedHash: rec.DesiredHash(),
		DiskHash:    rec.DiskHash(),
		LastError:   rec.LastError(),
		Peers:       wgPeerStats(cfg.WgInterface),
		AgentUptime: uptime,
	}
	if err := client.SendReport(r); err != nil {
		log.Printf("report failed (control unreachable is fine): %v", err)
	}
}
