package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// hashFiles must match the controller's hashFiles: sha256 over
// "name\0content\0" for the logical names in sorted order.
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

// realPath maps a logical file name to where it lives on disk. The WireGuard
// file is named after the interface because wg-quick derives the interface
// name from the file name.
func realPath(cfg Config, iface, logical string) string {
	if logical == "wireguard.conf" {
		return filepath.Join(cfg.ConfDir, iface+".conf")
	}
	return filepath.Join(cfg.ConfDir, logical)
}

func diskFiles(cfg Config, iface string) map[string]string {
	files := map[string]string{}
	for _, name := range ManagedFiles {
		if data, err := os.ReadFile(realPath(cfg, iface, name)); err == nil {
			files[name] = string(data)
		}
	}
	return files
}

// applyConfig makes disk and kernel match the desired configuration. It is
// careful in this order: refuse anything unsafe before touching disk, keep
// previous files as *.prev, apply nftables, sysctl, then WireGuard with the
// least disruptive operation that suffices. If any step after the files are
// written fails, the previous files are put back and brought up again, so
// the disk never holds a configuration that did not apply.
func applyConfig(cfg Config, desired *ConfigResponse) error {
	iface := desired.Meta.InterfaceName
	if iface == "" {
		iface = "opnmesh0"
	}
	if !validInterfaceName(iface) {
		return fmt.Errorf("refusing interface name %q", iface)
	}
	for name := range desired.Files {
		if !isManagedFile(name) {
			return fmt.Errorf("refusing unexpected file %q from controller", name)
		}
	}
	// Every file, every time: a missing one would be written empty, and an
	// empty nftables.conf brings the host up forwarding with no filter.
	for _, name := range ManagedFiles {
		if _, ok := desired.Files[name]; !ok {
			return fmt.Errorf("refusing a configuration without %s", name)
		}
	}
	if err := validateFiles(desired.Files, cfg.ConfDir); err != nil {
		return err
	}
	if !nftFiltersForwarding(desired.Files["nftables.conf"]) {
		return errors.New("refusing nftables.conf: it has no forward chain that drops by default, so forwarding would be left open")
	}
	if got := hashFiles(desired.Files); got != desired.Hash {
		return fmt.Errorf("bundle hash mismatch (controller %s, computed %s)", desired.Hash, got)
	}
	wgConf := desired.Files["wireguard.conf"]

	meta := cfg.loadMeta()
	oldIface := meta.Interface
	old := diskFiles(cfg, oldIface)
	oldWg := old["wireguard.conf"]
	// The files on disk describe what is running only while they are what
	// was last applied. A crash half way through an apply, a failed
	// configuration an older agent left behind, or a hand edit breaks that,
	// and then the running interface has to be rebuilt to be sure of it.
	diskIsApplied := meta.AppliedHash != "" && hashFiles(old) == meta.AppliedHash

	changed := []string{}
	for name, want := range desired.Files {
		if old[name] != want {
			changed = append(changed, name)
		}
	}
	sort.Strings(changed)
	ifaceChanged := oldIface != iface
	// Nothing to do only if this very configuration was applied here and is
	// still on disk and running. Files that merely match prove nothing.
	if meta.AppliedHash == desired.Hash && len(changed) == 0 && !ifaceChanged && wgInterfaceExists(iface) {
		return finishApply(cfg, desired, iface)
	}
	logf("apply: %s changed (interface %s)", strings.Join(changed, ", "), iface)

	restart := ifaceChanged || !diskIsApplied || !wgInterfaceExists(oldIface) || interfaceSection(oldWg) != interfaceSection(wgConf)
	if restart {
		newPort := listenPortOf(wgConf)
		oldPort := listenPortOf(oldWg)
		if newPort != 0 && newPort != oldPort && !udpPortFree(newPort) {
			return fmt.Errorf("refusing to move to UDP port %d: it is in use on this host", newPort)
		}
	}

	tx, err := writeBundle(cfg, desired.Files, iface, oldIface)
	if err != nil {
		return err
	}
	run := &applyRun{cfg: cfg, tx: tx, iface: iface, oldIface: oldIface}

	// The firewall goes first: sysctl may switch forwarding on, and must
	// never do so before the table that filters it is in place.
	if err := applyNftables(realPath(cfg, iface, "nftables.conf")); err != nil {
		return run.undo(err)
	}
	if err := applySysctl(desired.Files["sysctl.conf"]); err != nil {
		return run.undo(err)
	}
	wgPath := realPath(cfg, iface, "wireguard.conf")
	keyPath := privateKeyPathOf(wgConf)
	if restart {
		run.restarted = true
		if err := restartInterface(iface, oldIface, ifaceChanged, wgPath, keyPath); err != nil {
			return run.undo(err)
		}
	} else {
		run.synced = true
		if err := wgSyncPeers(iface, wgPath, keyPath); err != nil {
			return run.undo(err)
		}
		if err := reconcileRoutes(iface, wgConf); err != nil {
			return run.undo(err)
		}
	}
	return finishApply(cfg, desired, iface)
}

// savedFile is what one path held before an apply wrote it.
type savedFile struct {
	path    string
	data    []byte
	existed bool
}

// fileTxn remembers every path an apply is about to write, so a failure at
// any later step can put the disk back exactly as it was, .prev files
// included (they keep serving `opnmesh-gw rollback`).
type fileTxn struct{ saved []savedFile }

func (t *fileTxn) save(paths ...string) error {
	for _, p := range paths {
		data, err := os.ReadFile(p)
		switch {
		case err == nil:
			t.saved = append(t.saved, savedFile{path: p, data: data, existed: true})
		case errors.Is(err, fs.ErrNotExist):
			t.saved = append(t.saved, savedFile{path: p})
		default:
			return fmt.Errorf("read %s: %w", p, err)
		}
	}
	return nil
}

// before returns what path held when it was saved.
func (t *fileTxn) before(path string) ([]byte, bool) {
	for _, s := range t.saved {
		if s.path == path {
			return s.data, s.existed
		}
	}
	return nil, false
}

// restore puts every saved path back, removing the ones that did not exist.
func (t *fileTxn) restore() error {
	var firstErr error
	for i := len(t.saved) - 1; i >= 0; i-- {
		s := t.saved[i]
		var err error
		if s.existed {
			err = writeFileAtomic(s.path, s.data, 0o600)
		} else if rmErr := os.Remove(s.path); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) {
			err = rmErr
		}
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// writeBundle writes the new files, keeping each previous one as *.prev,
// and returns a record of everything it touched. A write that fails puts
// the files already written back before returning.
func writeBundle(cfg Config, files map[string]string, iface, oldIface string) (*fileTxn, error) {
	tx := &fileTxn{}
	for _, name := range ManagedFiles {
		p := realPath(cfg, iface, name)
		if err := tx.save(p, p+".prev"); err != nil {
			return nil, err
		}
	}
	oldConf := realPath(cfg, oldIface, "wireguard.conf")
	if iface != oldIface {
		if err := tx.save(oldConf); err != nil {
			return nil, err
		}
	}
	for _, name := range ManagedFiles {
		p := realPath(cfg, iface, name)
		if prev, ok := tx.before(p); ok {
			_ = writeFileAtomic(p+".prev", prev, 0o600)
		}
		if err := writeFileAtomic(p, []byte(files[name]), 0o600); err != nil {
			err = fmt.Errorf("write %s: %w", p, err)
			if rbErr := tx.restore(); rbErr != nil {
				err = fmt.Errorf("%v; putting the previous files back failed too: %v", err, rbErr)
			}
			return nil, err
		}
	}
	if iface != oldIface {
		// The old interface's conf file is stale; remove it so `up` cannot pick it.
		_ = os.Remove(oldConf)
	}
	return tx, nil
}

// applyRun records how far an apply got, so undo knows what to put back.
type applyRun struct {
	cfg             Config
	tx              *fileTxn
	iface, oldIface string
	restarted       bool // the running interface was taken down to be rebuilt
	synced          bool // peers and routes of the running interface were changed
}

// undo puts the previous files back after a step failed and brings the host
// in line with them again, so a bad change costs seconds rather than an
// outage until someone logs in, and never stays on disk where the next
// attempt, or the next boot, would take it for applied. The run loop reports
// the error and waits before trying this hash again.
func (r *applyRun) undo(cause error) error {
	if err := r.tx.restore(); err != nil {
		return fmt.Errorf("%v; putting the previous files back failed too: %v", cause, err)
	}
	if r.restarted && wgInterfaceExists(r.iface) {
		// Built, perhaps half way, from the new file (after a rename, under
		// the new name): take it down so the previous one is rebuilt.
		_, _ = runCmd("ip", "link", "del", r.iface)
	}
	prev := diskFiles(r.cfg, r.oldIface)
	if len(prev) == 0 {
		return fmt.Errorf("%v; there is no earlier configuration to go back to", cause)
	}
	// meta still names the previous interface: nothing was recorded yet.
	err := applyFromDisk(r.cfg)
	if err == nil && r.synced && wgInterfaceExists(r.oldIface) {
		wg := prev["wireguard.conf"]
		if err = wgSyncPeers(r.oldIface, realPath(r.cfg, r.oldIface, "wireguard.conf"), privateKeyPathOf(wg)); err == nil {
			err = reconcileRoutes(r.oldIface, wg)
		}
	}
	if err != nil {
		return fmt.Errorf("%v; restoring the previous configuration failed too: %v", cause, err)
	}
	return fmt.Errorf("%v; rolled back to the previous configuration, which is running again", cause)
}

func finishApply(cfg Config, desired *ConfigResponse, iface string) error {
	meta := cfg.loadMeta()
	oldPort := meta.ListenPort
	// The port comes from the checked wireguard.conf, not the controller's
	// metadata, which nothing validates.
	newPort := listenPortOf(desired.Files["wireguard.conf"])
	meta.Interface = iface
	meta.ListenPort = newPort
	meta.AppliedHash = desired.Hash
	meta.AppliedAt = time.Now().Unix()
	meta.SiteSlug = desired.Meta.SiteSlug
	if desired.Meta.TelemetryIntervalSeconds > 0 {
		meta.TelemetryEverySec = desired.Meta.TelemetryIntervalSeconds
	}
	if err := cfg.saveMeta(meta); err != nil {
		return err
	}
	updateUfw(oldPort, newPort)
	return nil
}

// procSys is where applySysctl writes; a variable for the tests.
var procSys = "/proc/sys"

// applySysctl writes each allowed "key = value" straight into /proc/sys.
func applySysctl(conf string) error {
	settings, err := parseSysctl(conf)
	if err != nil {
		return err
	}
	for _, s := range settings {
		path := filepath.Join(procSys, strings.ReplaceAll(s.Key, ".", "/"))
		// Already correct (e.g. set by the platform at boot) → nothing to do,
		// which also covers containers where /proc/sys is read-only.
		if cur, err := os.ReadFile(path); err == nil && strings.TrimSpace(string(cur)) == s.Value {
			continue
		}
		if err := os.WriteFile(path, []byte(s.Value+"\n"), 0o644); err != nil {
			return fmt.Errorf("sysctl %s: %w", s.Key, err)
		}
	}
	return nil
}

func applyNftables(path string) error {
	if _, err := runCmd("nft", "-c", "-f", path); err != nil {
		return fmt.Errorf("nftables check failed: %w", err)
	}
	_, err := runCmd("nft", "-f", path)
	return err
}

func nftTableExists() bool {
	_, err := runCmd("nft", "list", "table", "inet", "opnmesh")
	return err == nil
}

// lookPath finds a program; a variable so the tests decide what is installed.
var lookPath = exec.LookPath

// updateUfw opens the listen port when ufw is active, and closes the one the
// agent opened before when the port has moved. Best effort: a gateway
// without ufw, or with it disabled, needs nothing.
func updateUfw(oldPort, newPort int) {
	if newPort <= 0 {
		return
	}
	if _, err := lookPath("ufw"); err != nil {
		return
	}
	out, err := runCmd("ufw", "status")
	if err != nil || !strings.Contains(out, "Status: active") {
		return
	}
	if _, err := runCmd("ufw", "allow", fmt.Sprintf("%d/udp", newPort), "comment", "OPNmesh WireGuard"); err != nil {
		logf("ufw: %v", err)
	}
	if oldPort > 0 && oldPort != newPort {
		if _, err := runCmd("ufw", "delete", "allow", fmt.Sprintf("%d/udp", oldPort)); err != nil {
			logf("ufw: %v", err)
		}
	}
}

// applyFromDisk brings everything up from the files already present, with
// no controller involved. Used at boot, by the run loop's upkeep, by
// rollback, and to go back after a failed apply.
func applyFromDisk(cfg Config) error {
	meta := cfg.loadMeta()
	iface := meta.Interface
	files := diskFiles(cfg, iface)
	// Files on disk get the same checks as the controller's: they may be
	// .prev copies, or have been written by an older agent.
	if err := validateFiles(files, cfg.ConfDir); err != nil {
		return err
	}
	_, hasNft := files["nftables.conf"]
	_, hasWg := files["wireguard.conf"]
	_, hasSysctl := files["sysctl.conf"]
	// Fail closed: the firewall comes first, and nothing that forwards
	// (ip_forward, the tunnel) is brought up without it.
	if (hasWg || hasSysctl) && !hasNft {
		return fmt.Errorf("refusing to bring the mesh up without %s", realPath(cfg, iface, "nftables.conf"))
	}
	if hasNft {
		if err := applyNftables(realPath(cfg, iface, "nftables.conf")); err != nil {
			return err
		}
	}
	if s, ok := files["sysctl.conf"]; ok {
		if err := applySysctl(s); err != nil {
			return err
		}
	}
	if wg, ok := files["wireguard.conf"]; ok {
		if !wgInterfaceExists(iface) {
			if err := wgQuickUp(realPath(cfg, iface, "wireguard.conf")); err != nil {
				return err
			}
		}
		if err := ensurePrivateKey(iface, privateKeyPathOf(wg)); err != nil {
			return err
		}
	}
	return nil
}

// restartInterface replaces the running interface with one built from the
// new file: the only way to change the [Interface] section.
func restartInterface(iface, oldIface string, ifaceChanged bool, wgPath, keyPath string) error {
	if ifaceChanged && wgInterfaceExists(oldIface) {
		_, _ = runCmd("ip", "link", "del", oldIface)
	} else if wgInterfaceExists(iface) {
		_, _ = runCmd("ip", "link", "del", iface)
	}
	if err := wgQuickUp(wgPath); err != nil {
		return err
	}
	return ensurePrivateKey(iface, keyPath)
}

// How long the run loop leaves a configuration alone after it failed to
// apply here, unless the controller changes it in the meantime.
const applyRetryAfter = 5 * time.Minute

// How often the run loop retries bringing a missing interface up.
const bringUpEvery = 30 * time.Second

// How long after a failed reload of the firewall the next attempt waits.
const firewallRetryEvery = 30 * time.Second

// tunnelKeeper is the run loop's memory for maintain.
type tunnelKeeper struct {
	rr          *reresolver
	lastBringUp time.Time
	// When reloading the firewall last failed; zero after a success.
	lastFirewallFail time.Time
}

func newTunnelKeeper() *tunnelKeeper { return &tunnelKeeper{rr: newReresolver()} }

// maintain runs on every tick, controller or no controller: it reloads the
// firewall when its table has gone, brings the interface up from disk when
// it is missing (a boot-time bring-up that failed because DNS was not ready,
// a manual `wg-quick down`, anything), restores a lost private key, and
// re-resolves stale hostname endpoints so a site whose public address
// changed comes back on its own.
func (k *tunnelKeeper) maintain(cfg Config) {
	meta := cfg.loadMeta()
	files := diskFiles(cfg, meta.Interface)
	k.keepFirewall(cfg, meta.Interface, files)
	wg, ok := files["wireguard.conf"]
	if !ok {
		return
	}
	if !wgInterfaceExists(meta.Interface) {
		if time.Since(k.lastBringUp) < bringUpEvery {
			return
		}
		k.lastBringUp = time.Now()
		if err := applyFromDisk(cfg); err != nil {
			logf("bring-up from disk: %v", err)
			return
		}
		logf("brought %s up from the files on disk", meta.Interface)
	}
	// A file that fails the checks (left by an older agent, or edited by
	// hand) steers neither the key nor the endpoints; bring-up reports why.
	if validateWireGuard(wg, cfg.ConfDir) != nil {
		return
	}
	if err := ensurePrivateKey(meta.Interface, privateKeyPathOf(wg)); err != nil {
		logf("restore private key: %v", err)
	}
	k.rr.run(meta.Interface, wg)
}

// keepFirewall reloads table inet opnmesh from disk when it has gone. `nft
// flush ruleset`, a restart of nftables.service or a hand edit removes it
// without touching ip_forward, and the host would then forward between the
// mesh and its LANs with nothing filtering. A reload is logged; a failed
// one is retried every firewallRetryEvery.
func (k *tunnelKeeper) keepFirewall(cfg Config, iface string, files map[string]string) {
	conf, ok := files["nftables.conf"]
	if !ok || nftTableExists() {
		return
	}
	if !k.lastFirewallFail.IsZero() && time.Since(k.lastFirewallFail) < firewallRetryEvery {
		return
	}
	path := realPath(cfg, iface, "nftables.conf")
	err := validateNftables(conf)
	if err == nil {
		err = applyNftables(path)
	}
	if err == nil && !nftTableExists() {
		err = errors.New("the file does not create it")
	}
	if err != nil {
		k.lastFirewallFail = time.Now()
		logf("table inet opnmesh is missing and reloading it from %s failed (next try in %s): %v", path, firewallRetryEvery, err)
		return
	}
	k.lastFirewallFail = time.Time{}
	logf("table inet opnmesh had gone (flushed or deleted outside the agent); reloaded it from %s", path)
}

func tearDown(cfg Config) error {
	meta := cfg.loadMeta()
	iface := meta.Interface
	var firstErr error
	if wgInterfaceExists(iface) {
		if err := wgQuickDown(realPath(cfg, iface, "wireguard.conf")); err != nil {
			// wg-quick refuses if the conf is missing; delete the link directly.
			if _, err2 := runCmd("ip", "link", "del", iface); err2 != nil {
				firstErr = err
			}
		}
	}
	_, _ = runCmd("nft", "delete", "table", "inet", "opnmesh")
	return firstErr
}

// restorePrevious swaps every managed file with its .prev copy and reports
// how many were swapped. Nothing is applied; callers bring the result up.
func restorePrevious(cfg Config, iface string) (int, error) {
	restored := 0
	for _, name := range ManagedFiles {
		p := realPath(cfg, iface, name)
		prev, err := os.ReadFile(p + ".prev")
		if err != nil {
			continue
		}
		cur, _ := os.ReadFile(p)
		if err := writeFileAtomic(p, prev, 0o600); err != nil {
			return restored, err
		}
		_ = writeFileAtomic(p+".prev", cur, 0o600)
		restored++
	}
	return restored, nil
}

func rollback(cfg Config) error {
	meta := cfg.loadMeta()
	iface := meta.Interface
	restored, err := restorePrevious(cfg, iface)
	if err != nil {
		return err
	}
	if restored == 0 {
		return errors.New("nothing to roll back to (no .prev files)")
	}
	if err := tearDown(cfg); err != nil {
		return err
	}
	if err := applyFromDisk(cfg); err != nil {
		return err
	}
	meta.AppliedHash = hashFiles(diskFiles(cfg, iface))
	meta.AppliedAt = time.Now().Unix()
	return cfg.saveMeta(meta)
}
