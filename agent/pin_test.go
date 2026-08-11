package main

// Certificate pinning must authenticate the peer we are actually talking to.
//
// Regression guard for a real hole: the pin check scanned every certificate
// the server sent. Chain validation is disabled when pinning (that is the
// point — a private mesh has no CA), so everything after the leaf is an
// unauthenticated attachment. A man in the middle could therefore present
// their own leaf, whose key they hold, and simply staple the control node's
// certificate — which is public — behind it. The pin matched a certificate the
// attacker did not own, and the agent handed over its bearer token.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"math/big"
	"net/http"
	"testing"
	"time"
)

// newCert returns a self-signed certificate in DER form and its SPKI pin.
func newCert(t *testing.T, cn string) (der []byte, pin string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err = x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse certificate: %v", err)
	}
	sum := sha256.Sum256(parsed.RawSubjectPublicKeyInfo)
	return der, hex.EncodeToString(sum[:])
}

// verifierFor digs out the pin callback the client was built with.
func verifierFor(t *testing.T, pin string) func([][]byte, [][]*x509.Certificate) error {
	t.Helper()
	c := NewAPIClient(AgentConfig{ServerURL: "https://control.example", ServerPinSha256: pin}, "node-token")
	tr, ok := c.http.Transport.(*http.Transport)
	if !ok {
		t.Fatal("expected an *http.Transport")
	}
	verify := tr.TLSClientConfig.VerifyPeerCertificate
	if verify == nil {
		t.Fatal("a configured pin must install a certificate verifier")
	}
	return verify
}

func TestPinAcceptsOnlyTheLeafCertificate(t *testing.T) {
	genuineDER, genuinePin := newCert(t, "control.example")
	attackerDER, _ := newCert(t, "attacker.example")

	verify := verifierFor(t, genuinePin)

	// The honest case: the control node is the leaf.
	if err := verify([][]byte{genuineDER}, nil); err != nil {
		t.Fatalf("the pinned certificate as leaf must be accepted, got: %v", err)
	}

	// The attack: attacker's leaf (they hold this key, so the handshake
	// succeeds) with the genuine certificate stapled behind it.
	if err := verify([][]byte{attackerDER, genuineDER}, nil); err == nil {
		t.Fatal("SECURITY: a stapled copy of the pinned certificate satisfied the pin behind an attacker's leaf")
	}

	// An unrelated certificate on its own is refused.
	if err := verify([][]byte{attackerDER}, nil); err == nil {
		t.Fatal("an unpinned certificate must be refused")
	}

	// An empty chain must not be read as success.
	if err := verify([][]byte{}, nil); err == nil {
		t.Fatal("an empty certificate chain must be refused")
	}
}

func TestNoPinLeavesNormalChainValidationInPlace(t *testing.T) {
	// Without a pin the agent must fall back to ordinary CA validation rather
	// than silently accepting anything.
	c := NewAPIClient(AgentConfig{ServerURL: "https://control.example"}, "node-token")
	tr, ok := c.http.Transport.(*http.Transport)
	if !ok {
		t.Fatal("expected an *http.Transport")
	}
	if tr.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("SECURITY: certificate verification is disabled when no pin is configured")
	}
	if tr.TLSClientConfig.VerifyPeerCertificate != nil {
		t.Fatal("no pin should mean no custom verifier")
	}
}
