"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, buttonClass, cx } from "./components";
import { ago } from "./format";

export function CopyButton({ text, label = "Copy", size = "sm", className }: { text: string; label?: string; size?: "sm" | "md"; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={buttonClass("secondary", size, className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? <Check className="h-3.5 w-3.5 text-good" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? "Copied" : label}
    </button>
  );
}

/** Relative time that keeps ticking. */
export function Ago({ ts }: { ts: number | null | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  // The relative value and the absolute title both depend on when and where
  // they are rendered, so the server's copy legitimately differs from the
  // client's; let the client's stand without a hydration complaint.
  return (
    <span title={ts ? new Date(ts).toLocaleString() : undefined} suppressHydrationWarning>
      {ago(ts)}
    </span>
  );
}

/** A native <dialog> with a header and a close button. */
export function Dialog({ open, onClose, title, children, wide = false }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cx("glass-strong m-auto w-[calc(100%-2rem)] rounded-card p-0 text-ink", wide ? "max-w-3xl" : "max-w-lg")}
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          ✕
        </Button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}

/** Inline error/success message for forms. */
export function Notice({ tone, children }: { tone: "error" | "success" | "info"; children: ReactNode }) {
  if (!children) return null;
  const cls = { error: "bg-bad-soft text-bad-ink", success: "bg-good-soft text-good-ink", info: "bg-surface-2 text-ink-2" }[tone];
  return <div className={cx("rounded-lg px-3 py-2 text-sm", cls)}>{children}</div>;
}

export function ConfirmButton({ label, confirmLabel = "Confirm", onConfirm, variant = "danger", description, size = "sm" }: { label: ReactNode; confirmLabel?: string; onConfirm: () => Promise<void> | void; variant?: "danger" | "secondary" | "primary"; description?: ReactNode; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={label}>
        {description && <p className="mb-4 text-sm text-ink-2">{description}</p>}
        {err && <Notice tone="error">{err}</Notice>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant={variant === "secondary" ? "primary" : variant}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await onConfirm();
                setOpen(false);
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
