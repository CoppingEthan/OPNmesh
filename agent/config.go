package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Config is the agent's own configuration (/etc/opnmesh/agent.json). It holds
// no secrets: the gateway token lives in its own root-only file.
type Config struct {
	ControllerURL string `json:"controller_url"`
	TokenFile     string `json:"token_file"`
	ConfDir       string `json:"conf_dir"`
	StateDir      string `json:"state_dir"`
	// PEM bundle to trust instead of the system roots (private CA mode).
	CAFile string `json:"ca_file"`
	// Allow http:// — simulation and labs only.
	InsecureHTTP bool `json:"insecure_http"`
}

const defaultConfigPath = "/etc/opnmesh/agent.json"

func defaultConfig() Config {
	return Config{
		TokenFile: "/etc/opnmesh/agent.token",
		ConfDir:   "/etc/opnmesh",
		StateDir:  "/var/lib/opnmesh",
	}
}

func loadConfig(path string) (Config, error) {
	cfg := defaultConfig()
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("read %s: %w (has this gateway been enrolled?)", path, err)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("parse %s: %w", path, err)
	}
	if cfg.ControllerURL == "" {
		return cfg, errors.New("controller_url is empty")
	}
	if !strings.HasPrefix(cfg.ControllerURL, "https://") && !cfg.InsecureHTTP {
		return cfg, errors.New("controller_url must be https:// unless insecure_http is set")
	}
	cfg.ControllerURL = strings.TrimRight(cfg.ControllerURL, "/")
	return cfg, nil
}

func saveConfig(path string, cfg Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(data, '\n'), 0o600)
}

func (c Config) token() (string, error) {
	data, err := os.ReadFile(c.TokenFile)
	if err != nil {
		return "", fmt.Errorf("read token: %w", err)
	}
	return strings.TrimSpace(string(data)), nil
}

// Meta records what was last applied, so `up` and `status` work offline and
// the run loop knows whether the controller's hash differs from ours.
type Meta struct {
	Interface         string `json:"interface"`
	ListenPort        int    `json:"listen_port"`
	AppliedHash       string `json:"applied_hash"`
	AppliedAt         int64  `json:"applied_at"`
	SiteSlug          string `json:"site_slug"`
	TelemetryEverySec int    `json:"telemetry_interval_seconds"`
	PrivateKeyPath    string `json:"private_key_path"`
}

func (c Config) metaPath() string { return filepath.Join(c.ConfDir, "meta.json") }

func (c Config) loadMeta() Meta {
	m := Meta{Interface: "opnmesh0", TelemetryEverySec: 5, PrivateKeyPath: filepath.Join(c.ConfDir, "private.key")}
	data, err := os.ReadFile(c.metaPath())
	if err == nil {
		_ = json.Unmarshal(data, &m)
	}
	if !validInterfaceName(m.Interface) {
		m.Interface = "opnmesh0"
	}
	if m.TelemetryEverySec < 2 || m.TelemetryEverySec > 60 {
		m.TelemetryEverySec = 5
	}
	return m
}

func (c Config) saveMeta(m Meta) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(c.metaPath(), append(data, '\n'), 0o600)
}

var ifaceRe = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,14}$`)

func validInterfaceName(s string) bool { return ifaceRe.MatchString(s) }

// writeFileAtomic writes via a temp file and rename so a crash never leaves a
// half-written configuration behind.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}
