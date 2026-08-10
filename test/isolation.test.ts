/**
 * Client isolation, asserted in both directions at the config level (§9):
 * clients reach in; nothing inside any site may initiate a connection to a
 * client. (The packet-level version of these assertions runs in the phase-2
 * compose harness.)
 */
import { describe, expect, it } from "vitest";
import { generateAll } from "../lib/generator/index.js";
import { FIXTURES, loadFixture } from "./helpers.js";

describe.each(FIXTURES)("client isolation: %s", (fixture) => {
  const cfg = loadFixture(fixture);
  const bundle = generateAll(cfg);

  it("every gateway drops NEW connections toward clients and allows replies", () => {
    for (const [id, node] of Object.entries(bundle.nodes)) {
      const nft = node.files["nftables.conf"]!;
      const acceptIdx = nft.indexOf(
        'oifname "wg0" ip daddr @clients ct state established,related accept',
      );
      const dropIdx = nft.indexOf('oifname "wg0" ip daddr @clients ct state new drop');
      expect(acceptIdx, `${id}: missing established/related accept toward clients`).toBeGreaterThan(-1);
      expect(dropIdx, `${id}: missing NEW-to-clients drop`).toBeGreaterThan(-1);
      // Reply-accept must precede the drop so return traffic survives.
      expect(acceptIdx).toBeLessThan(dropIdx);
      expect(nft).toContain(`elements = { ${cfg.network.clientSubnet} }`);
    }
  });

  it("gateways grant each client peer exactly its /32, nothing more", () => {
    for (const [id, node] of Object.entries(bundle.nodes)) {
      const conf = node.files["wg0.conf"]!;
      const clientBlocks = conf.split("[Peer]").filter((b) => b.includes("# client:"));
      for (const block of clientBlocks) {
        const m = block.match(/AllowedIPs = (.+)/);
        expect(m, `${id}: client peer without AllowedIPs`).not.toBeNull();
        const ips = m![1]!.split(",").map((s) => s.trim());
        expect(ips, `${id}: client peer AllowedIPs must be a single /32`).toHaveLength(1);
        expect(ips[0]).toMatch(/^10\.99\.1\.\d+\/32$/);
      }
    }
  });

  it("no individual client /32 ever reaches a site router — aggregate route only", () => {
    for (const [siteId, text] of Object.entries(bundle.routers)) {
      expect(text, `router ${siteId}: must carry the aggregate client route`).toContain(
        cfg.network.clientSubnet,
      );
      for (const c of cfg.clients) {
        expect(text, `router ${siteId}: individual client address leaked`).not.toContain(c.tunnelIp);
      }
      expect(text).toContain(`drop NEW connections from`);
    }
  });

  it("client configs carry no default route and no other client's address", () => {
    for (const [id, { config }] of Object.entries(bundle.clients)) {
      expect(config).not.toContain("0.0.0.0/0");
      for (const other of cfg.clients) {
        if (other.id === id) continue;
        expect(config, `client ${id} can see client ${other.id}`).not.toContain(other.tunnelIp);
      }
    }
  });
});

describe("private keys never appear in generated output", () => {
  it.each(FIXTURES)("%s", (fixture) => {
    const bundle = generateAll(loadFixture(fixture));
    for (const node of Object.values(bundle.nodes)) {
      const conf = node.files["wg0.conf"]!;
      expect(conf).not.toMatch(/PrivateKey/);
      expect(conf).toContain("PostUp = wg set %i private-key /etc/opnmesh/keys/wg0.key");
    }
    for (const { config } of Object.values(bundle.clients)) {
      // Placeholder only — filled in on the device, never known to the control node.
      expect(config).toContain("PrivateKey = {{CLIENT_PRIVATE_KEY}}");
      expect(config).not.toMatch(/PrivateKey = [A-Za-z0-9+/]{43}=/);
    }
  });
});
