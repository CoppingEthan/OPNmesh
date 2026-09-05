package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Client talks to the controller. Every request carries the gateway token
// except enrolment, which carries the one-time enrolment token in its body.
type Client struct {
	base  string
	token string
	http  *http.Client
}

const maxResponse = 4 << 20

func newClient(cfg Config, token string) (*Client, error) {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read CA file: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("CA file contains no certificates")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	} else {
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	if strings.HasPrefix(cfg.ControllerURL, "http://") && !cfg.InsecureHTTP {
		return nil, errors.New("refusing plain http controller without insecure_http")
	}
	return &Client{
		base:  strings.TrimRight(cfg.ControllerURL, "/"),
		token: token,
		http:  &http.Client{Transport: transport, Timeout: 30 * time.Second},
	}, nil
}

type apiError struct {
	Status int
	Body   string
}

func (e *apiError) Error() string {
	msg := e.Body
	var parsed struct {
		Error string `json:"error"`
	}
	if json.Unmarshal([]byte(e.Body), &parsed) == nil && parsed.Error != "" {
		msg = parsed.Error
	}
	return fmt.Sprintf("controller returned %d: %s", e.Status, strings.TrimSpace(msg))
}

func (c *Client) do(method, path string, body any, headers map[string]string, out any) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "opnmesh-gw/"+version)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse))
	if err != nil {
		return resp, err
	}
	if resp.StatusCode == http.StatusNotModified {
		return resp, nil
	}
	if resp.StatusCode >= 400 {
		return resp, &apiError{Status: resp.StatusCode, Body: string(data)}
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return resp, fmt.Errorf("decode response: %w", err)
		}
	}
	return resp, nil
}

// --- enrolment -------------------------------------------------------------

type EnrolRequest struct {
	Token        string   `json:"token"`
	PublicKey    string   `json:"publicKey"`
	Hostname     string   `json:"hostname"`
	OS           string   `json:"os"`
	Arch         string   `json:"arch"`
	Addresses    []string `json:"addresses"`
	AgentVersion string   `json:"agentVersion"`
}

type EnrolResponse struct {
	GatewayID    string `json:"gatewayId"`
	GatewayToken string `json:"gatewayToken"`
	Status       string `json:"status"`
	SiteName     string `json:"siteName"`
}

func (c *Client) Enrol(req EnrolRequest) (EnrolResponse, error) {
	var out EnrolResponse
	_, err := c.do("POST", "/api/agent/enrol", req, nil, &out)
	return out, err
}

// --- configuration ---------------------------------------------------------

type ConfigMeta struct {
	InterfaceName            string `json:"interfaceName"`
	ListenPort               int    `json:"listenPort"`
	NeedsReresolve           bool   `json:"needsReresolve"`
	PrivateKeyPath           string `json:"privateKeyPath"`
	TelemetryIntervalSeconds int    `json:"telemetryIntervalSeconds"`
	SiteSlug                 string `json:"siteSlug"`
}

type ConfigResponse struct {
	Status        string            `json:"status"`
	Message       string            `json:"message"`
	Hash          string            `json:"hash"`
	ConfigVersion int               `json:"configVersion"`
	Files         map[string]string `json:"files"`
	Meta          ConfigMeta        `json:"meta"`
}

// FetchConfig returns (config, notModified, error). A pending gateway gets
// Status "pending" and no files.
func (c *Client) FetchConfig(etag string) (*ConfigResponse, bool, error) {
	headers := map[string]string{}
	if etag != "" {
		headers["If-None-Match"] = `"` + etag + `"`
	}
	var out ConfigResponse
	resp, err := c.do("GET", "/api/agent/config", nil, headers, &out)
	if err != nil {
		return nil, false, err
	}
	if resp.StatusCode == http.StatusNotModified {
		return nil, true, nil
	}
	return &out, false, nil
}

// --- telemetry -------------------------------------------------------------

type TelemetryResponse struct {
	Status          string `json:"status"`
	ConfigHash      string `json:"configHash"`
	IntervalSeconds int    `json:"intervalSeconds"`
	// Things the admin asked for, e.g. {type: "diagnose"}.
	Actions []DiagAction `json:"actions"`
}

func (c *Client) SendTelemetry(r Report) (TelemetryResponse, error) {
	var out TelemetryResponse
	_, err := c.do("POST", "/api/agent/telemetry", r, nil, &out)
	return out, err
}

// --- health checks -------------------------------------------------------------

func (c *Client) SendDiagnostics(r DiagReport) error {
	_, err := c.do("POST", "/api/agent/diagnostics", r, nil, nil)
	return err
}
