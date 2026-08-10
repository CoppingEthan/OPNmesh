package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Reconciler compares desired state to on-disk state and applies only the
// differences. Core rules (§8 of the brief):
//   - An unchanged config produces no writes and never restarts the tunnel.
//   - When the control node is unreachable, hold last known good indefinitely.
//   - Never apply a config whose listen port cannot be bound.
type Reconciler struct {
	cfg     AgentConfig
	desired *DesiredConfig // last successfully fetched config (last known good)
	lastErr string
}

func NewReconciler(cfg AgentConfig) *Reconciler {
	return &Reconciler{cfg: cfg}
}

func hashFiles(files map[string]string) string {
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	h := sha256.New()
	for _, n := range names {
		fmt.Fprintf(h, "%s\x00%s\x00", n, files[n])
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (r *Reconciler) diskFiles() map[string]string {
	files := map[string]string{}
	for _, name := range ManagedFiles {
		data, err := os.ReadFile(filepath.Join(r.cfg.ConfDir, name))
		if err == nil {
			files[name] = string(data)
		}
	}
	return files
}

func (r *Reconciler) DiskHash() string   { return hashFiles(r.diskFiles()) }
func (r *Reconciler) LastError() string  { return r.lastErr }
func (r *Reconciler) DesiredHash() string {
	if r.desired == nil {
		return ""
	}
	return r.desired.Hash
}

// Fetch updates the cached desired config. An unreachable control node is not
// an error condition for the data plane: we keep the cached config and carry on.
func (r *Reconciler) Fetch(client *APIClient) {
	cfg, changed, err := client.FetchConfig()
	if err != nil {
		log.Printf("control unreachable, holding last known good: %v", err)
		return
	}
	if changed {
		r.desired = cfg
	}
}

// Apply reconciles disk against the cached desired config. Returns whether
// anything was changed.
func (r *Reconciler) Apply() bool {
	if r.desired == nil {
		return false // nothing fetched yet this lifetime; leave disk alone
	}
	disk := r.diskFiles()
	changedNames := []string{}
	for name, want := range r.desired.Files {
		// The control node is authenticated, not trusted with filesystem
		// paths: only the files this agent manages are ever written, and only
		// by exact name. Without this, a compromised or MITM'd control
		// response could write anywhere on the box as root (e.g.
		// "../../etc/cron.d/x").
		if !isManagedFile(name) {
			log.Printf("reconcile: refusing unexpected file name %q from control node", name)
			continue
		}
		if disk[name] != want {
			changedNames = append(changedNames, name)
		}
	}
	if len(changedNames) == 0 {
		r.lastErr = ""
		return false
	}
	sort.Strings(changedNames)
	log.Printf("reconcile: %s differ, applying", strings.Join(changedNames, ", "))

	newWg, wgChanged := r.desired.Files["wg0.conf"]
	wgChanged = wgChanged && disk["wg0.conf"] != newWg
	oldWg := disk["wg0.conf"]

	// Port pre-flight: refuse a port move onto a busy port outright, before
	// touching anything. The tunnel keeps running on the old config.
	if wgChanged {
		oldPort := listenPortOf(oldWg)
		newPort := listenPortOf(newWg)
		if newPort != 0 && newPort != oldPort && !udpPortFree(newPort) {
			r.lastErr = fmt.Sprintf("refusing config: UDP port %d is already bound on this node", newPort)
			log.Print(r.lastErr)
			return false
		}
	}

	if err := r.snapshot(disk); err != nil {
		r.lastErr = fmt.Sprintf("snapshot failed, not applying: %v", err)
		log.Print(r.lastErr)
		return false
	}

	for _, name := range changedNames {
		path := filepath.Join(r.cfg.ConfDir, name)
		if err := writeFileAtomic(path, r.desired.Files[name], 0o600); err != nil {
			r.lastErr = fmt.Sprintf("write %s: %v", name, err)
			log.Print(r.lastErr)
			r.restoreSnapshot()
			return false
		}
	}

	if contains(changedNames, "sysctl.conf") {
		applySysctl(filepath.Join(r.cfg.ConfDir, "sysctl.conf"))
	}
	if contains(changedNames, "nftables.conf") {
		if err := applyNftables(filepath.Join(r.cfg.ConfDir, "nftables.conf")); err != nil {
			r.lastErr = fmt.Sprintf("nftables apply failed, rolling back: %v", err)
			log.Print(r.lastErr)
			r.restoreSnapshot()
			_ = applyNftables(filepath.Join(r.cfg.ConfDir, "nftables.conf"))
			return false
		}
	}
	if wgChanged {
		if err := r.applyWg(oldWg, newWg); err != nil {
			r.lastErr = fmt.Sprintf("wireguard apply failed, rolling back: %v", err)
			log.Print(r.lastErr)
			r.restoreSnapshot()
			confPath := filepath.Join(r.cfg.ConfDir, "wg0.conf")
			if !wgInterfaceExists(r.cfg.WgInterface) {
				_ = wgUp(confPath)
			} else {
				_ = wgSyncPeers(r.cfg.WgInterface, confPath, privateKeyPathOf(oldWg))
			}
			return false
		}
		// Nudge every peer so sessions re-establish immediately rather than
		// waiting for user traffic — after a port change this is what heals
		// the mesh instead of leaving tunnels dark until someone talks.
		go pingPeerTunnels(newWg)
	}

	r.lastErr = ""
	log.Printf("reconcile: applied hash %s", r.desired.Hash)
	return true
}

// applyWg picks the least disruptive apply strategy: peers-only changes go
// through syncconf (no flap for unchanged peers); interface-level changes
// (port, MTU, address) need a full down/up.
func (r *Reconciler) applyWg(oldConf, newConf string) error {
	confPath := filepath.Join(r.cfg.ConfDir, "wg0.conf")
	if !wgInterfaceExists(r.cfg.WgInterface) {
		return wgUp(confPath)
	}
	if interfaceSection(oldConf) == interfaceSection(newConf) {
		return wgSyncPeers(r.cfg.WgInterface, confPath, privateKeyPathOf(newConf))
	}
	// Interface-level change: a brief flap is unavoidable and expected.
	if err := wgDownWith(oldConf, confPath); err != nil {
		log.Printf("wg down (continuing): %v", err)
	}
	return wgUp(confPath)
}

// wgDownWith shuts the interface using the OLD config so wg-quick removes the
// exact routes it added. The new config is already on disk, so write the old
// one to a temp file for the teardown.
func wgDownWith(oldConf, livePath string) error {
	tmp, err := os.CreateTemp(filepath.Dir(livePath), "wg0-old-*.conf")
	if err != nil {
		return wgDown(livePath)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(oldConf); err != nil {
		tmp.Close()
		return wgDown(livePath)
	}
	tmp.Close()
	// wg-quick derives the interface name from the filename, so a temp name
	// like wg0-old-123.conf would target the wrong interface. Instead, bring
	// down by the live path (interface name matches); route differences are
	// reconciled by the subsequent up.
	return wgDown(livePath)
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// --- snapshots (last-known-good for config-level rollback) ---

func (r *Reconciler) snapshotDir() string {
	return filepath.Join(r.cfg.StateDir, "last-known-good")
}

func (r *Reconciler) snapshot(files map[string]string) error {
	dir := r.snapshotDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for name, content := range files {
		if err := writeFileAtomic(filepath.Join(dir, name), content, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func (r *Reconciler) restoreSnapshot() {
	dir := r.snapshotDir()
	for _, name := range ManagedFiles {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		_ = writeFileAtomic(filepath.Join(r.cfg.ConfDir, name), string(data), 0o600)
	}
}

// Rollback restores the last-known-good snapshot and reloads everything.
// Offline-capable: needs no control node (§11 layer 9).
func (r *Reconciler) Rollback() error {
	dir := r.snapshotDir()
	if _, err := os.Stat(dir); err != nil {
		return fmt.Errorf("no snapshot available: %w", err)
	}
	r.restoreSnapshot()
	applySysctl(filepath.Join(r.cfg.ConfDir, "sysctl.conf"))
	if err := applyNftables(filepath.Join(r.cfg.ConfDir, "nftables.conf")); err != nil {
		return err
	}
	confPath := filepath.Join(r.cfg.ConfDir, "wg0.conf")
	if wgInterfaceExists(r.cfg.WgInterface) {
		if err := wgDown(confPath); err != nil {
			log.Printf("rollback: wg down: %v", err)
		}
	}
	return wgUp(confPath)
}
