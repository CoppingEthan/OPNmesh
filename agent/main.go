// opnmesh-gw: the OPNmesh gateway agent.
//
// It enrols once, then keeps this machine's WireGuard, nftables and sysctl
// configuration equal to what the controller generates, and reports
// telemetry. The controller never dials in. If the controller is unreachable
// the agent changes nothing and the tunnel keeps running from disk.
//
//	opnmesh-gw enrol --controller URL --token T [--ca FILE] [--insecure-http]
//	opnmesh-gw run            poll/apply/report loop (systemd: opnmesh-gw.service)
//	opnmesh-gw once           one poll/apply/report pass
//	opnmesh-gw up             bring the tunnel up from the files on disk (opnmesh-wg.service)
//	opnmesh-gw down           tear the tunnel down
//	opnmesh-gw rollback       restore the previous configuration files and re-apply
//	opnmesh-gw status         print applied state and wg show
//	opnmesh-gw version
package main

import (
	"fmt"
	"os"
)

var version = "dev"

func usage() {
	fmt.Fprintln(os.Stderr, "usage: opnmesh-gw <enrol|run|once|up|down|rollback|status|version> [flags]")
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "version", "--version", "-v":
		fmt.Println(version)
	case "enrol":
		err = cmdEnrol(os.Args[2:])
	case "run":
		err = cmdRun(os.Args[2:], false)
	case "once":
		err = cmdRun(os.Args[2:], true)
	case "up":
		err = cmdUp(os.Args[2:])
	case "down":
		err = cmdDown(os.Args[2:])
	case "rollback":
		err = cmdRollback(os.Args[2:])
	case "status":
		err = cmdStatus(os.Args[2:])
	case "help", "-h", "--help":
		usage()
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "opnmesh-gw %s: %v\n", os.Args[1], err)
		os.Exit(1)
	}
}
