package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// fakeHost stands in for wg, wg-quick, ip, nft and ufw, keeping just enough
// state (which interfaces exist, whether the table is loaded) for the apply
// logic to be followed end to end.
type fakeHost struct {
	calls     []string
	ifaces    map[string]bool
	table     bool
	routes    string            // what `ip -j -4 route show dev X` prints
	failing   map[string]string // a command line starting with the key fails
	ufwActive bool
}

func newFakeHost(t *testing.T) *fakeHost {
	t.Helper()
	h := &fakeHost{ifaces: map[string]bool{}, routes: "[]", failing: map[string]string{}}
	oldRun, oldFree, oldLook, oldProc := runCmd, udpPortFree, lookPath, procSys
	runCmd = h.run
	udpPortFree = func(int) bool { return true }
	lookPath = func(name string) (string, error) {
		if name == "ufw" && h.ufwActive {
			return "/usr/sbin/ufw", nil
		}
		return "", exec.ErrNotFound
	}
	procSys = t.TempDir()
	if err := os.MkdirAll(filepath.Join(procSys, "net", "ipv4"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(h.forwardingPath(), []byte("0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	logOut := log.Writer()
	log.SetOutput(io.Discard)
	t.Cleanup(func() {
		runCmd, udpPortFree, lookPath, procSys = oldRun, oldFree, oldLook, oldProc
		log.SetOutput(logOut)
	})
	return h
}

func (h *fakeHost) forwardingPath() string {
	return filepath.Join(procSys, "net", "ipv4", "ip_forward")
}

func (h *fakeHost) forwarding() string {
	data, _ := os.ReadFile(h.forwardingPath())
	return strings.TrimSpace(string(data))
}

func (h *fakeHost) run(name string, args ...string) (string, error) {
	line := strings.TrimSpace(name + " " + strings.Join(args, " "))
	h.calls = append(h.calls, line)
	for prefix, msg := range h.failing {
		if strings.HasPrefix(line, prefix) {
			return "", fmt.Errorf("%s: %s", line, msg)
		}
	}
	switch {
	case name == "wg" && len(args) == 2 && args[0] == "show":
		if h.ifaces[args[1]] {
			return "", nil
		}
		return "", errors.New("Unable to access interface: No such device")
	case name == "wg" && len(args) == 3 && args[2] == "public-key":
		return "PUBLIC\n", nil
	case name == "wg-quick" && args[0] == "up":
		h.ifaces[strings.TrimSuffix(filepath.Base(args[1]), ".conf")] = true
	case name == "wg-quick" && args[0] == "strip":
		data, err := os.ReadFile(args[1])
		return string(data), err
	case name == "ip" && len(args) == 3 && args[0] == "link" && args[1] == "del":
		delete(h.ifaces, args[2])
	case name == "ip" && args[0] == "-j":
		return h.routes, nil
	case name == "nft" && len(args) == 2 && args[0] == "-f":
		h.table = true
	case name == "nft" && args[0] == "list":
		if h.table {
			return "table inet opnmesh {\n}\n", nil
		}
		return "", errors.New("No such file or directory")
	case name == "nft" && args[0] == "delete":
		h.table = false
	case name == "ufw" && args[0] == "status":
		if h.ufwActive {
			return "Status: active\n", nil
		}
		return "Status: inactive\n", nil
	}
	return "", nil
}

func (h *fakeHost) called(line string) bool { return slices.Contains(h.calls, line) }

func (h *fakeHost) calledPrefix(prefix string) bool {
	return slices.ContainsFunc(h.calls, func(c string) bool { return strings.HasPrefix(c, prefix) })
}

const testNft = "table inet opnmesh {}\ndelete table inet opnmesh\n\ntable inet opnmesh {\n" +
	"  chain forward {\n    type filter hook forward priority filter; policy drop;\n  }\n}\n"

type bundleOpts struct {
	iface   string
	port    int
	mtu     int
	allowed string
	nft     string
	omit    string // a managed file to leave out
}

func testConfig(t *testing.T) Config {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "private.key"), []byte(testKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return Config{ConfDir: dir, StateDir: t.TempDir()}
}

func testBundle(cfg Config, o bundleOpts) *ConfigResponse {
	if o.port == 0 {
		o.port = 51820
	}
	if o.mtu == 0 {
		o.mtu = 1420
	}
	if o.allowed == "" {
		o.allowed = "10.99.0.2/32"
	}
	if o.nft == "" {
		o.nft = testNft
	}
	wg := fmt.Sprintf("[Interface]\nAddress = 10.99.0.1/24\nListenPort = %d\nMTU = %d\nPostUp = wg set %%i private-key %s\n\n[Peer]\n# site: office\nPublicKey = %s\nAllowedIPs = %s\n",
		o.port, o.mtu, filepath.Join(cfg.ConfDir, "private.key"), testKey, o.allowed)
	files := map[string]string{"wireguard.conf": wg, "nftables.conf": o.nft, "sysctl.conf": "net.ipv4.ip_forward = 1\n"}
	if o.omit != "" {
		delete(files, o.omit)
	}
	return &ConfigResponse{Status: "active", Hash: hashFiles(files), Files: files, Meta: ConfigMeta{InterfaceName: o.iface}}
}

func mustApply(t *testing.T, cfg Config, b *ConfigResponse) {
	t.Helper()
	if err := applyConfig(cfg, b); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if got := cfg.loadMeta().AppliedHash; got != b.Hash {
		t.Fatalf("applied hash %q, want %q", got, b.Hash)
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return !errors.Is(err, fs.ErrNotExist)
}

// A step that fails after the files are written puts the previous files
// back, so a retry of the same configuration fails again instead of finding
// the files already in place and reporting them applied.
func TestFailedApplyIsNotReportedAsApplied(t *testing.T) {
	h := newFakeHost(t)
	cfg := testConfig(t)
	a := testBundle(cfg, bundleOpts{})
	mustApply(t, cfg, a)
	wgPrev := realPath(cfg, "opnmesh0", "wireguard.conf") + ".prev"

	// A peers-only change whose new route cannot be added.
	b := testBundle(cfg, bundleOpts{allowed: "10.99.0.2/32, 192.168.20.0/24"})
	h.failing["ip -4 route add 192.168.20.0/24"] = "RTNETLINK answers: File exists"
	for attempt := 1; attempt <= 2; attempt++ {
		err := applyConfig(cfg, b)
		if err == nil {
			t.Fatalf("attempt %d: a failed apply was reported as applied", attempt)
		}
		if !strings.Contains(err.Error(), "rolled back to the previous configuration") {
			t.Errorf("attempt %d: %v", attempt, err)
		}
		if got := hashFiles(diskFiles(cfg, "opnmesh0")); got != a.Hash {
			t.Fatalf("attempt %d: the previous files were not put back", attempt)
		}
		if got := cfg.loadMeta().AppliedHash; got != a.Hash {
			t.Fatalf("attempt %d: applied hash became %q", attempt, got)
		}
		if exists(wgPrev) {
			t.Fatalf("attempt %d: .prev files were not put back as they were", attempt)
		}
	}
	// The peers the failed attempt set were synced back to the old ones.
	if last := h.calls[len(h.calls)-1]; last != "ip -4 route add 10.99.0.2/32 dev opnmesh0" {
		t.Errorf("rollback did not end by restoring the old routes: %v", h.calls)
	}

	delete(h.failing, "ip -4 route add 192.168.20.0/24")
	mustApply(t, cfg, b)
	if data, _ := os.ReadFile(wgPrev); string(data) != a.Files["wireguard.conf"] {
		t.Error("a successful apply must keep the previous file for rollback")
	}
}

// Files already on disk that were never applied (a crash half way, an older
// agent's failed apply) say nothing about the running interface: a change to
// [Interface] in them must still rebuild it.
func TestApplyRestartsWhenDiskWasNeverApplied(t *testing.T) {
	h := newFakeHost(t)
	cfg := testConfig(t)
	mustApply(t, cfg, testBundle(cfg, bundleOpts{mtu: 1420}))

	b := testBundle(cfg, bundleOpts{mtu: 1380})
	for name, content := range b.Files {
		if err := os.WriteFile(realPath(cfg, "opnmesh0", name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	h.calls = nil
	mustApply(t, cfg, b)
	if !h.called("ip link del opnmesh0") || !h.called("wg-quick up "+realPath(cfg, "opnmesh0", "wireguard.conf")) {
		t.Fatalf("the interface was not rebuilt for a pending MTU change: %v", h.calls)
	}

	// Once applied, the same configuration again is the no-change shortcut.
	h.calls = nil
	mustApply(t, cfg, b)
	if h.calledPrefix("wg-quick") || h.calledPrefix("nft -f") || h.calledPrefix("wg syncconf") {
		t.Errorf("an applied configuration was applied again: %v", h.calls)
	}
}

// A rename whose new interface does not come up goes back to the previous
// interface and its file.
func TestFailedRenameRollsBack(t *testing.T) {
	h := newFakeHost(t)
	cfg := testConfig(t)
	a := testBundle(cfg, bundleOpts{})
	mustApply(t, cfg, a)

	r := testBundle(cfg, bundleOpts{iface: "mesh1"})
	h.failing["wg-quick up "+realPath(cfg, "mesh1", "wireguard.conf")] = "resolving endpoint failed"
	err := applyConfig(cfg, r)
	if err == nil || !strings.Contains(err.Error(), "rolled back") {
		t.Fatalf("expected a rollback, got %v", err)
	}
	if exists(realPath(cfg, "mesh1", "wireguard.conf")) {
		t.Error("the new interface's file was left on disk")
	}
	if got := hashFiles(diskFiles(cfg, "opnmesh0")); got != a.Hash {
		t.Error("the previous interface's files were not put back")
	}
	if !h.ifaces["opnmesh0"] || h.ifaces["mesh1"] {
		t.Errorf("interfaces after rollback: %v", h.ifaces)
	}
	if m := cfg.loadMeta(); m.Interface != "opnmesh0" || m.AppliedHash != a.Hash {
		t.Errorf("meta after rollback: %+v", m)
	}

	delete(h.failing, "wg-quick up "+realPath(cfg, "mesh1", "wireguard.conf"))
	mustApply(t, cfg, r)
	if !h.ifaces["mesh1"] || h.ifaces["opnmesh0"] || exists(realPath(cfg, "opnmesh0", "wireguard.conf")) {
		t.Errorf("rename did not complete: %v", h.ifaces)
	}
}

// Forwarding is never switched on ahead of the firewall, and a first apply
// that fails leaves nothing on disk for `up` to bring up later.
func TestApplyFailsClosed(t *testing.T) {
	h := newFakeHost(t)
	cfg := testConfig(t)
	h.failing["nft -c"] = "syntax error"
	if err := applyConfig(cfg, testBundle(cfg, bundleOpts{})); err == nil {
		t.Fatal("expected the nftables failure to fail the apply")
	}
	if h.forwarding() != "0" {
		t.Error("ip_forward was switched on although the firewall did not load")
	}
	for _, name := range ManagedFiles {
		if p := realPath(cfg, "opnmesh0", name); exists(p) || exists(p+".prev") {
			t.Errorf("%s was left on disk after a failed first apply", p)
		}
	}
	if cfg.loadMeta().AppliedHash != "" {
		t.Error("a failed apply was recorded")
	}

	// The same holds for `up` from files on disk.
	for name, content := range testBundle(cfg, bundleOpts{}).Files {
		if err := os.WriteFile(realPath(cfg, "opnmesh0", name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := applyFromDisk(cfg); err == nil {
		t.Fatal("up succeeded without its firewall")
	}
	if h.forwarding() != "0" || h.ifaces["opnmesh0"] {
		t.Error("up switched on forwarding or the tunnel without the firewall")
	}
	delete(h.failing, "nft -c")
	if err := os.Remove(realPath(cfg, "opnmesh0", "nftables.conf")); err != nil {
		t.Fatal(err)
	}
	if err := applyFromDisk(cfg); err == nil || !strings.Contains(err.Error(), "without") {
		t.Fatalf("up without nftables.conf: %v", err)
	}
	if h.forwarding() != "0" || h.ifaces["opnmesh0"] {
		t.Error("up without nftables.conf switched on forwarding or the tunnel")
	}
}

func TestApplyRefusesIncompleteBundles(t *testing.T) {
	h := newFakeHost(t)
	cfg := testConfig(t)
	cases := map[string]*ConfigResponse{
		"no nftables.conf":         testBundle(cfg, bundleOpts{omit: "nftables.conf"}),
		"no sysctl.conf":           testBundle(cfg, bundleOpts{omit: "sysctl.conf"}),
		"no wireguard.conf":        testBundle(cfg, bundleOpts{omit: "wireguard.conf"}),
		"empty table":              testBundle(cfg, bundleOpts{nft: "table inet opnmesh {}\n"}),
		"comment only":             testBundle(cfg, bundleOpts{nft: "# nothing\n"}),
		"interface named nftables": testBundle(cfg, bundleOpts{iface: "nftables"}),
		"interface named sysctl":   testBundle(cfg, bundleOpts{iface: "sysctl"}),
		"default route":            testBundle(cfg, bundleOpts{allowed: "0.0.0.0/0"}),
	}
	for name, b := range cases {
		if err := applyConfig(cfg, b); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	entries, _ := os.ReadDir(cfg.ConfDir)
	if len(entries) != 1 {
		t.Errorf("a refused bundle wrote files: %v", entries)
	}
	if len(h.calls) != 0 {
		t.Errorf("a refused bundle ran commands: %v", h.calls)
	}
}

// The run loop's upkeep puts the firewall back when something outside the
// agent removes it, and retries a failed reload only now and then.
func TestFirewallIsReloadedWhenItVanishes(t *testing.T) {
	h := newFakeHost(t)
	cfg := testConfig(t)
	mustApply(t, cfg, testBundle(cfg, bundleOpts{}))
	k := newTunnelKeeper()

	h.table = false // nft flush ruleset
	k.maintain(cfg)
	if !h.table {
		t.Fatal("the missing table was not reloaded")
	}
	h.calls = nil
	k.maintain(cfg)
	if h.calledPrefix("nft -f") {
		t.Error("a present table was reloaded")
	}

	h.table = false
	h.failing["nft -c"] = "nft is broken"
	k.maintain(cfg)
	k.maintain(cfg)
	n := 0
	for _, c := range h.calls {
		if strings.HasPrefix(c, "nft -c") {
			n++
		}
	}
	if n != 1 {
		t.Errorf("a failed reload was retried %d times within %s", n, firewallRetryEvery)
	}
}

func TestReconcileRoutesDeletesFirst(t *testing.T) {
	h := newFakeHost(t)
	h.routes = `[{"dst":"10.99.0.0/24","protocol":"kernel"},{"dst":"default","protocol":"boot"},{"dst":"10.50.0.0/24","protocol":"boot"}]`
	h.failing["ip -4 route add 10.88.0.0/24"] = "RTNETLINK answers: Invalid argument"
	conf := "[Peer]\nPublicKey = " + testKey + "\nAllowedIPs = 10.99.0.2/32, 10.88.0.0/24, 192.168.20.0/24\n"
	if err := reconcileRoutes("opnmesh0", conf); err == nil {
		t.Fatal("the failed route add was not reported")
	}
	var routeCalls []string
	for _, c := range h.calls {
		if strings.HasPrefix(c, "ip -4 route") {
			routeCalls = append(routeCalls, c)
		}
	}
	want := []string{
		"ip -4 route del 0.0.0.0/0 dev opnmesh0",
		"ip -4 route del 10.50.0.0/24 dev opnmesh0",
		"ip -4 route add 10.88.0.0/24 dev opnmesh0",
		"ip -4 route add 192.168.20.0/24 dev opnmesh0",
	}
	if strings.Join(routeCalls, "\n") != strings.Join(want, "\n") {
		t.Errorf("route calls:\n%s\nwant:\n%s", strings.Join(routeCalls, "\n"), strings.Join(want, "\n"))
	}
}

// ufw follows the checked ListenPort in wireguard.conf, and the rule for a
// port the gateway has moved away from goes.
func TestUfwFollowsTheListenPort(t *testing.T) {
	h := newFakeHost(t)
	h.ufwActive = true
	cfg := testConfig(t)
	mustApply(t, cfg, testBundle(cfg, bundleOpts{port: 51820}))
	if !h.called("ufw allow 51820/udp comment OPNmesh WireGuard") {
		t.Fatalf("port not opened: %v", h.calls)
	}
	h.calls = nil
	mustApply(t, cfg, testBundle(cfg, bundleOpts{port: 51821}))
	if !h.called("ufw allow 51821/udp comment OPNmesh WireGuard") || !h.called("ufw delete allow 51820/udp") {
		t.Fatalf("port move not followed: %v", h.calls)
	}
	if p := cfg.loadMeta().ListenPort; p != 51821 {
		t.Errorf("recorded port %d", p)
	}
}
