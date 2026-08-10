package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// AgentConfig is the agent's own configuration, read from a JSON file on the
// node (default /etc/opnmesh/agent.json). It contains no secrets; the API
// token lives in its own root-only file so it can be rotated independently.
type AgentConfig struct {
	ServerURL       string `json:"server_url"`
	TokenFile       string `json:"token_file"`
	ConfDir         string `json:"conf_dir"`  // where wg0.conf / nftables.conf / sysctl.conf live
	StateDir        string `json:"state_dir"` // snapshots + agent bookkeeping + A/B versions
	WgInterface     string `json:"wg_interface"`
	PollIntervalSec int    `json:"poll_interval_sec"`
	// Commit-confirm window after a self-update (§11 layer 4). Local timer.
	CommitConfirmSec int `json:"commit_confirm_sec"`
	// Boot watchdog window (§11 layer 6). 0 disables.
	BootWatchdogSec int `json:"boot_watchdog_sec"`
}

func defaultConfig() AgentConfig {
	return AgentConfig{
		TokenFile:        "/etc/opnmesh/agent.token",
		ConfDir:          "/etc/opnmesh",
		StateDir:         "/var/lib/opnmesh",
		WgInterface:      "wg0",
		PollIntervalSec:  10,
		CommitConfirmSec: 90,
		BootWatchdogSec:  0,
	}
}

func LoadConfig(path string) (AgentConfig, error) {
	cfg := defaultConfig()
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("read agent config: %w", err)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("parse agent config: %w", err)
	}
	if cfg.ServerURL == "" {
		return cfg, fmt.Errorf("agent config: server_url is required")
	}
	if cfg.PollIntervalSec < 1 {
		cfg.PollIntervalSec = 10
	}
	if cfg.CommitConfirmSec < 1 {
		cfg.CommitConfirmSec = 90
	}
	return cfg, nil
}

func (c AgentConfig) PollInterval() time.Duration {
	return time.Duration(c.PollIntervalSec) * time.Second
}

func (c AgentConfig) Token() (string, error) {
	data, err := os.ReadFile(c.TokenFile)
	if err != nil {
		return "", fmt.Errorf("read token: %w", err)
	}
	return strings.TrimSpace(string(data)), nil
}
