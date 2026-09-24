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
// config: loading this gateway's own private key, which is always
// <ConfDir>/private.key (see checkPostUp).
var allowedPostUp = regexp.MustCompile(`^wg set %i private-key ([A-Za-z0-9._/-]+)$`)

// privateKeyFile is where enrolment writes this gateway's private key.
func privateKeyFile(confDir string) string {
	return filepath.Join(filepath.Clean(confDir), "private.key")
}

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
		case "Interface.address":
			err = checkPrefixes(value)
		case "Peer.allowedips":
			err = checkAllowedIPs(value)
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

// checkPostUp accepts only the hook that loads this gateway's own key file.
// Any other path, even one in ConfDir, could hand wg another root-only file
// (the gateway token, say) to read as a key.
func checkPostUp(value, confDir string) error {
	m := allowedPostUp.FindStringSubmatch(value)
	if m == nil {
		return fmt.Errorf("it may only load the private key, got %q", value)
	}
	if want := privateKeyFile(confDir); m[1] != want {
		return fmt.Errorf("private-key path %q is not %s", m[1], want)
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

// minAllowedBits is the controller's rule: an AllowedIPs prefix shorter than
// this routes most of the internet into the mesh.
const minAllowedBits = 8

// checkAllowedIPs holds AllowedIPs to what the generator writes: addresses
// and networks in canonical form (no host bits set, so they match the routes
// `ip route` reports), none shorter than /8 and so never a default route.
func checkAllowedIPs(value string) error {
	for _, item := range strings.Split(value, ",") {
		item = strings.Trim(item, " \t")
		if a, err := netip.ParseAddr(item); err == nil && a.Zone() == "" {
			continue
		}
		p, err := netip.ParsePrefix(item)
		switch {
		case err != nil:
			return fmt.Errorf("%q is not an address or prefix", item)
		case p.Bits() < minAllowedBits:
			return fmt.Errorf("%q is shorter than /%d and would route most of the internet into the mesh", item, minAllowedBits)
		case p != p.Masked():
			return fmt.Errorf("%q has host bits set; the network is %s", item, p.Masked())
		}
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
// Nothing inside a table can reach another one, but a table can still hook
// the host's own traffic, rewrite addresses or switch itself off, so the body
// is held to what the generator writes too (see checkNftBody).
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
	_, err := checkNftBody(conf)
	return err
}

// The only base chains the generator declares: the forward filter, and the
// source NAT of the masquerade layout.
const (
	nftForwardHook = "type filter hook forward priority filter"
	nftNatHook     = "type nat hook postrouting priority srcnat"
)

// nftForbidden are statements the generator never writes and that would let
// the table do more than filter and count forwarded traffic: rewrite
// destinations or sources, hand packets to user space or another host,
// bypass connection tracking or the forwarding path, or build a keyword
// from a variable.
var nftForbidden = map[string]bool{
	"dnat": true, "snat": true, "redirect": true, "tproxy": true, "queue": true,
	"notrack": true, "dup": true, "fwd": true, "flow": true, "flowtable": true,
	"offload": true, "synproxy": true, "define": true, "redefine": true, "undefine": true,
}

// nftMSSClamp is the one statement that sets a value.
var nftMSSClamp = []string{"tcp", "option", "maxseg", "size", "set", "rt", "mtu"}

type nftBlock struct {
	kind   string // "table", "chain", "set", ... : the word that opened it
	hook   string // for a base chain, its type/hook statement
	policy string
}

// nftFacts is what checkNftBody learned about a file that passed.
type nftFacts struct {
	// A forward filter chain with policy drop: forwarding is filtered.
	filtersForwarding bool
}

// checkNftBody reads the file as nft's scanner does (the lexical checks in
// validateNftables have passed) and holds every statement in the table to
// what the generator writes:
//   - a base chain is only the forward filter (with policy drop) or the
//     postrouting source NAT, never an input, output, prerouting or other
//     hook, and never at another priority;
//   - masquerade appears only in that NAT chain, and no other address or
//     port rewriting, queueing, duplication, offload or notrack at all;
//   - the only statement that sets anything is the MSS clamp (so no
//     `meta mark set`, `ct ... set` or payload rewriting);
//   - flags only on sets and maps, never on the table (dormant or owner
//     would switch the filter off).
func checkNftBody(conf string) (nftFacts, error) {
	var facts nftFacts
	var stack []*nftBlock
	var words []string
	for _, t := range nftTokens(conf) {
		fail := func(format string, args ...any) (nftFacts, error) {
			return nftFacts{}, fmt.Errorf("refusing nftables.conf: line %d: %s", t.line, fmt.Sprintf(format, args...))
		}
		switch t.text {
		case "{", "}", ";", "\n":
			if msg := checkNftStatement(words, t.text, stack); msg != "" {
				return fail("%s", msg)
			}
		default:
			words = append(words, t.text)
			continue
		}
		switch t.text {
		case "{":
			kind := "table"
			if len(stack) > 0 && len(words) > 0 {
				kind = words[0]
			}
			stack = append(stack, &nftBlock{kind: kind})
		case "}":
			if len(stack) == 0 {
				return fail("unbalanced }")
			}
			b := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if b.hook == nftForwardHook {
				if b.policy != "drop" {
					return fail("the forward chain must drop what it does not accept (policy drop)")
				}
				facts.filtersForwarding = true
			}
		}
		words = nil
	}
	return facts, nil
}

// checkNftStatement checks one statement inside the table, ended by term,
// and returns why it is refused, or "".
func checkNftStatement(words []string, term string, stack []*nftBlock) string {
	if len(stack) == 0 || len(words) == 0 {
		return "" // the top level is checked line by line in validateNftables
	}
	inner := stack[len(stack)-1]
	var chain *nftBlock
	for i := len(stack) - 1; i >= 0; i-- {
		if stack[i].kind == "chain" {
			chain = stack[i]
			break
		}
	}
	hook := false
	for i, w := range words {
		if strings.HasPrefix(w, `"`) {
			continue // a quoted string is data, never a keyword
		}
		w = asciiLower(w)
		switch {
		case nftForbidden[w]:
			return w + " is not allowed"
		case strings.HasPrefix(w, "$"):
			return "variables are not allowed"
		case w == "hook":
			hook = true
		case w == "set":
			declaration := i == 0 && len(words) == 2 && term == "{" && inner.kind == "table"
			if !declaration && !isMSSClamp(words, i) {
				return "the only value a rule may set is the TCP MSS (tcp option maxseg size set rt mtu)"
			}
		case w == "masquerade":
			if chain == nil || chain.hook != nftNatHook {
				return "masquerade is only allowed in the " + nftNatHook + " chain"
			}
		case w == "flags" && i == 0:
			if inner.kind != "set" && inner.kind != "map" {
				return "flags are only allowed on sets and maps"
			}
		case w == "policy" && i == 0:
			if inner.kind != "chain" || len(words) != 2 {
				return "a policy belongs to a base chain"
			}
			inner.policy = asciiLower(words[1])
		}
	}
	if hook {
		stmt := asciiLower(strings.Join(words, " "))
		if inner.kind != "chain" || inner.hook != "" || (stmt != nftForwardHook && stmt != nftNatHook) {
			return fmt.Sprintf("%q is not allowed: the only base chains are %q and %q", stmt, nftForwardHook, nftNatHook)
		}
		inner.hook = stmt
	}
	return ""
}

func isMSSClamp(words []string, i int) bool {
	at := slices.Index(nftMSSClamp, "set")
	start := i - at
	if start < 0 || start+len(nftMSSClamp) > len(words) {
		return false
	}
	for j, want := range nftMSSClamp {
		if asciiLower(words[start+j]) != want {
			return false
		}
	}
	return true
}

type nftToken struct {
	text string // a word, a quoted string with its quotes, or one of { } ; and "\n"
	line int
}

// nftTokens splits the file into words, quoted strings and the characters
// that end or open a statement. Comments are dropped, and every other
// punctuation mark separates words, so a keyword cannot hide inside a longer
// token.
func nftTokens(conf string) []nftToken {
	var toks []nftToken
	for n, line := range strings.Split(conf, "\n") {
		var word strings.Builder
		flush := func() {
			if word.Len() > 0 {
				toks = append(toks, nftToken{word.String(), n + 1})
				word.Reset()
			}
		}
		inString := false
	scan:
		for i := 0; i < len(line); i++ {
			c := line[i]
			switch {
			case inString:
				word.WriteByte(c)
				if c == '"' {
					inString = false
					flush()
				}
			case c == '"':
				flush()
				word.WriteByte(c)
				inString = true
			case c == '#':
				break scan
			case c == '{' || c == '}' || c == ';':
				flush()
				toks = append(toks, nftToken{string(c), n + 1})
			case isNftWordByte(c):
				word.WriteByte(c)
			default:
				flush()
			}
		}
		flush()
		toks = append(toks, nftToken{"\n", n + 1})
	}
	return toks
}

func isNftWordByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
		strings.IndexByte("/_.-*@$", c) >= 0 || c >= 0x80
}

// nftFiltersForwarding reports whether the file declares the forward filter
// chain with policy drop. A bundle without it would leave forwarding open.
func nftFiltersForwarding(conf string) bool {
	facts, err := checkNftBody(conf)
	return err == nil && facts.filtersForwarding
}
