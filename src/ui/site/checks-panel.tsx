"use client";

/**
 * Health checks for one site: what the controller can see plus what the
 * gateway found when last asked. Problems first, then warnings, then the
 * things that passed, so the eye lands on what matters.
 */
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, MinusCircle, PlayCircle, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CheckResult, SiteDiagnostics } from "@/server/diagnostics";
import type { SiteState } from "@/server/state";
import { apiFetch } from "../api";
import { Button, Card, cx } from "../components";
import { Ago, Notice } from "../components-client";

const ORDER: Record<CheckResult["status"], number> = { fail: 0, warn: 1, pass: 2, skip: 3 };

function Icon({ status }: { status: CheckResult["status"] }) {
  const cls = "mt-0.5 h-4 w-4 shrink-0";
  if (status === "fail") return <XCircle className={cx(cls, "text-bad")} aria-label="Failed" />;
  if (status === "warn") return <AlertTriangle className={cx(cls, "text-warn")} aria-label="Warning" />;
  if (status === "pass") return <CheckCircle2 className={cx(cls, "text-good")} aria-label="Passed" />;
  return <MinusCircle className={cx(cls, "text-ink-3")} aria-label="Skipped" />;
}

function Row({ c }: { c: CheckResult }) {
  const quiet = c.status === "pass" || c.status === "skip";
  return (
    <li className={cx("flex items-start gap-3 px-5 py-2.5", !quiet && "bg-surface-2/60")}>
      <Icon status={c.status} />
      <div className="min-w-0 flex-1 text-sm">
        <div className={cx("font-medium", quiet ? "text-ink-2" : "text-ink")}>{c.title}</div>
        {c.detail && <div className={cx("text-xs", quiet ? "text-ink-3" : "text-ink-2")}>{c.detail}</div>}
        {c.hint && !quiet && (
          <div className="mt-1 text-xs text-ink-2">
            <span className="font-medium text-ink">Try:</span> {c.hint}
          </div>
        )}
      </div>
    </li>
  );
}

export function ChecksPanel({ site }: { site: SiteState }) {
  const [diag, setDiag] = useState<SiteDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassed, setShowPassed] = useState(false);
  const hasGateway = site.gateway !== null;

  const load = useCallback(async () => {
    try {
      setDiag(await apiFetch<SiteDiagnostics>("GET", `/api/admin/sites/${site.id}/diagnostics`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [site.id]);

  useEffect(() => {
    if (!hasGateway) return;
    let cancelled = false;
    apiFetch<SiteDiagnostics>("GET", `/api/admin/sites/${site.id}/diagnostics`)
      .then((d) => {
        if (cancelled) return;
        setDiag(d);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [hasGateway, site.id]);

  // While the gateway is working on a request, poll for its answer.
  useEffect(() => {
    if (!diag?.pending) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [diag?.pending, load]);

  const run = async () => {
    setBusy(true);
    try {
      await apiFetch("POST", `/api/admin/sites/${site.id}/diagnostics`, {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const checks = diag ? [...diag.controller, ...diag.agent].sort((a, b) => ORDER[a.status] - ORDER[b.status]) : [];
  const problems = checks.filter((c) => c.status === "fail" || c.status === "warn");
  const quiet = checks.filter((c) => c.status === "pass" || c.status === "skip");
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;

  return (
    <Card
      title="Health checks"
      description="Quick tests that narrow a problem down: run from the controller and from the gateway itself, including whether the site router really sends each remote network to the gateway."
      padded={false}
      actions={
        hasGateway ? (
          <Button size="sm" variant="secondary" onClick={run} disabled={busy || diag?.pending === true}>
            <PlayCircle className="h-4 w-4" /> {diag?.pending ? "Running…" : "Run checks"}
          </Button>
        ) : null
      }
    >
      {!hasGateway ? (
        <p className="px-5 py-6 text-sm text-ink-3">Install the gateway first; the checks run on it.</p>
      ) : !diag ? (
        <p className="px-5 py-6 text-sm text-ink-3">{error ?? "Loading…"}</p>
      ) : (
        <div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-5 py-3 text-xs text-ink-3">
            <span className={cx("font-medium", fails > 0 ? "text-bad-ink" : warns > 0 ? "text-warn-ink" : "text-good-ink")}>
              {fails > 0 ? `${fails} problem${fails === 1 ? "" : "s"}` : warns > 0 ? `${warns} warning${warns === 1 ? "" : "s"}` : "Nothing wrong found"}
            </span>
            {warns > 0 && fails > 0 && <span>{warns} warning{warns === 1 ? "" : "s"}</span>}
            <span>{quiet.length} passed or not applicable</span>
            {diag.pending ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" /> waiting for the gateway
              </span>
            ) : diag.agentAt ? (
              <span>
                gateway ran its checks <Ago ts={diag.agentAt} />
              </span>
            ) : (
              <span>the gateway has not run its checks yet</span>
            )}
          </div>
          {error && (
            <div className="px-5 pt-3">
              <Notice tone="error">{error}</Notice>
            </div>
          )}
          {diag.agentUnanswered && !diag.pending && (
            <div className="px-5 pt-3">
              <Notice tone="info">The gateway did not answer the last request. It only runs checks while it is reporting; the controller-side results below still apply.</Notice>
            </div>
          )}
          {!diag.agentAt && !diag.pending && diag.agent.length === 0 && (
            <p className="px-5 pt-3 text-xs text-ink-3">Press “Run checks” to have the gateway test forwarding, its firewall, routes, the site router and packet sizes.</p>
          )}
          <ul className="divide-y divide-line">
            {problems.map((c) => (
              <Row key={c.id} c={c} />
            ))}
          </ul>
          {quiet.length > 0 && (
            <div className="border-t border-line">
              <button type="button" onClick={() => setShowPassed((v) => !v)} className="flex w-full items-center gap-2 px-5 py-2.5 text-left text-xs text-ink-2 hover:bg-surface-2">
                {showPassed ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                {showPassed ? "Hide" : "Show"} the {quiet.length} that passed or did not apply
              </button>
              {showPassed && (
                <ul className="divide-y divide-line border-t border-line">
                  {quiet.map((c) => (
                    <Row key={c.id} c={c} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
