/**
 * mesh:chaos — kill a random gateway, verify the rest of the mesh keeps
 * working, bring it back, verify it rejoins. A cheap manual version of the
 * failure-domain tests.
 */
import { execSync } from "node:child_process";

const sh = (cmd: string) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const gateways = ["opnmesh-gw-a", "opnmesh-gw-b", "opnmesh-gw-c"];
const victim = gateways[Math.floor(Math.random() * gateways.length)]!;
const survivors = gateways.filter((g) => g !== victim);

// Ping between the two surviving sites' hosts, via their gateways.
const hostOf: Record<string, string> = {
  "opnmesh-gw-a": "opnmesh-host-a",
  "opnmesh-gw-b": "opnmesh-host-b",
  "opnmesh-gw-c": "opnmesh-host-c",
};
const lanIpOf: Record<string, string> = {
  "opnmesh-host-a": "10.10.5.20",
  "opnmesh-host-b": "10.20.5.20",
  "opnmesh-host-c": "10.30.5.20",
};

const [srcHost, dstHost] = [hostOf[survivors[0]!]!, hostOf[survivors[1]!]!];

async function pingOk(from: string, toIp: string, attempts = 10): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      sh(`docker exec ${from} ping -c 1 -W 2 ${toIp}`);
      return true;
    } catch {
      await sleep(1000);
    }
  }
  return false;
}

console.log(`chaos: killing ${victim}`);
sh(`docker stop -t 1 ${victim}`);

const survived = await pingOk(srcHost, lanIpOf[dstHost]!);
console.log(
  survived
    ? `OK: ${srcHost} still reaches ${dstHost} with ${victim} dead`
    : `FAIL: surviving sites lost connectivity`,
);

console.log(`chaos: restoring ${victim}`);
sh(`docker start ${victim}`);
const rejoined = await pingOk(hostOf[victim]!, lanIpOf[srcHost]!, 30);
console.log(rejoined ? `OK: ${victim} rejoined the mesh` : `FAIL: ${victim} did not rejoin`);

process.exit(survived && rejoined ? 0 : 1);
