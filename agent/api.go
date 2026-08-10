package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
	NodeID      string     `json:"nodeId"`
	AppliedHash string     `json:"appliedHash"`
	DiskHash    string     `json:"diskHash"`
	LastError   string     `json:"lastError,omitempty"`
	Peers       []PeerStat `json:"peers"`
	AgentUptime int64      `json:"agentUptimeSec"`
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

func NewAPIClient(baseURL, token string) *APIClient {
	return &APIClient{
		baseURL: baseURL,
		token:   token,
		http:    &http.Client{Timeout: 15 * time.Second},
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
