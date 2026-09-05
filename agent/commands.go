package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// --- enrol -------------------------------------------------------------------

func cmdEnrol(args []string) error {
	fs := flag.NewFlagSet("enrol", flag.ContinueOnError)
	controller := fs.String("controller", "", "controller base URL (https://...)")
	token := fs.String("token", os.Getenv("OPNMESH_TOKEN"), "one-time enrolment token")
	caFile := fs.String("ca", "", "PEM file with the controller's private CA (optional)")
	insecure := fs.Bool("insecure-http", false, "allow http:// (lab only)")
	confDir := fs.String("conf-dir", "/etc/opnmesh", "configuration directory")
	stateDir := fs.String("state-dir", "/var/lib/opnmesh", "state directory")
	configPath := fs.String("config", defaultConfigPath, "where to write agent.json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *controller == "" || *token == "" {
		return errors.New("--controller and --token are required")
	}
	cfg := defaultConfig()
	cfg.ControllerURL = strings.TrimRight(*controller, "/")
	cfg.ConfDir = *confDir
	cfg.StateDir = *stateDir
	cfg.TokenFile = filepath.Join(*confDir, "agent.token")
	cfg.CAFile = *caFile
	cfg.InsecureHTTP = *insecure
	if !strings.HasPrefix(cfg.ControllerURL, "https://") && !cfg.InsecureHTTP {
		return errors.New("controller URL must be https:// (or pass --insecure-http for a lab)")
	}
	if err := os.MkdirAll(cfg.ConfDir, 0o700); err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		return err
	}

	keyPath := filepath.Join(cfg.ConfDir, "private.key")
	priv, err := os.ReadFile(keyPath)
	if err != nil {
		out, err := runCmd("wg", "genkey")
		if err != nil {
			return err
		}
		priv = []byte(strings.TrimSpace(out) + "\n")
		if err := writeFileAtomic(keyPath, priv, 0o600); err != nil {
			return err
		}
	}
	pubCmd := exec.Command("wg", "pubkey")
	pubCmd.Stdin = strings.NewReader(string(priv))
	pubOut, err := pubCmd.Output()
	if err != nil {
		return fmt.Errorf("derive public key: %w", err)
	}
	pub := strings.TrimSpace(string(pubOut))

	hostname, _ := os.Hostname()
	client, err := newClient(cfg, "")
	if err != nil {
		return err
	}
	resp, err := client.Enrol(EnrolRequest{
		Token:        *token,
		PublicKey:    pub,
		Hostname:     hostname,
		OS:           osName(),
		Arch:         runtime.GOARCH,
		Addresses:    stripPrefixes(globalIPv4Addresses()),
		AgentVersion: version,
	})
	if err != nil {
		return fmt.Errorf("enrolment failed: %w", err)
	}
	if err := writeFileAtomic(cfg.TokenFile, []byte(resp.GatewayToken+"\n"), 0o600); err != nil {
		return err
	}
	if err := saveConfig(*configPath, cfg); err != nil {
		return err
	}
	fmt.Printf("enrolled as gateway %s for site %q (%s)\n", resp.GatewayID, resp.SiteName, resp.Status)
	if resp.Status == "pending" {
		fmt.Println("this gateway is waiting for approval in the OPNmesh UI")
	}
	return nil
}

func osName() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return runtime.GOOS
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
		}
	}
	return runtime.GOOS
}

func stripPrefixes(addrs []string) []string {
	out := make([]string, 0, len(addrs))
	for _, a := range addrs {
		out = append(out, strings.SplitN(a, "/", 2)[0])
	}
	return out
}

// --- run / once --------------------------------------------------------------

func cmdRun(args []string, once bool) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	configPath := fs.String("config", defaultConfigPath, "agent.json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	log.SetFlags(log.Ltime)
	started := time.Now()
	meta := cfg.loadMeta()
	appliedHash := meta.AppliedHash
	// Disk is the truth after a reboot: if the files changed under us
	// (rollback, manual edit), report what is really there.
	if dh := hashFiles(diskFiles(cfg, meta.Interface)); dh != appliedHash && appliedHash != "" {
		log.Printf("files on disk differ from last applied config; will re-fetch")
		appliedHash = ""
	}
	lastError := ""
	lastDiag := ""
	interval := time.Duration(meta.TelemetryEverySec) * time.Second
	log.Printf("opnmesh-gw %s: controller %s, interface %s, reporting every %s", version, cfg.ControllerURL, meta.Interface, interval)

	// Make sure the tunnel is up from disk even if opnmesh-wg.service did not run.
	if err := applyFromDisk(cfg); err != nil {
		log.Printf("bring-up from disk: %v", err)
	}

	for {
		healKey(cfg)
		token, err := cfg.token()
		if err != nil {
			log.Printf("%v", err)
		} else if client, err := newClient(cfg, token); err != nil {
			log.Printf("%v", err)
		} else {
			resp, err := client.SendTelemetry(collectReport(cfg, started, appliedHash, lastError))
			switch {
			case err != nil:
				log.Printf("report failed (controller unreachable is fine, tunnel keeps running): %v", err)
			case resp.Status == "pending":
				log.Printf("waiting for approval in the OPNmesh UI")
			case resp.Status == "disabled":
				log.Printf("this gateway is disabled in the OPNmesh UI")
			case resp.ConfigHash != "" && resp.ConfigHash != appliedHash:
				desired, notModified, err := client.FetchConfig("")
				if err != nil {
					log.Printf("fetch config: %v", err)
				} else if notModified || desired == nil || desired.Status != "active" {
					log.Printf("config not available yet")
				} else if err := applyConfig(cfg, desired); err != nil {
					lastError = err.Error()
					log.Printf("apply failed: %v", err)
				} else {
					lastError = ""
					appliedHash = desired.Hash
					if desired.Meta.TelemetryIntervalSeconds > 0 {
						interval = time.Duration(desired.Meta.TelemetryIntervalSeconds) * time.Second
					}
					log.Printf("applied configuration %s", desired.Hash[:12])
				}
			default:
				if resp.IntervalSeconds > 0 {
					interval = time.Duration(resp.IntervalSeconds) * time.Second
				}
			}
			if err == nil && resp.Status == "active" {
				dispatchDiagnostics(cfg, client, resp, &lastDiag)
			}
		}
		if once {
			return nil
		}
		jitter := time.Duration(rand.Int63n(int64(interval / 5)))
		time.Sleep(interval + jitter)
	}
}

// --- up / down / rollback / status --------------------------------------------

func loadFor(args []string, name string) (Config, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	configPath := fs.String("config", defaultConfigPath, "agent.json")
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		// up/down must work even before enrolment if files exist.
		cfg = defaultConfig()
	}
	return cfg, nil
}

func cmdUp(args []string) error {
	cfg, err := loadFor(args, "up")
	if err != nil {
		return err
	}
	if err := applyFromDisk(cfg); err != nil {
		return err
	}
	meta := cfg.loadMeta()
	if wgInterfaceExists(meta.Interface) {
		fmt.Printf("%s is up\n", meta.Interface)
	} else {
		fmt.Println("no configuration on disk yet; nothing to bring up")
	}
	return nil
}

func cmdDown(args []string) error {
	cfg, err := loadFor(args, "down")
	if err != nil {
		return err
	}
	return tearDown(cfg)
}

func cmdRollback(args []string) error {
	cfg, err := loadFor(args, "rollback")
	if err != nil {
		return err
	}
	if err := rollback(cfg); err != nil {
		return err
	}
	fmt.Println("restored the previous configuration; the agent will re-apply the controller's version on its next successful poll")
	return nil
}

func cmdStatus(args []string) error {
	cfg, err := loadFor(args, "status")
	if err != nil {
		return err
	}
	meta := cfg.loadMeta()
	fmt.Printf("controller:   %s\n", cfg.ControllerURL)
	fmt.Printf("interface:    %s (%s)\n", meta.Interface, map[bool]string{true: "up", false: "down"}[wgInterfaceExists(meta.Interface)])
	fmt.Printf("site:         %s\n", meta.SiteSlug)
	fmt.Printf("applied hash: %s\n", meta.AppliedHash)
	if meta.AppliedAt > 0 {
		fmt.Printf("applied at:   %s\n", time.Unix(meta.AppliedAt, 0).Format(time.RFC3339))
	}
	fmt.Printf("disk hash:    %s\n", hashFiles(diskFiles(cfg, meta.Interface)))
	if wgInterfaceExists(meta.Interface) {
		out, _ := runCmd("wg", "show", meta.Interface)
		fmt.Println()
		fmt.Print(out)
	}
	return nil
}
