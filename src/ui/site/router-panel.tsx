"use client";

import { ChevronDown, Download } from "lucide-react";
import { useState } from "react";
import type { RouterPlan } from "@/core/generate/router";
import type { SiteState } from "@/server/state";
import { Callout, Card, Mono, Table, Td, Th, cx } from "../components";
import { CopyButton } from "../components-client";

/**
 * What to type into this site's router, generated from the mesh. Generic
 * instructions first; UniFi click-paths for both current Network app
 * generations underneath.
 */
export function RouterPanel({ site, plan }: { site: SiteState; plan: RouterPlan | null }) {
  const [showUnifi, setShowUnifi] = useState(true);
  if (!plan) {
    return (
      <Card title="Router setup" description="What this site's router must do so its computers can reach the other sites.">
        <p className="text-sm text-ink-3">Once a gateway is installed and active here, the exact routes and firewall entries appear on this page.</p>
      </Card>
    );
  }
  const required = plan.routes.filter((r) => r.required);
  const routesText = plan.routes.map((r) => `${r.cidr} via ${plan.nextHop}`).join("\n");

  return (
    <Card
      title="Router setup"
      description="Copy these into the site router. OPNmesh never changes a router itself unless you connect it to UniFi."
      actions={
        <a href={`/api/admin/sites/${site.id}/router?format=text`} download={`opnmesh-router-${site.slug}.txt`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-xs font-medium text-ink hover:bg-surface-2">
          <Download className="h-3.5 w-3.5" /> Text file
        </a>
      }
    >
      {plan.layout === "masquerade" && (
        <Callout tone="brand" title="No router changes are required for this site">
          Remote sites and roaming clients can already reach the networks here. Add the routes below only if computers at this site must open connections to other sites.
        </Callout>
      )}
      {plan.layout === "same_lan" && (
        <Callout tone="warn" title="The gateway shares a LAN with your computers">
          Return traffic goes straight from the gateway to each computer, bypassing the router. Add the firewall policy below or ping will work while TCP connections hang. A transit VLAN avoids this entirely.
        </Callout>
      )}

      <h3 className="mb-2 mt-4 text-sm font-semibold text-ink">
        1. Static routes {plan.layout === "masquerade" && <span className="font-normal text-ink-3">(optional here)</span>}
      </h3>
      <p className="mb-2 text-xs text-ink-2">
        Next hop for every route: the gateway VM at <Mono>{plan.nextHop}</Mono>.
      </p>
      <Table>
        <thead>
          <tr>
            <Th>Destination</Th>
            <Th>Next hop</Th>
            <Th>What it is</Th>
          </tr>
        </thead>
        <tbody>
          {plan.routes.map((r) => (
            <tr key={r.cidr}>
              <Td>
                <span className="mono">{r.cidr}</span>
              </Td>
              <Td>
                <span className="mono">{plan.nextHop}</span>
              </Td>
              <Td className="text-ink-2">{r.label}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="mt-2">
        <CopyButton text={routesText} label="Copy routes" />
      </div>

      <h3 className="mb-2 mt-6 text-sm font-semibold text-ink">2. Port forward</h3>
      {plan.portForward ? (
        <p className="text-sm text-ink-2">
          Forward <Mono>UDP {plan.portForward.port}</Mono> from the internet to <Mono>{plan.portForward.toIp}</Mono> port <Mono>{plan.portForward.port}</Mono>. This is what lets other sites and roaming clients connect here.
        </p>
      ) : (
        <p className="text-sm text-ink-2">None. This site dials out to the sites that accept connections. (Tick “accepts incoming connections” on the gateway above if you can forward a port here.)</p>
      )}

      <h3 className="mb-2 mt-6 text-sm font-semibold text-ink">3. Firewall</h3>
      {plan.allStatesPolicy ? (
        <div className="space-y-2 text-sm text-ink-2">
          <p>
            Create a policy named <Mono>{plan.allStatesPolicy.name}</Mono>: from the local networks, to the destinations below, action <strong>Allow</strong>, connection state <strong>All</strong> (new, established, related <em>and invalid</em>), placed above the default rules.
          </p>
          <div className="mono rounded-lg bg-surface-2 p-3 text-xs">{plan.allStatesPolicy.destinations.join("\n")}</div>
        </div>
      ) : plan.layout === "transit" ? (
        <p className="text-sm text-ink-2">Nothing extra with default rules: the transit network and your LANs are both internal, so traffic between them is allowed. To restrict which VLANs may reach remote sites, write ordinary policies between them and the transit network.</p>
      ) : (
        <p className="text-sm text-ink-2">Nothing required.</p>
      )}
      <p className="mt-2 text-xs text-ink-3">
        Optional belt and braces: block new connections from local networks to <Mono>{plan.clientBlockPolicy.destination}</Mono> (roaming clients). The gateway already enforces this.
      </p>

      <button type="button" onClick={() => setShowUnifi((v) => !v)} className="mt-6 flex w-full items-center justify-between border-t border-line pt-4 text-left">
        <span className="text-sm font-semibold text-ink">Where to click in UniFi</span>
        <ChevronDown className={cx("h-4 w-4 text-ink-3 transition-transform", showUnifi && "rotate-180")} />
      </button>
      {showUnifi && (
        <div className="mt-3 grid gap-4 text-sm text-ink-2 md:grid-cols-2">
          <div>
            <h4 className="mb-1 font-medium text-ink">Network 9.x</h4>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Settings → Policy Engine → <strong>Static Routes</strong> → Create New. One entry per destination above: type <em>Next Hop</em>, next hop <Mono>{plan.nextHop}</Mono>, distance 1.</li>
              {plan.portForward && <li>Settings → Firewall &amp; Security → <strong>Port Forwarding</strong>: UDP {plan.portForward.port} → {plan.portForward.toIp}.</li>}
              {plan.allStatesPolicy && <li>Settings → Policy Engine → Zones → Create Policy: Internal → Internal, destination = the list above, Allow, connection state <em>All</em>. Drag it above the built-ins.</li>}
            </ol>
          </div>
          <div>
            <h4 className="mb-1 font-medium text-ink">Network 10.x</h4>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Settings → <strong>Policy Table</strong> → Create New Policy → <em>Route</em> → Static Route. One per destination, next hop <Mono>{plan.nextHop}</Mono>.</li>
              {plan.portForward && <li>Settings → Policy Table → Create New Policy → <em>Port Forward</em>: UDP {plan.portForward.port} → {plan.portForward.toIp}.</li>}
              {plan.allStatesPolicy && <li>Settings → Policy Table → Create New Policy → <em>Firewall</em>: Internal → Internal, destination = the list above, Allow, all connection states, above the defaults.</li>}
            </ol>
          </div>
          <p className="text-xs text-ink-3 md:col-span-2">
            Do not use policy-based routes for this: on UniFi those are firewall marks, not kernel routes, and return traffic will not follow them. {required.length === 0 && "Routes are optional for this site's layout."}
          </p>
        </div>
      )}
    </Card>
  );
}
