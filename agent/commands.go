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
	// The installer passes the token in the environment so it never shows
	// in the process list; keep it from the tools started below as well.
	_ = os.Unsetenv("OPNMESH_TOKEN")
	if *controller == "" || *token == "" {
		return errors.New("--controller and a token (OPNMESH_TOKEN or --token) are required")
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
	fmt.Printf("enrolled as gateway %s for site %q (%s)\n", printable(resp.GatewayID), printable(resp.SiteName), printable(resp.Status))
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
		logf("files on disk differ from last applied config; will re-fetch")
		appliedHash = ""
	}
	lastError := ""
	lastDiag := ""
	// The configured reporting interval. The controller may ask for faster
	// reports while someone watches the dashboard; failures slow them down.
	configured := reportInterval(meta.TelemetryEverySec)
	interval := configured
	failures := 0
	lastFailure := ""
	logf("opnmesh-gw %s: controller %s, interface %s, reporting every %s", version, cfg.ControllerURL, meta.Interface, interval)

	// A configuration that failed to apply here, and when: it is not fetched
	// again until applyRetryAfter has passed or the controller changes it.
	failedHash := ""
	var failedAt time.Time
	rr := newReresolver()
	var lastBringUp time.Time

	for {
		// Keep the tunnel up from the files on disk whether or not the
		// controller can be reached (opnmesh-wg.service may not have run,
		// DNS may have been down at boot, a public address may have moved).
		maintainTunnel(cfg, rr, &lastBringUp)
		token, err := cfg.token()
		if err != nil {
			logf("%v", err)
		} else if client, err := newClient(cfg, token); err != nil {
			logf("%v", err)
		} else {
			resp, err := client.SendTelemetry(collectReport(cfg, started, appliedHash, lastError))
			if err == nil && failures > 0 {
				logf("controller reachable again after %d failed report(s)", failures)
				failures, lastFailure = 0, ""
			}
			switch {
			case err != nil:
				failures++
				// Fast reporting only makes sense while the controller answers.
				// Fall back to the configured interval and back off, so an
				// unreachable or refusing controller costs a request a minute
				// rather than one a second. Log the first failure, any change in
				// the error, and then only every 20th repeat.
				interval = backoffInterval(configured, failures)
				if msg := err.Error(); msg != lastFailure || failures%20 == 1 {
					logf("report failed (%d in a row; the tunnel keeps running), next try in %s: %v", failures, interval, err)
					lastFailure = msg
				}
			case resp.Status == "pending":
				logf("waiting for approval in the OPNmesh UI")
			case resp.Status == "disabled":
				logf("this gateway is disabled in the OPNmesh UI")
			case resp.ConfigHash != "" && resp.ConfigHash != appliedHash:
				if resp.IntervalSeconds > 0 {
					interval = time.Duration(resp.IntervalSeconds) * time.Second
				}
				if resp.ConfigHash == failedHash && time.Since(failedAt) < applyRetryAfter {
					// This exact configuration already failed here (and was rolled
					// back). Leave the running tunnel alone until the retry is due
					// or the controller changes something.
				} else if desired, notModified, err := client.FetchConfig(""); err != nil {
					logf("fetch config: %v", err)
				} else if notModified || desired == nil || desired.Status != "active" {
					logf("config not available yet")
				} else if err := applyConfig(cfg, desired); err != nil {
					lastError = err.Error()
					failedHash, failedAt = desired.Hash, time.Now()
					logf("apply failed: %v (next attempt in %s unless the configuration changes)", err, applyRetryAfter)
				} else {
					lastError = ""
					failedHash = ""
					appliedHash = desired.Hash
					if desired.Meta.TelemetryIntervalSeconds > 0 {
						configured = reportInterval(desired.Meta.TelemetryIntervalSeconds)
						interval = configured
					}
					logf("applied configuration %s", desired.Hash[:12])
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
		jitter := time.Duration(rand.Int63n(int64(interval/5) + 1))
		time.Sleep(interval + jitter)
	}
}

// The longest wait between reports while the controller keeps failing.
const maxReportBackoff = time.Minute

// reportInterval turns a configured number of seconds into an interval,
// defaulting to five seconds when nothing sensible is configured.
func reportInterval(seconds int) time.Duration {
	if seconds < 1 {
		seconds = 5
	}
	return time.Duration(seconds) * time.Second
}

// backoffInterval is the wait after a run of failed reports: the configured
// interval after the first, doubling with each further failure up to a
// minute, and never shorter than the configured interval itself.
func backoffInterval(configured time.Duration, failures int) time.Duration {
	if configured >= maxReportBackoff {
		return configured
	}
	d := configured
	for i := 1; i < failures && d < maxReportBackoff; i++ {
		d *= 2
	}
	if d > maxReportBackoff {
		d = maxReportBackoff
	}
	return d
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
	fmt.Printf("site:         %s\n", printable(meta.SiteSlug))
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
