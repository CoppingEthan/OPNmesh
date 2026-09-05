"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import { Button, Card, Pre } from "./components";
import { CopyButton, Notice } from "./components-client";

interface Peek {
  name: string;
  tunnelIp: string;
}
interface Picked {
  name: string;
  slug: string;
  conf: string;
  qrSvg: string;
}

/**
 * The page a home worker opens from an invite link. It shows who the config is
 * for, then reveals the QR code and download exactly once on request, so an
 * accidental preview (a chat client unfurling the link) does not burn it.
 */
export function InvitePickup({ token }: { token: string }) {
  const [peek, setPeek] = useState<Peek | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<Peek>("GET", `/api/invite/${encodeURIComponent(token)}`)
      .then(setPeek)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [token]);

  if (err && !picked) {
    return (
      <Card title="This link cannot be used">
        <p className="text-sm text-ink-2">{err}</p>
      </Card>
    );
  }
  if (!picked) {
    return (
      <Card title="Your VPN configuration" description={peek ? `Prepared for ${peek.name}.` : "Checking the link…"}>
        <p className="text-sm text-ink-2">
          This link works <strong>once</strong>. Have the WireGuard app ready on the device you want to connect, then reveal the configuration.
        </p>
        <Button
          variant="primary"
          className="mt-4 w-full"
          disabled={!peek || busy}
          onClick={async () => {
            setBusy(true);
            try {
              setPicked(await apiFetch<Picked>("POST", `/api/invite/${encodeURIComponent(token)}`));
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Preparing…" : "Reveal my configuration"}
        </Button>
      </Card>
    );
  }
  const filename = `${picked.slug.slice(0, 15)}.conf`;
  const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(picked.conf)}`;
  return (
    <div className="space-y-4">
      <Card title={`Configuration for ${picked.name}`} description="Keep this private: anyone with it can join the network as you.">
        <Notice tone="info">This link has now been used up. Save the file or scan the code before closing the page.</Notice>
        <div className="mt-4 grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold text-ink">Phone or tablet</h3>
            <p className="mb-2 text-xs text-ink-2">In the WireGuard app choose “Add a tunnel” → “Scan from QR code”.</p>
            <div className="rounded-lg border border-line bg-white p-2 [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: picked.qrSvg }} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink">Laptop or desktop</h3>
            <p className="mb-2 text-xs text-ink-2">Download the file, then in the WireGuard app choose “Import tunnel(s) from file”.</p>
            <a href={dataUrl} download={filename} className="inline-flex h-9 items-center rounded-lg bg-brand px-3.5 text-sm font-medium text-white hover:bg-brand-strong">
              Download {filename}
            </a>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-ink-3">Or copy the text</span>
              <CopyButton text={picked.conf} />
            </div>
            <Pre className="mt-2 max-h-64 overflow-y-auto">{picked.conf}</Pre>
          </div>
        </div>
      </Card>
      <Card title="Get the WireGuard app">
        <ul className="grid gap-1 text-sm text-ink-2 sm:grid-cols-2">
          <li><a className="text-brand-ink hover:underline" href="https://www.wireguard.com/install/" target="_blank" rel="noreferrer">Windows and macOS</a></li>
          <li><a className="text-brand-ink hover:underline" href="https://apps.apple.com/app/wireguard/id1441195209" target="_blank" rel="noreferrer">iPhone and iPad</a></li>
          <li><a className="text-brand-ink hover:underline" href="https://play.google.com/store/apps/details?id=com.wireguard.android" target="_blank" rel="noreferrer">Android</a></li>
          <li><a className="text-brand-ink hover:underline" href="https://www.wireguard.com/install/" target="_blank" rel="noreferrer">Linux</a></li>
        </ul>
      </Card>
    </div>
  );
}
