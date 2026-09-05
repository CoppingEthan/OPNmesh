package main

import (
	"encoding/binary"
	"net"
	"testing"
)

func TestParseDefaultRoute(t *testing.T) {
	dev, gw, err := parseDefaultRoute(`[{"dst":"default","gateway":"10.0.250.1","dev":"eth0","protocol":"static","flags":[]}]`)
	if err != nil || dev != "eth0" || gw != "10.0.250.1" {
		t.Fatalf("got %q %q %v", dev, gw, err)
	}
	if _, _, err := parseDefaultRoute(`[]`); err == nil {
		t.Fatal("expected an error with no default route")
	}
	// A default route without a gateway (point-to-point) is not a router.
	if _, _, err := parseDefaultRoute(`[{"dst":"default","dev":"ppp0"}]`); err == nil {
		t.Fatal("expected an error for a gateway-less default")
	}
}

func TestParseRouteGetSrc(t *testing.T) {
	src, err := parseRouteGetSrc(`[{"dst":"192.168.20.1","dev":"eth0","prefsrc":"192.168.20.2","flags":[],"uid":0,"cache":[]}]`)
	if err != nil || src != "192.168.20.2" {
		t.Fatalf("got %q %v", src, err)
	}
	if _, err := parseRouteGetSrc(`[{"dst":"192.168.20.1","dev":"eth0"}]`); err == nil {
		t.Fatal("expected an error without prefsrc")
	}
}

func TestParseRouteGetDev(t *testing.T) {
	dev, err := parseRouteGetDev(`[{"dst":"192.168.20.1","dev":"wg0","prefsrc":"10.99.0.1","flags":[],"uid":0,"cache":[]}]`)
	if err != nil || dev != "wg0" {
		t.Fatalf("got %q %v", dev, err)
	}
}

func buildFrame(dst net.IP, payload []byte) []byte {
	eth := make([]byte, 14)
	binary.BigEndian.PutUint16(eth[12:], 0x0800)
	ip := make([]byte, 20)
	ip[0] = 0x45
	binary.BigEndian.PutUint16(ip[2:], uint16(20+8+len(payload)))
	ip[8] = 1 // ttl
	ip[9] = 17
	copy(ip[12:16], net.ParseIP("192.168.20.2").To4())
	copy(ip[16:20], dst.To4())
	udp := make([]byte, 8)
	binary.BigEndian.PutUint16(udp[0:], 40000)
	binary.BigEndian.PutUint16(udp[2:], 33434)
	binary.BigEndian.PutUint16(udp[4:], uint16(8+len(payload)))
	frame := append(eth, ip...)
	frame = append(frame, udp...)
	return append(frame, payload...)
}

func TestFrameCarries(t *testing.T) {
	marker := []byte("opnmesh-diag-abcdef")
	dst := net.ParseIP("10.0.1.1")
	if !frameCarries(buildFrame(dst, marker), dst, marker) {
		t.Fatal("expected the probe to be recognised")
	}
	if frameCarries(buildFrame(net.ParseIP("10.0.1.2"), marker), dst, marker) {
		t.Fatal("wrong destination must not match")
	}
	if frameCarries(buildFrame(dst, []byte("something else")), dst, marker) {
		t.Fatal("wrong payload must not match")
	}
	short := buildFrame(dst, marker)[:20]
	if frameCarries(short, dst, marker) {
		t.Fatal("truncated frame must not match")
	}
	// Not IPv4.
	arp := buildFrame(dst, marker)
	binary.BigEndian.PutUint16(arp[12:], 0x0806)
	if frameCarries(arp, dst, marker) {
		t.Fatal("non-IP frame must not match")
	}
}

func TestSummarise(t *testing.T) {
	s := summarise([]Check{{Status: "pass"}, {Status: "pass"}, {Status: "fail"}, {Status: "skip"}})
	if s != "2 pass, 0 warn, 1 fail, 1 skipped" {
		t.Fatalf("got %q", s)
	}
}

func TestHtons(t *testing.T) {
	if htons(0x0800) != 0x0008 {
		t.Fatalf("got %#x", htons(0x0800))
	}
}
