package main

// The metrics exporter is unauthenticated and serves peer public keys and byte
// counters. Its bind address comes from a control-node-supplied settings file,
// so a rogue control node could otherwise publish that data on the gateway
// WAN. safeMetricsBind must keep it on loopback or the private mesh.

import "testing"

func TestSafeMetricsBindRejectsWildcardAndPublic(t *testing.T) {
	// Refused → forced back to loopback.
	for _, bad := range []string{"0.0.0.0", "::", "198.51.100.7", "8.8.8.8", "not-an-ip"} {
		if got := safeMetricsBind(bad); got != "127.0.0.1" {
			t.Fatalf("safeMetricsBind(%q) = %q; want 127.0.0.1 (must not expose the exporter)", bad, got)
		}
	}
	// Permitted → passed through unchanged.
	for _, ok := range []string{"127.0.0.1", "::1", "10.99.0.1", "192.168.1.5", "172.16.0.9"} {
		if got := safeMetricsBind(ok); got != ok {
			t.Fatalf("safeMetricsBind(%q) = %q; want it unchanged (loopback/private is fine)", ok, got)
		}
	}
}
