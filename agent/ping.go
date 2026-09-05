package main

import (
	"net"
	"os"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
)

// pingAll sends one ICMP echo to every target and returns round-trip times
// in milliseconds for those that answered within the deadline. One raw
// socket, all echoes in flight together, so the cost is one deadline, not
// one per peer. Requires root (the agent has it).
func pingAll(targets map[string]string, deadline time.Duration) map[string]float64 {
	out := map[string]float64{}
	if len(targets) == 0 {
		return out
	}
	conn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		return out
	}
	defer conn.Close()

	id := os.Getpid() & 0xffff
	type sent struct {
		key string
		at  time.Time
	}
	bySeq := map[int]sent{}
	seq := 0
	for key, ip := range targets {
		addr := net.ParseIP(ip)
		if addr == nil {
			continue
		}
		seq++
		msg := icmp.Message{
			Type: ipv4.ICMPTypeEcho,
			Code: 0,
			Body: &icmp.Echo{ID: id, Seq: seq, Data: []byte("opnmesh")},
		}
		data, err := msg.Marshal(nil)
		if err != nil {
			continue
		}
		if _, err := conn.WriteTo(data, &net.IPAddr{IP: addr}); err != nil {
			continue
		}
		bySeq[seq] = sent{key: key, at: time.Now()}
	}
	if len(bySeq) == 0 {
		return out
	}
	_ = conn.SetReadDeadline(time.Now().Add(deadline))
	buf := make([]byte, 1500)
	for len(out) < len(bySeq) {
		n, _, err := conn.ReadFrom(buf)
		if err != nil {
			break
		}
		msg, err := icmp.ParseMessage(1, buf[:n])
		if err != nil || msg.Type != ipv4.ICMPTypeEchoReply {
			continue
		}
		echo, ok := msg.Body.(*icmp.Echo)
		if !ok || echo.ID != id {
			continue
		}
		if s, ok := bySeq[echo.Seq]; ok {
			if _, done := out[s.key]; !done {
				out[s.key] = float64(time.Since(s.at).Microseconds()) / 1000.0
			}
		}
	}
	return out
}
