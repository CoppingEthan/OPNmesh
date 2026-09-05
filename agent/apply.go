package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
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
// previous files as *.prev, apply sysctl, nftables, then WireGuard with the
// least disruptive operation that suffices.
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
	wgConf, ok := desired.Files["wireguard.conf"]
	if !ok {
		return errors.New("controller sent no wireguard.conf")
	}
	if err := validateHooks(wgConf, cfg.ConfDir); err != nil {
		return err
	}
	if got := hashFiles(desired.Files); got != desired.Hash {
		return fmt.Errorf("bundle hash mismatch (controller %s, computed %s)", desired.Hash, got)
	}

	meta := cfg.loadMeta()
	oldIface := meta.Interface
	old := diskFiles(cfg, oldIface)
	oldWg := old["wireguard.conf"]

	changed := []string{}
	for name, want := range desired.Files {
		if old[name] != want {
			changed = append(changed, name)
		}
	}
	sort.Strings(changed)
	ifaceChanged := oldIface != iface
	if len(changed) == 0 && !ifaceChanged && wgInterfaceExists(iface) {
		return finishApply(cfg, desired, iface)
	}
	log.Printf("apply: %s changed (interface %s)", strings.Join(changed, ", "), iface)

	restart := ifaceChanged || !wgInterfaceExists(oldIface) || interfaceSection(oldWg) != interfaceSection(wgConf)
	if restart {
		newPort := listenPortOf(wgConf)
		oldPort := listenPortOf(oldWg)
		if newPort != 0 && newPort != oldPort && !udpPortFree(newPort) {
			return fmt.Errorf("refusing to move to UDP port %d: it is in use on this host", newPort)
		}
	}

	// Keep the previous files for rollback, then write the new ones.
	for _, name := range ManagedFiles {
		p := realPath(cfg, iface, name)
		if prev, err := os.ReadFile(p); err == nil {
			_ = writeFileAtomic(p+".prev", prev, 0o600)
		}
		if err := writeFileAtomic(p, []byte(desired.Files[name]), 0o600); err != nil {
			return fmt.Errorf("write %s: %w", p, err)
		}
	}
	if ifaceChanged {
		// The old interface's conf file is stale; remove it so `up` cannot pick it.
		_ = os.Remove(realPath(cfg, oldIface, "wireguard.conf"))
	}

	if err := applySysctl(desired.Files["sysctl.conf"]); err != nil {
		return err
	}
	if err := applyNftables(realPath(cfg, iface, "nftables.conf")); err != nil {
		return err
	}
	wgPath := realPath(cfg, iface, "wireguard.conf")
	keyPath := privateKeyPathOf(wgConf)
	if restart {
		if ifaceChanged && wgInterfaceExists(oldIface) {
			_, _ = runCmd("ip", "link", "del", oldIface)
		} else if wgInterfaceExists(iface) {
			_, _ = runCmd("ip", "link", "del", iface)
		}
		if err := wgQuickUp(wgPath); err != nil {
			return err
		}
		if err := ensurePrivateKey(iface, keyPath); err != nil {
			return err
		}
	} else {
		if err := wgSyncPeers(iface, wgPath, keyPath); err != nil {
			return err
		}
		if err := reconcileRoutes(iface, wgConf); err != nil {
			return err
		}
	}
	return finishApply(cfg, desired, iface)
}

func finishApply(cfg Config, desired *ConfigResponse, iface string) error {
	meta := cfg.loadMeta()
	meta.Interface = iface
	meta.ListenPort = desired.Meta.ListenPort
	meta.AppliedHash = desired.Hash
	meta.AppliedAt = time.Now().Unix()
	meta.SiteSlug = desired.Meta.SiteSlug
	if desired.Meta.TelemetryIntervalSeconds > 0 {
		meta.TelemetryEverySec = desired.Meta.TelemetryIntervalSeconds
	}
	if desired.Meta.PrivateKeyPath != "" {
		meta.PrivateKeyPath = desired.Meta.PrivateKeyPath
	}
	if err := cfg.saveMeta(meta); err != nil {
		return err
	}
	allowUfw(desired.Meta.ListenPort)
	return nil
}

// applySysctl writes each "key = value" straight into /proc/sys.
func applySysctl(conf string) error {
	for _, raw := range strings.Split(conf, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])
		if !strings.HasPrefix(key, "net.") || strings.Contains(key, "..") || strings.ContainsAny(key, "/ ") {
			return fmt.Errorf("refusing sysctl %q", key)
		}
		path := "/proc/sys/" + strings.ReplaceAll(key, ".", "/")
		// Already correct (e.g. set by the platform at boot) → nothing to do,
		// which also covers containers where /proc/sys is read-only.
		if cur, err := os.ReadFile(path); err == nil && strings.TrimSpace(string(cur)) == val {
			continue
		}
		if err := os.WriteFile(path, []byte(val+"\n"), 0o644); err != nil {
			return fmt.Errorf("sysctl %s: %w", key, err)
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

// allowUfw opens the listen port when ufw is active. Best effort: a gateway
// without ufw, or with it disabled, needs nothing.
func allowUfw(port int) {
	if port <= 0 {
		return
	}
	if _, err := exec.LookPath("ufw"); err != nil {
		return
	}
	out, err := exec.Command("ufw", "status").CombinedOutput()
	if err != nil || !strings.Contains(string(out), "Status: active") {
		return
	}
	_, _ = runCmd("ufw", "allow", fmt.Sprintf("%d/udp", port), "comment", "OPNmesh WireGuard")
}

// applyFromDisk brings everything up from the files already present, with
// no controller involved. Used at boot and by rollback.
func applyFromDisk(cfg Config) error {
	meta := cfg.loadMeta()
	iface := meta.Interface
	files := diskFiles(cfg, iface)
	if s, ok := files["sysctl.conf"]; ok {
		if err := applySysctl(s); err != nil {
			return err
		}
	}
	if _, ok := files["nftables.conf"]; ok {
		if err := applyNftables(realPath(cfg, iface, "nftables.conf")); err != nil {
			return err
		}
	}
	if wg, ok := files["wireguard.conf"]; ok {
		if err := validateHooks(wg, cfg.ConfDir); err != nil {
			return err
		}
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

// healKey is called on every loop tick: if the interface is up but has no
// private key (a manual `wg setconf`, a bug, anything), put it back.
func healKey(cfg Config) {
	meta := cfg.loadMeta()
	files := diskFiles(cfg, meta.Interface)
	if wg, ok := files["wireguard.conf"]; ok {
		if err := ensurePrivateKey(meta.Interface, privateKeyPathOf(wg)); err != nil {
			log.Printf("restore private key: %v", err)
		}
	}
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

func rollback(cfg Config) error {
	meta := cfg.loadMeta()
	iface := meta.Interface
	restored := 0
	for _, name := range ManagedFiles {
		p := realPath(cfg, iface, name)
		prev, err := os.ReadFile(p + ".prev")
		if err != nil {
			continue
		}
		cur, _ := os.ReadFile(p)
		if err := writeFileAtomic(p, prev, 0o600); err != nil {
			return err
		}
		_ = writeFileAtomic(p+".prev", cur, 0o600)
		restored++
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
