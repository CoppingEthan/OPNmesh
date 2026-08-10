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

// runCapture executes the job with hard local limits regardless of what the
// control node asked for. The filter is passed as argv, never through a shell.
func runCapture(iface string, spec CaptureSpec) ([]byte, error) {
	seconds := spec.Seconds
	if seconds < 1 || seconds > 60 {
		seconds = 15
	}
	maxKb := spec.MaxKb
	if maxKb < 1 || maxKb > 10240 {
		maxKb = 2048
	}
	tmp, err := os.CreateTemp("", "opnmesh-cap-*.pcap")
	if err != nil {
		return nil, err
	}
	path := tmp.Name()
	tmp.Close()
	defer os.Remove(path)

	args := []string{fmt.Sprint(seconds), "tcpdump", "-i", iface, "-w", path, "-C", "11"}
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
