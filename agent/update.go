package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

// Self-update (§11). Layered failsafes implemented here:
//   - download + sha256 + minisign verification, then the release's own
//     self-test, all BEFORE anything is switched (layer 1, node side)
//   - A/B install: versions live side by side; activation is a symlink flip,
//     rollback needs zero network (layer 5)
//   - commit-confirm: after re-exec, the NEW binary must see a fresh
//     handshake AND a successful check-in within a LOCAL timer, or it flips
//     the symlink back, restores config snapshots and re-execs the previous
//     version. The timer is local, so a control node dying mid-update still
//     produces a correct rollback (layer 4)
//   - boot watchdog: no handshake at all within the window after start →
//     restore last-known-good config and reload (layer 6)
//   - `opnmesh-agent rollback-update`: offline manual escape hatch (layer 9)

// Version is stamped via -ldflags "-X main.version=...". "dev" otherwise.
var version = "dev"

// simulateBroken is a test hook, stamped into deliberately broken releases:
// the binary runs but never reports, so commit-confirm must fail and revert.
var simulateBroken = ""

// UpdateInstruction is what the control node answers when this node is the
// one allowed to update right now.
type UpdateInstruction struct {
	TargetVersion string `json:"targetVersion"`
	BinaryPath    string `json:"binaryPath"`
	SigPath       string `json:"sigPath"`
	Sha256        string `json:"sha256"`
}

// updateState persists across the exec boundary.
type updateState struct {
	Pending   string `json:"pending,omitempty"`
	Prev      string `json:"prev,omitempty"`
	StartedAt int64  `json:"startedAt,omitempty"`
	// Set by a failed confirm so the restored binary can report why.
	FailedVersion string `json:"failedVersion,omitempty"`
	FailedReason  string `json:"failedReason,omitempty"`
}

func updateStatePath(cfg AgentConfig) string {
	return filepath.Join(cfg.StateDir, "update-state.json")
}

func loadUpdateState(cfg AgentConfig) updateState {
	var s updateState
	data, err := os.ReadFile(updateStatePath(cfg))
	if err == nil {
		_ = json.Unmarshal(data, &s)
	}
	return s
}

func saveUpdateState(cfg AgentConfig, s updateState) {
	data, _ := json.Marshal(s)
	_ = writeFileAtomic(updateStatePath(cfg), string(data), 0o600)
}

func versionsDir(cfg AgentConfig) string  { return filepath.Join(cfg.StateDir, "versions") }
func currentLink(cfg AgentConfig) string  { return filepath.Join(cfg.StateDir, "current") }
func binaryPathFor(cfg AgentConfig, v string) string {
	return filepath.Join(versionsDir(cfg), v, "opnmesh-agent")
}

// ensureSelfInstalled records the running binary under its own version so a
// later rollback always has something to flip back to.
func ensureSelfInstalled(cfg AgentConfig) {
	dst := binaryPathFor(cfg, version)
	if _, err := os.Stat(dst); err == nil {
		return
	}
	self, err := os.Executable()
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return
	}
	data, err := os.ReadFile(self)
	if err != nil {
		return
	}
	_ = os.WriteFile(dst, data, 0o755)
	if _, err := os.Lstat(currentLink(cfg)); err != nil {
		_ = os.Symlink(filepath.Dir(dst), currentLink(cfg))
	}
}

// flipTo atomically points the `current` symlink at a version directory.
func flipTo(cfg AgentConfig, v string) error {
	tmp := currentLink(cfg) + ".tmp"
	_ = os.Remove(tmp)
	if err := os.Symlink(filepath.Join(versionsDir(cfg), v), tmp); err != nil {
		return err
	}
	return os.Rename(tmp, currentLink(cfg))
}

func execVersion(cfg AgentConfig, v string) error {
	bin := binaryPathFor(cfg, v)
	args := append([]string{bin}, os.Args[1:]...)
	return syscall.Exec(bin, args, os.Environ())
}

// downloadAndVerify fetches a release through the authenticated API and
// verifies sha256 + minisign signature + the release's own self-test.
func downloadAndVerify(cfg AgentConfig, client *APIClient, instr UpdateInstruction) (string, error) {
	dir := filepath.Join(versionsDir(cfg), instr.TargetVersion)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	bin := filepath.Join(dir, "opnmesh-agent")
	sig := bin + ".minisig"

	for path, dst := range map[string]string{instr.BinaryPath: bin, instr.SigPath: sig} {
		if err := client.DownloadFile(path, dst); err != nil {
			return "", fmt.Errorf("download %s: %w", path, err)
		}
	}

	data, err := os.ReadFile(bin)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != instr.Sha256 {
		return "", fmt.Errorf("sha256 mismatch for %s", instr.TargetVersion)
	}

	pub := filepath.Join(cfg.ConfDir, "minisign.pub")
	if _, err := os.Stat(pub); err == nil {
		if out, err := runCmd("minisign", "-V", "-m", bin, "-x", sig, "-p", pub); err != nil {
			return "", fmt.Errorf("signature verification failed: %w (%s)", err, out)
		}
	} else {
		return "", fmt.Errorf("no minisign public key at %s — refusing unsigned update", pub)
	}

	if err := os.Chmod(bin, 0o755); err != nil {
		return "", err
	}
	// The release's own self-test must pass before we switch anything.
	if out, err := exec.Command(bin, "self-test").CombinedOutput(); err != nil {
		return "", fmt.Errorf("release self-test failed: %w (%s)", err, string(out))
	}
	return bin, nil
}

// applyUpdate performs the switch: config snapshot, state marker, symlink
// flip, exec. On any pre-exec failure everything is rolled back in place.
func applyUpdate(cfg AgentConfig, rec *Reconciler, client *APIClient, instr UpdateInstruction) error {
	if _, err := downloadAndVerify(cfg, client, instr); err != nil {
		return err
	}
	ensureSelfInstalled(cfg)
	if err := rec.snapshot(rec.diskFiles()); err != nil {
		return fmt.Errorf("config snapshot: %w", err)
	}
	saveUpdateState(cfg, updateState{
		Pending:   instr.TargetVersion,
		Prev:      version,
		StartedAt: time.Now().Unix(),
	})
	if err := flipTo(cfg, instr.TargetVersion); err != nil {
		saveUpdateState(cfg, updateState{})
		return fmt.Errorf("symlink flip: %w", err)
	}
	log.Printf("update: switching %s → %s (commit-confirm follows)", version, instr.TargetVersion)
	return execVersion(cfg, instr.TargetVersion)
}

// revertUpdate is the commit-confirm failure path in the NEW binary.
func revertUpdate(cfg AgentConfig, rec *Reconciler, st updateState, reason string) {
	log.Printf("update: commit-confirm FAILED (%s) — reverting to %s", reason, st.Prev)
	rec.restoreSnapshot()
	_ = flipTo(cfg, st.Prev)
	saveUpdateState(cfg, updateState{FailedVersion: st.Pending, FailedReason: reason})
	if err := execVersion(cfg, st.Prev); err != nil {
		log.Printf("update: exec of previous version failed: %v", err)
	}
}

// handshakeFresherThan reports whether any peer completed a handshake after t.
func handshakeFresherThan(iface string, t time.Time) bool {
	for _, p := range wgPeerStats(iface) {
		if p.LatestHandshake > 0 && time.Unix(p.LatestHandshake, 0).After(t) {
			return true
		}
	}
	return false
}

// confirmUpdate runs in the NEW binary: within the local commit-confirm
// window it needs a fresh handshake AND a successful check-in. The timer is
// local by design — a dead control node fails the check-in half and the node
// correctly reverts.
func confirmUpdate(cfg AgentConfig, rec *Reconciler, st updateState, agentState *SharedState) {
	deadline := time.Now().Add(time.Duration(cfg.CommitConfirmSec) * time.Second)
	// Handshakes as recent as shortly before the flip count: WireGuard rekeys
	// roughly every 2 minutes, so "fresh" means newer than start - 130s.
	freshCutoff := time.Unix(st.StartedAt, 0).Add(-130 * time.Second)
	for time.Now().Before(deadline) {
		if handshakeFresherThan(cfg.WgInterface, freshCutoff) && agentState.LastReportOK() > 0 {
			saveUpdateState(cfg, updateState{})
			log.Printf("update: %s confirmed (handshake + check-in)", version)
			return
		}
		time.Sleep(2 * time.Second)
	}
	revertUpdate(cfg, rec, st, fmt.Sprintf("no handshake+check-in within %ds", cfg.CommitConfirmSec))
}

// bootWatchdog (§11 layer 6): if the node establishes no handshake with any
// peer within the window after start, revert to last-known-good config and
// reload. Only acts when a snapshot exists.
func bootWatchdog(cfg AgentConfig, rec *Reconciler, start time.Time) {
	if cfg.BootWatchdogSec <= 0 {
		return
	}
	time.Sleep(time.Duration(cfg.BootWatchdogSec) * time.Second)
	if handshakeFresherThan(cfg.WgInterface, start.Add(-130*time.Second)) {
		return
	}
	if _, err := os.Stat(filepath.Join(rec.snapshotDir(), "wg0.conf")); err != nil {
		log.Print("boot watchdog: no handshake, but no snapshot to restore — leaving config alone")
		return
	}
	log.Printf("boot watchdog: no handshake within %ds — reverting to last-known-good", cfg.BootWatchdogSec)
	if err := rec.Rollback(); err != nil {
		log.Printf("boot watchdog: rollback failed: %v", err)
	}
}
