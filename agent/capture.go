package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
)

// Tier-4 on-demand capture (§13): the agent polls for queued capture jobs
// (control never dials in), runs a time-boxed, size-capped tcpdump on the wg
// interface, and uploads the pcap. Limits are enforced on BOTH ends.

type CaptureSpec struct {
	ID      string `json:"id"`
	Filter  string `json:"filter"`
	Seconds int    `json:"seconds"`
	MaxKb   int    `json:"maxKb"`
}

func (c *APIClient) FetchCapture() (*CaptureSpec, error) {
	req, err := http.NewRequest(http.MethodGet, c.baseURL+"/api/v1/agent/capture", nil)
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
		return nil, fmt.Errorf("capture check: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var spec CaptureSpec
	if err := json.Unmarshal(body, &spec); err != nil {
		return nil, err
	}
	if spec.ID == "" {
		return nil, nil
	}
	return &spec, nil
}

func (c *APIClient) UploadCapture(id string, pcap []byte) error {
	req, err := http.NewRequest(http.MethodPost, c.baseURL+"/api/v1/agent/capture/"+id, bytes.NewReader(pcap))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("capture upload: HTTP %d", resp.StatusCode)
	}
	return nil
}

// safeFilter reports whether a capture filter is a plain BPF expression.
//
// Passing it as argv is NOT sufficient protection: tcpdump parses options
// wherever they appear, so a "filter" of `-z /bin/sh` makes tcpdump execute
// that command as root on every rotated file. Any token beginning with "-" is
// therefore refused outright, along with anything outside the BPF character
// set. The control node applies the same rule; this is the independent check
// on the node itself, because the agent must not trust the control node with
// root command execution.
func safeFilter(f string) bool {
	if len(f) > 200 {
		return false
	}
	for _, tok := range strings.Fields(f) {
		if strings.HasPrefix(tok, "-") {
			return false
		}
	}
	for _, r := range f {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			strings.ContainsRune(" .:/()[]<>=!&|_", r)
		if !ok {
			return false
		}
	}
	return true
}

// runCapture executes the job with hard local limits regardless of what the
// control node asked for.
func runCapture(iface string, spec CaptureSpec) ([]byte, error) {
	seconds := spec.Seconds
	if seconds < 1 || seconds > 60 {
		seconds = 15
	}
	maxKb := spec.MaxKb
	if maxKb < 1 || maxKb > 10240 {
		maxKb = 2048
	}
	if !safeFilter(spec.Filter) {
		return nil, fmt.Errorf("refusing capture filter: only plain BPF expressions are accepted")
	}
	tmp, err := os.CreateTemp("", "opnmesh-cap-*.pcap")
	if err != nil {
		return nil, err
	}
	path := tmp.Name()
	tmp.Close()
	defer os.Remove(path)

	// No -C: file rotation is what makes tcpdump's -z postrotate command
	// reachable at all, and a single capped file is what we want anyway.
	// -Z nobody drops privileges after the capture socket is opened.
	args := []string{
		fmt.Sprint(seconds), "tcpdump",
		"-i", iface,
		"-w", path,
		"-Z", "nobody",
		"-n",
		"--snapshot-length", "262144",
	}
	if f := strings.TrimSpace(spec.Filter); f != "" {
		args = append(args, strings.Fields(f)...)
	}
	// `timeout` boxes the duration; tcpdump errors other than the timeout kill
	// are real failures.
	out, err := exec.Command("timeout", args...).CombinedOutput()
	if err != nil {
		// exit 124 = timeout fired, which is the expected way captures end.
		if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 124 {
			return nil, fmt.Errorf("tcpdump: %v: %s", err, strings.TrimSpace(string(out)))
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) > maxKb*1024 {
		data = data[:maxKb*1024]
	}
	return data, nil
}

func maybeCapture(cfg AgentConfig, client *APIClient) {
	spec, err := client.FetchCapture()
	if err != nil || spec == nil {
		return
	}
	log.Printf("capture %s: %ds on %s (filter %q)", spec.ID, spec.Seconds, cfg.WgInterface, spec.Filter)
	data, err := runCapture(cfg.WgInterface, *spec)
	if err != nil {
		log.Printf("capture %s failed: %v", spec.ID, err)
		data = []byte{}
	}
	if err := client.UploadCapture(spec.ID, data); err != nil {
		log.Printf("capture %s upload failed: %v", spec.ID, err)
	}
}
