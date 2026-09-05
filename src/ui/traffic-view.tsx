"use client";

import Link from "next/link";
import type { StatePayload } from "@/server/state";
import type { Range } from "@/server/telemetry";
import { Legend, LineChart } from "./charts";
import { Badge, Card, PageHeader, Table, Td, Th, cx, healthLabel, healthTone } from "./components";
import { formatBits, formatMs } from "./format";
import { useLiveState } from "./use-live";

export interface PairHistory {
  aId: string;
  bId: string;
  aToB: Array<{ ts: number; v: number }>;
  bToA: Array<{ ts: number; v: number }>;
}

const RANGE_LABEL: Record<Range, string> = { "1h": "Last hour", "6h": "Last 6 hours", "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days", "1y": "Last year" };

export function TrafficView({ initial, range, ranges, history, from, to }: { initial: StatePayload; range: Range; ranges: Range[]; history: PairHistory[]; from: number; to: number }) {
  const { state } = useLiveState(initial);
  const sites = state.sites.filter((s) => s.inMesh).sort((a, b) => a.hubPriority - b.hubPriority);
  const name = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
  const rate = (fromId: string, toId: string) => state.pairs.find((p) => p.fromSiteId === fromId && p.toSiteId === toId)?.bps ?? 0;
  const clientRates = state.clientSiteRates;

  return (
    <div className="space-y-6">
      <PageHeader title="Traffic" description="What is moving between your sites. Live figures come from the gateways' forwarding counters; history is averaged per minute and per hour." />

      {/* Filter row: one date-range control that scopes everything below. */}
      <div className="flex flex-wrap items-center gap-1">
        {ranges.map((r) => (
          <Link key={r} href={`/traffic?range=${r}`} className={cx("rounded-lg px-3 py-1.5 text-sm", r === range ? "bg-brand-soft font-medium text-brand-ink" : "text-ink-2 hover:bg-surface-2")}>
            {RANGE_LABEL[r]}
          </Link>
        ))}
      </div>

      <Card title="Right now: site to site" description="Rows send, columns receive. Routed traffic between the sites' networks, including traffic relayed through a hub." padded={false}>
        {sites.length < 2 ? (
          <p className="px-5 py-6 text-sm text-ink-3">Two sites with gateways are needed before there is anything to show.</p>
        ) : (
          <div className="overflow-x-auto p-5">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="px-2 py-1 text-left text-xs font-medium text-ink-3">from ↓ to →</th>
                  {sites.map((s) => (
                    <th key={s.id} className="px-2 py-1 text-right text-xs font-medium text-ink-3">
                      {s.name}
                    </th>
                  ))}
                  <th className="px-2 py-1 text-right text-xs font-medium text-ink-3">Clients</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((a) => (
                  <tr key={a.id}>
                    <td className="px-2 py-1 font-medium text-ink">{a.name}</td>
                    {sites.map((b) => {
                      if (a.id === b.id) return <td key={b.id} className="px-2 py-1 text-right text-ink-3">—</td>;
                      const v = rate(a.id, b.id);
                      return (
                        <td key={b.id} className={cx("tnum px-2 py-1 text-right", v > 0 ? "text-ink" : "text-ink-3")} title={`${a.name} → ${b.name}: ${formatBits(v)}`}>
                          {formatBits(v)}
                        </td>
                      );
                    })}
                    <td className="tnum px-2 py-1 text-right text-ink-2">{formatBits(clientRates.find((c) => c.siteId === a.id)?.fromSite ?? 0)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="px-2 py-1 font-medium text-ink">Clients</td>
                  {sites.map((b) => (
                    <td key={b.id} className="tnum px-2 py-1 text-right text-ink-2">{formatBits(clientRates.find((c) => c.siteId === b.id)?.toSite ?? 0)}</td>
                  ))}
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {history.length > 0 && (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">{RANGE_LABEL[range]}, per pair of sites</h2>
            <Legend series={[{ name: "first → second", color: "var(--series-1)" }, { name: "second → first", color: "var(--series-7)" }]} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {history.map((h) => (
              <Card key={`${h.aId}|${h.bId}`} title={`${name(h.aId)} ↔ ${name(h.bId)}`} padded={false}>
                <div className="px-2 pb-2 pt-3">
                  <LineChart
                    from={from}
                    to={to}
                    height={170}
                    formatValue={formatBits}
                    ariaLabel={`Traffic between ${name(h.aId)} and ${name(h.bId)}`}
                    series={[
                      { name: `${name(h.aId)} → ${name(h.bId)}`, color: "var(--series-1)", points: h.aToB },
                      { name: `${name(h.bId)} → ${name(h.aId)}`, color: "var(--series-7)", points: h.bToA },
                    ]}
                  />
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      <Card title="Tunnels" description="Every direct WireGuard tunnel, as both ends see it." padded={false}>
        <Table>
          <thead>
            <tr>
              <Th>Between</Th>
              <Th>Status</Th>
              <Th align="right">→</Th>
              <Th align="right">←</Th>
              <Th align="right">Round trip</Th>
              <Th align="right">Last handshake</Th>
            </tr>
          </thead>
          <tbody>
            {state.tunnels.length === 0 && (
              <tr>
                <Td colSpan={6} className="text-ink-3">No tunnels yet.</Td>
              </tr>
            )}
            {state.tunnels.map((t) => (
              <tr key={`${t.a}|${t.b}`}>
                <Td>
                  {name(t.a)} ↔ {name(t.b)}
                  {t.kind === "transit" && <span className="ml-2 text-xs text-ink-3">via {name(t.via!)}</span>}
                </Td>
                <Td>{t.kind === "direct" ? <Badge tone={healthTone(t.health)} dot>{healthLabel(t.health)}</Badge> : <Badge tone={t.kind === "transit" ? "info" : "bad"}>{t.kind === "transit" ? "indirect" : "no path"}</Badge>}</Td>
                <Td align="right">{formatBits(t.aToB)}</Td>
                <Td align="right">{formatBits(t.bToA)}</Td>
                <Td align="right">{formatMs(t.rttMs)}</Td>
                <Td align="right">{t.handshakeAgeS === null ? "—" : `${t.handshakeAgeS}s ago`}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
