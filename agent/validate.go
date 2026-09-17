package main

// Every file the controller sends is checked here before it reaches disk or
// the kernel, and again before the files on disk are brought up. The
// controller is authenticated, not trusted: wg-quick runs hooks as root
// through a shell, sysctl reaches the whole kernel and `nft -f` can rewrite
// every firewall table, so each file may hold only what the generator writes.

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// validateFiles checks every managed file that is present.
func validateFiles(files map[string]string, confDir string) error {
	if wg, ok := files["wireguard.conf"]; ok {
		if err := validateWireGuard(wg, confDir); err != nil {
			return err
		}
	}
	if s, ok := files["sysctl.conf"]; ok {
		if _, err := parseSysctl(s); err != nil {
			return err
		}
	}
	if nft, ok := files["nftables.conf"]; ok {
		if err := validateNftables(nft); err != nil {
			return err
		}
	}
	return nil
}

// --- WireGuard -------------------------------------------------------------------

// allowedPostUp is the only hook the controller may place in the WireGuard
// config: loading this gateway's own private key from a path under ConfDir.
var allowedPostUp = regexp.MustCompile(`^wg set %i private-key ([A-Za-z0-9._/-]+)$`)

// splitWgLine reads a line the way wg-quick does: everything from the first
// '#' is a comment, the key is what precedes the first '=' and the value
// what follows it, each trimmed.
func splitWgLine(raw string) (line, key, value string, hasEq bool) {
	if i := strings.IndexByte(raw, '#'); i >= 0 {
		raw = raw[:i]
	}
	line = strings.Trim(raw, " \t")
	key, value, hasEq = strings.Cut(line, "=")
	return line, strings.Trim(key, " \t"), strings.Trim(value, " \t"), hasEq
}

// validateWireGuard accepts only the sections, keys and values the generator
// writes. wg-quick runs PreUp, PostUp and the like as root through a shell,
// matches keys without regard to case and drops NUL bytes as it reads, so
// this is an allowlist over a file already free of control characters
// rather than a search for dangerous keys.
func validateWireGuard(conf, confDir string) error {
	if err := checkText("WireGuard config", conf, true); err != nil {
		return err
	}
	confDir = filepath.Clean(confDir)
	section := ""
	for n, raw := range strings.Split(conf, "\n") {
		line, key, value, hasEq := splitWgLine(raw)
		fail := func(format string, args ...any) error {
			return fmt.Errorf("refusing WireGuard config: line %d: %s", n+1, fmt.Sprintf(format, args...))
		}
		switch {
		case line == "":
			continue
		case strings.HasPrefix(line, "["):
			// wg-quick compares section headers case-insensitively too.
			switch asciiLower(line) {
			case "[interface]":
				section = "Interface"
			case "[peer]":
				section = "Peer"
			default:
				return fail("unknown section %q", line)
			}
			continue
		case !hasEq:
			return fail("%q is not a section, a comment or key = value", line)
		case section == "":
			return fail("%s comes before any section", key)
		}
		var err error
		switch section + "." + asciiLower(key) {
		case "Interface.address", "Peer.allowedips":
			err = checkPrefixes(value)
		case "Interface.listenport":
			err = checkNumber(value, 1, 65535)
		case "Interface.mtu":
			err = checkNumber(value, 68, 65535)
		case "Interface.postup":
			err = checkPostUp(value, confDir)
		case "Peer.publickey", "Peer.presharedkey":
			err = checkWgKey(value)
		case "Peer.endpoint":
			err = checkEndpoint(value)
		case "Peer.persistentkeepalive":
			if value != "off" {
				err = checkNumber(value, 0, 65535)
			}
		default:
			return fail("%s is not allowed in [%s]", key, section)
		}
		if err != nil {
			return fail("%s: %v", key, err)
		}
	}
	return nil
}

func checkPostUp(value, confDir string) error {
	m := allowedPostUp.FindStringSubmatch(value)
	if m == nil {
		return fmt.Errorf("it may only load the private key, got %q", value)
	}
	p := filepath.Clean(m[1])
	if p != confDir && !strings.HasPrefix(p, confDir+string(os.PathSeparator)) {
		return fmt.Errorf("private-key path %q is outside %s", m[1], confDir)
	}
	return nil
}

// checkNumber accepts plain decimal digits within [lo, hi].
func checkNumber(value string, lo, hi int) error {
	n, err := strconv.Atoi(value)
	if err != nil || strings.Trim(value, "0123456789") != "" || n < lo || n > hi {
		return fmt.Errorf("%q is not a number from %d to %d", value, lo, hi)
	}
	return nil
}

func checkWgKey(value string) error {
	if b, err := base64.StdEncoding.Strict().DecodeString(value); err != nil || len(b) != 32 {
		return fmt.Errorf("%q is not a WireGuard key", value)
	}
	return nil
}

// checkPrefixes accepts a comma-separated list of addresses, each with or
// without a prefix length, as Address and AllowedIPs take.
func checkPrefixes(value string) error {
	for _, item := range strings.Split(value, ",") {
		item = strings.Trim(item, " \t")
		if _, err := netip.ParsePrefix(item); err == nil {
			continue
		}
		if a, err := netip.ParseAddr(item); err == nil && a.Zone() == "" {
			continue
		}
		return fmt.Errorf("%q is not an address or prefix", item)
	}
	return nil
}

func checkEndpoint(value string) error {
	host, port, err := net.SplitHostPort(value)
	if err != nil {
		return fmt.Errorf("%q is not host:port", value)
	}
	if err := checkNumber(port, 1, 65535); err != nil {
		return err
	}
	if a, err := netip.ParseAddr(host); err == nil && a.Zone() == "" {
		return nil
	}
	if !isHostname(host) {
		return fmt.Errorf("%q is neither an address nor a host name", host)
	}
	return nil
}

var hostnameLabel = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)

// isHostname is the controller's RFC 1123 check for endpoint names.
func isHostname(s string) bool {
	if s == "" || len(s) > 253 {
		return false
	}
	for _, label := range strings.Split(s, ".") {
		if !hostnameLabel.MatchString(label) {
			return false
		}
	}
	return true
}

// --- sysctl ------------------------------------------------------------------------

// sysctlAllowed lists every kernel setting the controller may change and the
// values it may give it. The generator only ever turns forwarding on.
var sysctlAllowed = map[string][]string{
	"net.ipv4.ip_forward": {"0", "1"},
}

type sysctlSetting struct{ Key, Value string }

func parseSysctl(conf string) ([]sysctlSetting, error) {
	if err := checkText("sysctl.conf", conf, true); err != nil {
		return nil, err
	}
	var out []sysctlSetting
	for n, raw := range strings.Split(conf, "\n") {
		line := strings.Trim(raw, " \t")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		key, value = strings.Trim(key, " \t"), strings.Trim(value, " \t")
		switch {
		case !ok:
			return nil, fmt.Errorf("refusing sysctl.conf: line %d is not key = value", n+1)
		case sysctlAllowed[key] == nil:
			return nil, fmt.Errorf("refusing sysctl %q", key)
		case !slices.Contains(sysctlAllowed[key], value):
			return nil, fmt.Errorf("refusing sysctl %s = %q", key, value)
		}
		out = append(out, sysctlSetting{Key: key, Value: value})
	}
	return out, nil
}

// --- nftables ----------------------------------------------------------------------

// nftTopLevel is everything the generated file says outside the body of its
// own table: create table inet opnmesh if it is missing, then delete it, so
// the definition that follows replaces it whole. Anything else there (flush
// ruleset, other tables, adding to or deleting other objects) is refused.
// The body stays free-form: nothing inside a table can reach another one.
var nftTopLevel = map[string]bool{
	"table inet opnmesh {}":     true,
	"delete table inet opnmesh": true,
}

const nftTableOpen = "table inet opnmesh {"

var nftInclude = regexp.MustCompile(`(?i)\binclude\b`)

// validateNftables follows the file's structure the way nft's scanner does:
// double-quoted strings without escapes, and '#' outside them starting a
// comment. Backslashes and single quotes, which could make the two readings
// differ, are refused outright, as is a string left open at the end of a
// line.
func validateNftables(conf string) error {
	if err := checkText("nftables.conf", conf, false); err != nil {
		return err
	}
	depth := 0
	for n, line := range strings.Split(conf, "\n") {
		fail := func(format string, args ...any) error {
			return fmt.Errorf("refusing nftables.conf: line %d: %s", n+1, fmt.Sprintf(format, args...))
		}
		startDepth := depth
		inString := false
		// code is the line without its comment; top is the part of it that
		// sits outside every block, braces included.
		var code, top strings.Builder
	scan:
		for i := 0; i < len(line); i++ {
			c := line[i]
			before := depth
			switch {
			case c == '#' && !inString:
				break scan
			case c == '\\' || c == '\'':
				return fail("%q is not allowed", c)
			case c == '"':
				inString = !inString
			case inString:
			case c == '{':
				depth++
			case c == '}':
				if depth == 0 {
					return fail("unbalanced }")
				}
				depth--
			}
			code.WriteByte(c)
			if before == 0 || depth == 0 {
				top.WriteByte(c)
			}
		}
		if inString {
			return fail("a quoted string does not end on this line")
		}
		if nftInclude.MatchString(code.String()) {
			return fail("include is not allowed")
		}
		stmt := strings.Join(strings.Fields(top.String()), " ")
		switch {
		case stmt == "":
		case startDepth == 0 && depth == 0 && nftTopLevel[stmt]:
		case startDepth == 0 && depth > 0 && stmt == nftTableOpen:
		case startDepth > 0 && depth == 0 && stmt == "}":
		default:
			return fail("%q is not allowed outside table inet opnmesh", stmt)
		}
	}
	if depth != 0 {
		return errors.New("refusing nftables.conf: a block is never closed")
	}
	return nil
}
