import { revalidatePath } from "next/cache";
import { requireAdmin } from "../../lib/ui/auth.js";
import { loadSites, editSites } from "../../lib/ui/sites.js";
import { control } from "../../lib/ui/control.js";
import { CONTROL_URL } from "../../lib/ui/env.js";
import { bytes, HandshakeAge } from "../ui.js";

export const dynamic = "force-dynamic";

const PROM_URL = process.env["OPNMESH_PROM_URL"] ?? "http://localhost:19090";

async function promMatrix(): Promise<Array<{ name: string; rate: number }> | null> {
  try {
    const res = await fetch(
      `${PROM_URL}/api/v1/query?query=${encodeURIComponent("sum by (name) (rate(opnmesh_nft_counter_bytes[5m]))")}`,
      { cache: "no-store" },
    );
    const body = (await res.json()) as any;
    if (body.status !== "success") return null;
    return body.data.result.map((r: any) => ({ name: r.metric.name, rate: Number(r.value[1]) }));
  } catch {
    return null;
  }
}

async function toggleFlows(formData: FormData) {
  "use server";
  await requireAdmin();
  const siteId = String(formData.get("siteId"));
  const enable = formData.get("enable") === "true";
  await editSites(`ui: ${enable ? "enable" : "disable"} per-host flow records on ${siteId}`, (doc) => {
    const s = doc.sites.find((x: any) => x.id === siteId);
    if (!s) throw new Error(`unknown site ${siteId}`);
    s.gateway.flows = enable;
  });
  revalidatePath("/traffic");
}

async function purgeFlows() {
  "use server";
  await requireAdmin();
  await control.flowsPurge();
  revalidatePath("/traffic");
}

async function startCapture(formData: FormData) {
  "use server";
  await requireAdmin();
  await control.captureStart({
    node: String(formData.get("node")),
    filter: String(formData.get("filter") ?? ""),
    seconds: Number(formData.get("seconds") ?? 15),
    maxKb: Number(formData.get("maxKb") ?? 2048),
  });
  revalidatePath("/traffic");
}

export default async function TrafficPage() {
  await requireAdmin();
  const sites = loadSites();
  const [state, top, matrix, captures] = await Promise.all([
    control.state().catch(() => ({ nodes: {} as Record<string, any> })),
    control.flowsTop(3600).catch(() => ({ top: [] })),
    promMatrix(),
    control.captures().catch(() => ({ captures: [] })),
  ]);
  const keyToName = new Map([
    ...sites.cfg.sites.map((s) => [s.gateway.publicKey, s.id] as const),
    ...sites.cfg.clients.map((c) => [c.publicKey, c.id] as const),
  ]);
  const flowsEnabled = sites.cfg.sites.filter((s) => s.gateway.flows).map((s) => s.id);

  return (
    <div className="space-y-6">
      <h1 className="h1">Traffic</h1>
      <p className="text-sm text-zinc-400">
        OPNmesh only sees traffic that crosses a tunnel. Traffic between two hosts at the same site
        never reaches the gateway and is invisible here by design — the numbers are not wrong.
      </p>

      <div className="card">
        <div className="label mb-3">Tier 1 — per-tunnel counters (always on)</div>
        <table className="data">
          <thead>
            <tr>
              <th>Node</th>
              <th>Peer</th>
              <th>Handshake</th>
              <th>Received</th>
              <th>Sent</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(state.nodes as Record<string, any>).flatMap(([id, n]) =>
              (n?.peers ?? []).map((p: any) => (
                <tr key={`${id}|${p.publicKey}`}>
                  <td className="mono">{id}</td>
                  <td className="mono">{keyToName.get(p.publicKey) ?? p.publicKey.slice(0, 12) + "…"}</td>
                  <td>
                    <HandshakeAge unixSec={p.latestHandshake} />
                  </td>
                  <td className="mono">{bytes(p.rxBytes)}</td>
                  <td className="mono">{bytes(p.txBytes)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="label mb-3">Tier 2 — site-to-site matrix (5m rate)</div>
        {matrix === null ? (
          <p className="text-sm text-zinc-500">
            Prometheus unreachable at {PROM_URL} — start the observability stack (npm run mesh:obs)
            or point OPNMESH_PROM_URL at it. Grafana holds the deep historical dashboards.
          </p>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Flow</th>
                <th>Rate</th>
              </tr>
            </thead>
            <tbody>
              {matrix
                .sort((a, b) => b.rate - a.rate)
                .map((m) => (
                  <tr key={m.name}>
                    <td className="mono">{m.name.replace("cnt_", "").replace(/_to_/, " → ").replace(/_/g, "-")}</td>
                    <td className="mono">{bytes(Math.round(m.rate))}/s</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="label mb-3">Tier 3 — per-host top talkers (opt-in per gateway)</div>
        <div className="mb-3 flex flex-wrap gap-2">
          {sites.cfg.sites.map((s) => (
            <form key={s.id} action={toggleFlows}>
              <input type="hidden" name="siteId" value={s.id} />
              <input type="hidden" name="enable" value={s.gateway.flows ? "false" : "true"} />
              <button className={`btn ${s.gateway.flows ? "btn-primary" : ""}`} type="submit">
                {s.id}: {s.gateway.flows ? "on" : "off"}
              </button>
            </form>
          ))}
          <form action={purgeFlows}>
            <button className="btn btn-danger" type="submit">Purge all flow records</button>
          </form>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          Flow logging records who talked to whom. Retention: {sites.cfg.network.flowRetentionDays} days
          (Settings). Enabled on: {flowsEnabled.join(", ") || "none"}.
        </p>
        <table className="data">
          <thead>
            <tr>
              <th>Source</th>
              <th>Destination</th>
              <th>Proto/port</th>
              <th>Bytes</th>
            </tr>
          </thead>
          <tbody>
            {top.top.map((t, i) => (
              <tr key={i}>
                <td className="mono">{t.src}</td>
                <td className="mono">{t.dst}</td>
                <td className="mono">
                  {t.proto}
                  {t.dstPort ? `/${t.dstPort}` : ""}
                </td>
                <td className="mono">{bytes(t.bytes)}</td>
              </tr>
            ))}
            {top.top.length === 0 && (
              <tr>
                <td colSpan={4} className="text-zinc-500">
                  No flow records in the last hour.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="label mb-3">Tier 4 — on-demand capture (time-boxed, size-capped, audited)</div>
        <form action={startCapture} className="flex flex-wrap items-end gap-2">
          <div>
            <div className="label">Gateway</div>
            <select className="input" name="node">
              {sites.cfg.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <div className="label">tcpdump filter</div>
            <input className="input mono" name="filter" placeholder="e.g. host 10.30.5.20 and tcp port 443" />
          </div>
          <div>
            <div className="label">Seconds (≤60)</div>
            <input className="input mono w-20" name="seconds" type="number" defaultValue={15} min={1} max={60} />
          </div>
          <div>
            <div className="label">Max KiB (≤10240)</div>
            <input className="input mono w-24" name="maxKb" type="number" defaultValue={2048} min={64} max={10240} />
          </div>
          <button className="btn btn-primary" type="submit">Capture</button>
        </form>
        <table className="data mt-3">
          <thead>
            <tr>
              <th>Id</th>
              <th>Node</th>
              <th>Status</th>
              <th>Size</th>
              <th>Download</th>
            </tr>
          </thead>
          <tbody>
            {captures.captures.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.id}</td>
                <td className="mono">{c.node}</td>
                <td>{c.status}</td>
                <td className="mono">{c.sizeKb} KiB</td>
                <td>
                  {c.status === "done" && (
                    <a className="text-emerald-400 underline" href={`${CONTROL_URL}/api/v1/admin/captures/${c.id}.pcap`}>
                      pcap
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
