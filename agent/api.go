package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// DesiredConfig is what the control node says this node's files should be.
type DesiredConfig struct {
	NodeID string            `json:"nodeId"`
	Files  map[string]string `json:"files"`
	Hash   string            `json:"hash"`
}

// Report is what the agent tells the control node every cycle. It never
// contains key material.
type Report struct {
	NodeID          string     `json:"nodeId"`
	Version         string     `json:"version"`
	AppliedHash     string     `json:"appliedHash"`
	DiskHash        string     `json:"diskHash"`
	LastError       string     `json:"lastError,omitempty"`
	LastUpdateError string     `json:"lastUpdateError,omitempty"`
	Peers           []PeerStat `json:"peers"`
	AgentUptime     int64      `json:"agentUptimeSec"`
}

// PeerStat is one row of `wg show <if> dump`.
type PeerStat struct {
	PublicKey       string `json:"publicKey"`
	Endpoint        string `json:"endpoint"`
	LatestHandshake int64  `json:"latestHandshake"`
	RxBytes         int64  `json:"rxBytes"`
	TxBytes         int64  `json:"txBytes"`
}

type APIClient struct {
	baseURL string
	token   string
	http    *http.Client
	// etag of the last successfully fetched config; server returns 304 when unchanged.
	etag string
}

// NewAPIClient builds a client whose TLS behaviour is decided by the agent
// config: with a pin, the control node's certificate public key must match
// exactly (no CA trust needed for a private mesh); without TLS at all, only
// when the install is explicitly marked insecure.
func NewAPIClient(cfg AgentConfig, token string) *APIClient {
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		Proxy:           nil, // never route agent traffic through an env proxy
	}
	if cfg.ServerPinSha256 != "" {
		pin := strings.ToLower(strings.TrimSpace(cfg.ServerPinSha256))
		// Pinning replaces chain validation: we verify the presented key, not
		// who signed it, so a private/self-signed certificate is fine and a
		// swapped one is refused even if it chains to a public CA.
		transport.TLSClientConfig.InsecureSkipVerify = true
		transport.TLSClientConfig.VerifyPeerCertificate = func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			for _, raw := range rawCerts {
				cert, err := x509.ParseCertificate(raw)
				if err != nil {
					continue
				}
				sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
				if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(pin)) == 1 {
					return nil
				}
			}
			return fmt.Errorf("control node certificate does not match the pin recorded at enrolment")
		}
	}
	return &APIClient{
		baseURL: strings.TrimSuffix(cfg.ServerURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 15 * time.Second, Transport: transport},
	}
}

// FetchConfig returns (config, changed, error). changed=false means the
// server said 304 Not Modified.
func (c *APIClient) FetchConfig() (*DesiredConfig, bool, error) {
	req, err := http.NewRequest(http.MethodGet, c.baseURL+"/api/v1/agent/config", nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if c.etag != "" {
		req.Header.Set("If-None-Match", c.etag)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, false, err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusNotModified:
		return nil, false, nil
	case http.StatusOK:
		body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		if err != nil {
			return nil, false, err
		}
		var cfg DesiredConfig
		if err := json.Unmarshal(body, &cfg); err != nil {
			return nil, false, fmt.Errorf("parse config response: %w", err)
		}
		c.etag = resp.Header.Get("ETag")
		return &cfg, true, nil
	default:
		return nil, false, fmt.Errorf("config fetch: HTTP %d", resp.StatusCode)
	}
}

// FetchUpdate asks whether this node should update right now. nil means no.
func (c *APIClient) FetchUpdate() (*UpdateInstruction, error) {
	req, err := http.NewRequest(http.MethodGet, c.baseURL+"/api/v1/agent/update", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("update check: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var instr UpdateInstruction
	if err := json.Unmarshal(body, &instr); err != nil {
		return nil, err
	}
	if instr.TargetVersion == "" {
		return nil, nil
	}
	return &instr, nil
}

// DownloadFile streams an authenticated API path to a local file.
func (c *APIClient) DownloadFile(apiPath, dst string) error {
	req, err := http.NewRequest(http.MethodGet, c.baseURL+apiPath, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download: HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func (c *APIClient) SendFlows(flows []FlowRecord) error {
	payload, err := json.Marshal(map[string]any{"flows": flows})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, c.baseURL+"/api/v1/agent/flows", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("flows: HTTP %d", resp.StatusCode)
	}
	return nil
}

func (c *APIClient) SendReport(r Report) error {
	payload, err := json.Marshal(r)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, c.baseURL+"/api/v1/agent/report", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("report: HTTP %d", resp.StatusCode)
	}
	return nil
}
