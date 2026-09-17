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
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
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
		http:  &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: refuseRedirect},
	}, nil
}

// refuseRedirect stops every redirect. The controller never redirects the
// agent's API, and following one could carry the gateway token to another
// host or down to plain http.
func refuseRedirect(req *http.Request, _ []*http.Request) error {
	status := 0
	if req.Response != nil {
		status = req.Response.StatusCode
	}
	return fmt.Errorf("the controller answered with a redirect (HTTP %d), which the agent does not follow", status)
}

type apiError struct {
	Status int
	Body   string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("controller returned %d: %s", e.Status, summariseBody(e.Body))
}

var (
	htmlTitleRE = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	htmlH1RE    = regexp.MustCompile(`(?is)<h1[^>]*>(.*?)</h1>`)
	htmlTagRE   = regexp.MustCompile(`(?s)<[^>]*>`)
)

const maxErrorSummary = 160

// summariseBody turns an error response into one short line: the JSON
// "error" field when there is one, otherwise the heading of an HTML page (a
// proxy's or firewall's block page), with whitespace collapsed, anything
// non-printing dropped and a length cap, so a failing report never floods
// or garbles the journal.
func summariseBody(body string) string {
	var parsed struct {
		Error string `json:"error"`
	}
	msg := body
	if json.Unmarshal([]byte(body), &parsed) == nil && parsed.Error != "" {
		msg = parsed.Error
	} else if looksLikeHTML(body) {
		msg = "HTML page"
		for _, re := range []*regexp.Regexp{htmlTitleRE, htmlH1RE} {
			if m := re.FindStringSubmatch(body); m != nil {
				if t := strings.Join(strings.Fields(htmlTagRE.ReplaceAllString(m[1], " ")), " "); t != "" {
					msg = t + " (HTML page)"
					break
				}
			}
		}
	}
	msg = strings.Join(strings.Fields(printable(msg)), " ")
	if msg == "" {
		return "(empty response)"
	}
	if utf8.RuneCountInString(msg) > maxErrorSummary {
		msg = string([]rune(msg)[:maxErrorSummary]) + "…"
	}
	return msg
}

func looksLikeHTML(body string) bool {
	head := strings.ToLower(strings.TrimSpace(body))
	if len(head) > 512 {
		head = head[:512]
	}
	return strings.HasPrefix(head, "<!doctype html") || strings.HasPrefix(head, "<html") || strings.Contains(head, "<html")
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
