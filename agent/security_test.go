package main

import "testing"

func TestIsManagedFileRejectsTraversalAndUnknownNames(t *testing.T) {
	for _, ok := range ManagedFiles {
		if !isManagedFile(ok) {
			t.Fatalf("%q should be managed", ok)
		}
	}
	bad := []string{
		"",
		"../../etc/cron.d/pwn",
		"..",
		"sub/dir.conf",
		`windows\path.conf`,
		"authorized_keys",
		"wg0.conf.bak",
		"/etc/shadow",
	}
	for _, name := range bad {
		if isManagedFile(name) {
			t.Fatalf("%q must be refused", name)
		}
	}
}

func TestSafeVersionRejectsPathTricks(t *testing.T) {
	for _, ok := range []string{"1.4.0", "2.0.0-rc1", "v1", "20240101_build"} {
		if !safeVersion(ok) {
			t.Fatalf("%q should be accepted", ok)
		}
	}
	for _, bad := range []string{"", "..", "../../etc", "1.0/../..", "a/b", ".hidden", "with space", string(make([]byte, 65))} {
		if safeVersion(bad) {
			t.Fatalf("%q must be refused", bad)
		}
	}
}

// A capture "filter" that is really a tcpdump option is root command
// execution on this node — the single most dangerous input the agent takes.
func TestSafeFilterRejectsOptionInjection(t *testing.T) {
	for _, ok := range []string{
		"",
		"host 10.30.5.20",
		"tcp port 443",
		"(src net 10.10.0.0/16) and not port 22",
		"icmp or arp",
	} {
		if !safeFilter(ok) {
			t.Fatalf("%q should be accepted", ok)
		}
	}
	for _, bad := range []string{
		"-z /bin/sh",
		"host 1.2.3.4 -z reboot",
		"-W 1 -C 1 -z curl",
		"--postrotate-command=x",
		"host 1.2.3.4; rm -rf /",
		"host `id`",
		"host $(id)",
		"host 'x'",
	} {
		if safeFilter(bad) {
			t.Fatalf("%q must be refused", bad)
		}
	}
}
