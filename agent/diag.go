package main

// Health checks run on the gateway when the controller asks (via the
// telemetry response). Everything here is read-only apart from the router
// probe's own policy-routing rule and table entry, which are removed again
// as soon as the probe finishes.

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
)

type DiagNet struct {
	CIDR  string `json:"cidr"`
	IP    string `json:"ip"`
	Label string `json:"label"`
	// Whether this gateway's own route table should send the network into
	// the tunnel. False for the tunnel address ranges: roaming clients get
	// per-client /32 routes and the gateway range is a connected route.
	TunnelRoute bool `json:"tunnelRoute"`
}

type DiagTarget struct {
	IP    string `json:"ip"`
	Label string `json:"label"`
}

type DiagHost struct {
	Host  string `json:"host"`
	Label string `json:"label"`
}

// DiagRequest mirrors AgentDiagRequest on the controller.
type DiagRequest struct {
	ID            string       `json:"id"`
	ListenPort    int          `json:"listenPort"`
	MTU           int          `json:"mtu"`
	LanIP         string       `json:"lanIp"`
	RemoteNets    []DiagNet    `json:"remoteNets"`
	RouterTest    bool         `json:"routerTest"`
	MTUTargets    []DiagTarget `json:"mtuTargets"`
	EndpointHosts []DiagHost   `json:"endpointHosts"`
}

type DiagAction struct {
	Type    string      `json:"type"`
	Request DiagRequest `json:"request"`
}

type Check struct {
	ID     string `json:"id"`
	Status string `json:"status"` // pass | warn | fail | skip
	Title  string `json:"title"`
	Detail string `json:"detail"`
	Hint   string `json:"hint,omitempty"`
}

type DiagReport struct {
	ID     string  `json:"id"`
	RanAt  int64   `json:"ranAt"`
	Checks []Check `json:"checks"`
}

// dispatchDiagnostics starts a run for a request we have not seen before.
// It runs in the background so per-second reports keep flowing meanwhile.
func dispatchDiagnostics(cfg Config, client *Client, resp TelemetryResponse, last *string) {
	for _, a := range resp.Actions {
		if a.Type != "diagnose" || a.Request.ID == "" || a.Request.ID == *last {
			continue
		}
		*last = a.Request.ID
		go func(req DiagRequest) {
			log.Printf("running health checks (%s)", req.ID)
			report := runDiagnostics(cfg, req)
			if err := client.SendDiagnostics(report); err != nil {
				log.Printf("send health checks: %v", err)
			} else {
				log.Printf("health checks done: %s", summarise(report.Checks))
			}
		}(a.Request)
	}
}

func summarise(checks []Check) string {
	n := map[string]int{}
	for _, c := range checks {
		n[c.Status]++
	}
	return fmt.Sprintf("%d pass, %d warn, %d fail, %d skipped", n["pass"], n["warn"], n["fail"], n["skip"])
}

func runDiagnostics(cfg Config, req DiagRequest) DiagReport {
	meta := cfg.loadMeta()
	iface := meta.Interface
	checks := []Check{checkForwarding()}
	checks = append(checks, checkInterface(iface, req.ListenPort)...)
	checks = append(checks, checkFirewall())
	if c, ok := checkUfw(req.ListenPort); ok {
		checks = append(checks, c)
	}
	checks = append(checks, checkEndpoints(req.EndpointHosts)...)
	checks = append(checks, checkRoutes(iface, req.RemoteNets)...)
	checks = append(checks, checkRouter(req)...)
	checks = append(checks, checkMTU(req)...)
	return DiagReport{ID: req.ID, RanAt: time.Now().UnixMilli(), Checks: checks}
}

// --- kernel, interface, firewall ---------------------------------------------

func checkForwarding() Check {
	data, err := os.ReadFile("/proc/sys/net/ipv4/ip_forward")
	if err == nil && strings.TrimSpace(string(data)) == "1" {
		return Check{ID: "forwarding", Status: "pass", Title: "IP forwarding is on", Detail: "The kernel passes packets between the tunnel and the LAN."}
	}
	return Check{ID: "forwarding", Status: "fail", Title: "IP forwarding is off",
		Detail: "Packets arriving over the tunnel are dropped instead of being sent on to the LAN, and vice versa.",
		Hint:   "Run `sysctl -w net.ipv4.ip_forward=1` on the VM. The agent's sysctl.conf normally sets it, so look for an override in /etc/sysctl.d."}
}

func checkInterface(iface string, port int) []Check {
	if !wgInterfaceExists(iface) {
		return []Check{{ID: "interface", Status: "fail", Title: "Tunnel interface " + iface + " is down",
			Detail: "WireGuard is not running on this VM.",
			Hint:   "`opnmesh-gw up` brings it up from the files on disk; `journalctl -u opnmesh-gw` shows why it went down."}}
	}
	out := []Check{{ID: "interface", Status: "pass", Title: "Tunnel interface " + iface + " is up", Detail: "WireGuard is running with the configuration on disk."}}
	lp, _ := runCmd("wg", "show", iface, "listen-port")
	actual, _ := strconv.Atoi(strings.TrimSpace(lp))
	switch {
	case port > 0 && actual > 0 && actual != port:
		out = append(out, Check{ID: "listen-port", Status: "warn", Title: fmt.Sprintf("Listening on UDP %d, expected %d", actual, port),
			Detail: "The running interface uses a different port from the one other sites are told to dial.",
			Hint:   "Restart the agent (`systemctl restart opnmesh-gw`) so it reapplies the configuration."})
	case actual > 0:
		out = append(out, Check{ID: "listen-port", Status: "pass", Title: fmt.Sprintf("Listening on UDP port %d", actual), Detail: "This is the port the router must forward for incoming tunnels."})
	}
	return out
}

func checkFirewall() Check {
	if _, err := runCmd("nft", "list", "table", "inet", "opnmesh"); err != nil {
		return Check{ID: "firewall", Status: "fail", Title: "Firewall rules are not loaded",
			Detail: "Table inet opnmesh is missing, so nothing is forwarded and no traffic is counted.",
			Hint:   "`opnmesh-gw up` reloads the rules from /etc/opnmesh; if nft itself rejects the file, `journalctl -u opnmesh-gw` has the error."}
	}
	return Check{ID: "firewall", Status: "pass", Title: "Firewall rules are loaded", Detail: "Table inet opnmesh is present with its forwarding rules and counters."}
}

func checkUfw(port int) (Check, bool) {
	if port <= 0 {
		return Check{}, false
	}
	if _, err := exec.LookPath("ufw"); err != nil {
		return Check{}, false
	}
	out, err := exec.Command("ufw", "status").CombinedOutput()
	if err != nil || !strings.Contains(string(out), "Status: active") {
		return Check{}, false
	}
	want := fmt.Sprintf("%d/udp", port)
	if strings.Contains(string(out), want) {
		return Check{ID: "ufw", Status: "pass", Title: "ufw allows UDP " + strconv.Itoa(port), Detail: "The host firewall lets tunnel packets in."}, true
	}
	return Check{ID: "ufw", Status: "warn", Title: "ufw is active with no rule for UDP " + strconv.Itoa(port),
		Detail: "Incoming tunnel packets may be blocked by the host firewall.",
		Hint:   "Run `ufw allow " + want + "` on the VM."}, true
}

// --- names and routes ---------------------------------------------------------

func checkEndpoints(hosts []DiagHost) []Check {
	var out []Check
	for _, h := range hosts {
		addrs, err := net.LookupHost(h.Host)
		if err != nil || len(addrs) == 0 {
			out = append(out, Check{ID: "dns:" + h.Host, Status: "fail", Title: "Cannot resolve " + h.Host,
				Detail: "This is the public name of " + h.Label + "; without an address the tunnel cannot be dialled.",
				Hint:   "Check DNS works on this VM (`resolvectl status`) and that the name has a record. A dynamic DNS name may have stopped updating."})
			continue
		}
		out = append(out, Check{ID: "dns:" + h.Host, Status: "pass", Title: h.Host + " resolves", Detail: h.Label + " is at " + addrs[0] + "."})
	}
	return out
}

func checkRoutes(iface string, all []DiagNet) []Check {
	var nets []DiagNet
	for _, n := range all {
		if n.TunnelRoute {
			nets = append(nets, n)
		}
	}
	if len(nets) == 0 {
		return nil
	}
	var bad []Check
	for _, n := range nets {
		dev, err := routeDevFor(n.IP)
		if err != nil {
			bad = append(bad, Check{ID: "route:" + n.CIDR, Status: "warn", Title: "Could not look up the route for " + n.CIDR, Detail: err.Error()})
			continue
		}
		if dev != iface {
			via := dev
			if via == "" {
				via = "nowhere"
			}
			bad = append(bad, Check{ID: "route:" + n.CIDR, Status: "fail", Title: "No tunnel route for " + n.CIDR,
				Detail: "Traffic for " + n.Label + " would leave via " + via + " instead of the tunnel.",
				Hint:   "Restart the agent so it re-applies its routes. A conflicting local route, or another VPN on this VM, can also cause this."})
		}
	}
	if len(bad) > 0 {
		return bad
	}
	return []Check{{ID: "routes", Status: "pass", Title: fmt.Sprintf("All %d remote networks route via %s", len(nets), iface), Detail: "This gateway sends traffic for every other site into the tunnel."}}
}

func routeDevFor(ip string) (string, error) {
	out, err := runCmd("ip", "-j", "route", "get", ip)
	if err != nil {
		return "", err
	}
	return parseRouteGetDev(out)
}

func parseRouteGetDev(jsonText string) (string, error) {
	var routes []struct {
		Dev string `json:"dev"`
	}
	if err := json.Unmarshal([]byte(jsonText), &routes); err != nil {
		return "", err
	}
	if len(routes) == 0 {
		return "", errors.New("no route")
	}
	return routes[0].Dev, nil
}

// --- the site router ------------------------------------------------------------

// checkRouter proves whether the site router sends each remote network back
// to this gateway. A probe addressed to a host in that network is handed to
// the router with TTL 2 (so it cannot travel further than one hop beyond it);
// if the router has the static route, the packet comes straight back to us
// and we see it on the LAN interface. If it does not, the packet leaves for
// the internet and never returns. The probe is steered to the router by a
// policy-routing rule for its own source address, so an existing tunnel
// route for the same destination cannot capture it and no other traffic on
// the gateway is affected while the test runs.
func checkRouter(req DiagRequest) []Check {
	if !req.RouterTest {
		return []Check{{ID: "router-routes", Status: "skip", Title: "Router route test not needed",
			Detail: "In the masquerade layout the router needs no routes: traffic to other sites is translated to this gateway's own address."}}
	}
	if len(req.RemoteNets) == 0 {
		return []Check{{ID: "router-routes", Status: "skip", Title: "No remote networks to test yet", Detail: "Add networks at other sites first."}}
	}
	dev, router, err := defaultRoute()
	if err != nil {
		return []Check{{ID: "router-routes", Status: "fail", Title: "Cannot find the site router", Detail: err.Error(),
			Hint: "The VM needs a default route via the site router for the router test and for reaching the internet."}}
	}
	var out []Check
	for _, n := range req.RemoteNets {
		id := "router-route:" + n.CIDR
		ok, err := routerForwardsToUs(dev, router, n.IP)
		switch {
		case err != nil:
			out = append(out, Check{ID: id, Status: "warn", Title: "Could not test the router route for " + n.CIDR, Detail: err.Error()})
		case ok:
			out = append(out, Check{ID: id, Status: "pass", Title: "Router sends " + n.CIDR + " to this gateway",
				Detail: "A test packet for " + n.IP + " handed to " + router + " came straight back here."})
		default:
			out = append(out, Check{ID: id, Status: "fail", Title: "Router is not sending " + n.CIDR + " to this gateway",
				Detail: "A test packet for " + n.IP + " handed to " + router + " did not come back, so hosts at this site cannot reach " + n.Label + ".",
				Hint:   "Add a static route on the router: " + n.CIDR + " via " + req.LanIP + ". The Router panel lists every route it needs."})
		}
	}
	return out
}

func defaultRoute() (dev, gateway string, err error) {
	out, err := runCmd("ip", "-j", "route", "show", "default")
	if err != nil {
		return "", "", err
	}
	return parseDefaultRoute(out)
}

func parseDefaultRoute(jsonText string) (string, string, error) {
	var routes []struct {
		Dev     string `json:"dev"`
		Gateway string `json:"gateway"`
	}
	if err := json.Unmarshal([]byte(jsonText), &routes); err != nil {
		return "", "", err
	}
	for _, r := range routes {
		if r.Gateway != "" && r.Dev != "" {
			return r.Dev, r.Gateway, nil
		}
	}
	return "", "", errors.New("no default route via a router")
}

func htons(v uint16) uint16 { return v<<8 | v>>8 }

// The probe's own routing table and rule preference. A rule keyed on the
// probe's source address sends only the probe via the router; nothing else
// on the gateway is rerouted, and the main table is never touched, so a
// destination that already has a tunnel route (a connected roaming client's
// /32, say) cannot shadow the test.
const probeTable = "250"
const probePref = "11000"

// sourceFor returns the address the kernel would use to talk to the router.
func sourceFor(router string) (string, error) {
	out, err := runCmd("ip", "-j", "route", "get", router)
	if err != nil {
		return "", err
	}
	return parseRouteGetSrc(out)
}

func parseRouteGetSrc(jsonText string) (string, error) {
	var routes []struct {
		Prefsrc string `json:"prefsrc"`
	}
	if err := json.Unmarshal([]byte(jsonText), &routes); err != nil {
		return "", err
	}
	if len(routes) == 0 || routes[0].Prefsrc == "" {
		return "", errors.New("no source address for the router")
	}
	return routes[0].Prefsrc, nil
}

func routerForwardsToUs(dev, router, target string) (bool, error) {
	dst := net.ParseIP(target).To4()
	if dst == nil {
		return false, fmt.Errorf("bad target %q", target)
	}
	ifi, err := net.InterfaceByName(dev)
	if err != nil {
		return false, err
	}
	src, err := sourceFor(router)
	if err != nil {
		return false, err
	}
	// Route the probe to the router through its own table, selected only for
	// packets from our address to the target.
	if _, err := runCmd("ip", "route", "replace", target+"/32", "via", router, "dev", dev, "table", probeTable); err != nil {
		return false, err
	}
	defer func() {
		_, _ = runCmd("ip", "route", "del", target+"/32", "via", router, "dev", dev, "table", probeTable)
	}()
	rule := []string{"from", src, "to", target + "/32", "lookup", probeTable, "pref", probePref}
	_, _ = runCmd("ip", append([]string{"rule", "del"}, rule...)...) // a leftover from an interrupted run
	if _, err := runCmd("ip", append([]string{"rule", "add"}, rule...)...); err != nil {
		return false, err
	}
	defer func() { _, _ = runCmd("ip", append([]string{"rule", "del"}, rule...)...) }()

	fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW, int(htons(syscall.ETH_P_IP)))
	if err != nil {
		return false, fmt.Errorf("packet socket: %w", err)
	}
	defer syscall.Close(fd)
	if err := syscall.Bind(fd, &syscall.SockaddrLinklayer{Protocol: htons(syscall.ETH_P_IP), Ifindex: ifi.Index}); err != nil {
		return false, fmt.Errorf("bind packet socket: %w", err)
	}
	tv := syscall.NsecToTimeval(int64(200 * time.Millisecond))
	_ = syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &tv)

	var rb [8]byte
	_, _ = rand.Read(rb[:])
	marker := []byte("opnmesh-diag-" + hex.EncodeToString(rb[:]))

	// Bound to our address so the rule above matches this socket and nothing else.
	conn, err := net.DialUDP("udp4", &net.UDPAddr{IP: net.ParseIP(src)}, &net.UDPAddr{IP: dst, Port: 33434})
	if err != nil {
		return false, err
	}
	defer conn.Close()
	if sc, err := conn.SyscallConn(); err == nil {
		_ = sc.Control(func(fd uintptr) { _ = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, syscall.IP_TTL, 2) })
	}

	deadline := time.Now().Add(1500 * time.Millisecond)
	next := time.Now()
	buf := make([]byte, 2048)
	for time.Now().Before(deadline) {
		if !time.Now().Before(next) {
			_, _ = conn.Write(marker)
			next = time.Now().Add(400 * time.Millisecond)
		}
		n, from, err := syscall.Recvfrom(fd, buf, 0)
		if err != nil {
			continue // read timeout; send again if due
		}
		if sll, ok := from.(*syscall.SockaddrLinklayer); ok && sll.Pkttype == syscall.PACKET_OUTGOING {
			continue // our own probe on the way out
		}
		if frameCarries(buf[:n], dst, marker) {
			return true, nil
		}
	}
	return false, nil
}

// frameCarries reports whether an Ethernet frame is an IPv4/UDP packet to dst
// whose payload contains marker.
func frameCarries(frame []byte, dst net.IP, marker []byte) bool {
	if len(frame) < 14+20 || binary.BigEndian.Uint16(frame[12:14]) != 0x0800 {
		return false
	}
	ip := frame[14:]
	ihl := int(ip[0]&0x0f) * 4
	if ihl < 20 || len(ip) < ihl+8 || ip[9] != 17 {
		return false
	}
	if !net.IP(ip[16:20]).Equal(dst.To4()) {
		return false
	}
	return bytes.Contains(ip[ihl+8:], marker)
}

// --- packet size --------------------------------------------------------------

func checkMTU(req DiagRequest) []Check {
	mtu := req.MTU
	if mtu <= 0 {
		mtu = 1420
	}
	var out []Check
	for _, t := range req.MTUTargets {
		id := "mtu:" + t.IP
		small, err := icmpEcho(t.IP, 56, false, 1500*time.Millisecond)
		if err != nil {
			out = append(out, Check{ID: id, Status: "warn", Title: "Could not ping " + t.Label, Detail: err.Error()})
			continue
		}
		if !small {
			out = append(out, Check{ID: id, Status: "skip", Title: "Packet-size test skipped for " + t.Label, Detail: "The tunnel to " + t.Label + " is not answering pings at all; see the tunnel checks."})
			continue
		}
		big, err := icmpEcho(t.IP, mtu-28, true, 2*time.Second)
		switch {
		case err != nil && errors.Is(err, syscall.EMSGSIZE):
			out = append(out, Check{ID: id, Status: "fail", Title: "Path to " + t.Label + " cannot carry full-size packets",
				Detail: fmt.Sprintf("The kernel refuses a %d-byte packet on this path; large transfers will stall.", mtu),
				Hint:   "Lower the tunnel MTU in Settings (1380 suits most PPPoE and mobile links) so every gateway re-applies it."})
		case err != nil:
			out = append(out, Check{ID: id, Status: "warn", Title: "Could not test packet size to " + t.Label, Detail: err.Error()})
		case big:
			out = append(out, Check{ID: id, Status: "pass", Title: "Full-size packets reach " + t.Label, Detail: fmt.Sprintf("A %d-byte ping with fragmentation forbidden came back.", mtu)})
		default:
			out = append(out, Check{ID: id, Status: "warn", Title: "Large packets to " + t.Label + " get no reply",
				Detail: fmt.Sprintf("Small pings work but a %d-byte packet with fragmentation forbidden did not come back.", mtu),
				Hint:   "Something between the two gateways drops large packets. Try a lower tunnel MTU in Settings (1380) and re-run."})
		}
	}
	return out
}

// icmpEcho sends one echo with the given payload size and waits for its reply.
// With df set, the kernel refuses to fragment (EMSGSIZE) rather than send.
func icmpEcho(ip string, payload int, df bool, timeout time.Duration) (bool, error) {
	c, err := net.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		return false, err
	}
	defer c.Close()
	if df {
		if sc, ok := c.(interface {
			SyscallConn() (syscall.RawConn, error)
		}); ok {
			if raw, err := sc.SyscallConn(); err == nil {
				_ = raw.Control(func(fd uintptr) {
					_ = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, syscall.IP_MTU_DISCOVER, syscall.IP_PMTUDISC_DO)
				})
			}
		}
	}
	id := os.Getpid() & 0xffff
	seq := int(time.Now().UnixNano() & 0x7fff)
	data := make([]byte, payload)
	for i := range data {
		data[i] = byte(i)
	}
	msg := icmp.Message{Type: ipv4.ICMPTypeEcho, Code: 0, Body: &icmp.Echo{ID: id, Seq: seq, Data: data}}
	b, err := msg.Marshal(nil)
	if err != nil {
		return false, err
	}
	if _, err := c.WriteTo(b, &net.IPAddr{IP: net.ParseIP(ip)}); err != nil {
		return false, err
	}
	_ = c.SetReadDeadline(time.Now().Add(timeout))
	buf := make([]byte, 65536)
	for {
		n, _, err := c.ReadFrom(buf)
		if err != nil {
			return false, nil
		}
		m, err := icmp.ParseMessage(1, buf[:n])
		if err != nil || m.Type != ipv4.ICMPTypeEchoReply {
			continue
		}
		if e, ok := m.Body.(*icmp.Echo); ok && e.ID == id && e.Seq == seq {
			return true, nil
		}
	}
}
