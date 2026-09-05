/**
 * The small component set the whole UI is built from. Server-safe unless
 * marked; interactive pieces live in components-client.tsx.
 */
import Link from "next/link";
import type { ReactNode } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Layout

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs font-medium uppercase tracking-wider text-ink-3">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className, title, description, actions, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; description?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={cx("glass rounded-card", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-ink-2">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? "p-5" : ""}>{children}</div>
    </section>
  );
}

export function EmptyState({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="glass flex flex-col items-center justify-center rounded-card px-6 py-12 text-center">
      <div className="text-base font-medium text-ink">{title}</div>
      {description && <p className="mt-1 max-w-md text-sm text-ink-2">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons and links

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string): string {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap select-none";
  const sizes = { sm: "h-8 px-2.5 text-xs", md: "h-9 px-3.5 text-sm" }[size];
  const variants = {
    primary: "bg-gradient-to-b from-brand to-brand-strong text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_8px_18px_-8px_var(--brand)] hover:brightness-105",
    secondary: "border border-line-strong bg-surface text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] hover:bg-surface-3",
    ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
    danger: "border border-bad/30 bg-surface text-bad-ink hover:bg-bad-soft",
  }[variant];
  return cx(base, sizes, variants, extra);
}

export function Button({ variant, size, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={buttonClass(variant, size, className)} type={rest.type ?? "button"} {...rest} />;
}

export function LinkButton({ href, variant, size, className, children }: { href: string; variant?: ButtonVariant; size?: ButtonSize; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Status

export type Tone = "good" | "warn" | "bad" | "idle" | "brand" | "info";

const TONE_CLASSES: Record<Tone, string> = {
  good: "bg-good-soft text-good-ink",
  warn: "bg-warn-soft text-warn-ink",
  bad: "bg-bad-soft text-bad-ink",
  idle: "bg-idle-soft text-ink-2",
  brand: "bg-brand-soft text-brand-ink",
  info: "bg-surface-2 text-ink-2",
};
const DOT_CLASSES: Record<Tone, string> = {
  good: "bg-good",
  warn: "bg-warn",
  bad: "bg-bad",
  idle: "bg-idle",
  brand: "bg-brand",
  info: "bg-ink-3",
};

export function Badge({ tone = "info", children, dot = false, pulse = false, className }: { tone?: Tone; children: ReactNode; dot?: boolean; pulse?: boolean; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", TONE_CLASSES[tone], className)}>
      {dot && <span className={cx("inline-block h-1.5 w-1.5 rounded-full", DOT_CLASSES[tone], pulse && tone === "good" && "pulse-good")} />}
      {children}
    </span>
  );
}

export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span className={cx("inline-block h-2.5 w-2.5 rounded-full", DOT_CLASSES[tone], className)} aria-hidden />;
}

export function healthTone(health: string): Tone {
  switch (health) {
    case "online":
    case "up":
      return "good";
    case "stale":
    case "handshake-only":
    case "pending":
      return "warn";
    case "offline":
    case "down":
      return "bad";
    default:
      return "idle";
  }
}

export function healthLabel(health: string): string {
  switch (health) {
    case "online":
      return "Online";
    case "stale":
      return "Slow to report";
    case "offline":
      return "Not responding";
    case "pending":
      return "Awaiting approval";
    case "disabled":
      return "Disabled";
    case "never":
      return "Never connected";
    case "up":
      return "Up";
    case "handshake-only":
      return "Handshake only";
    case "down":
      return "Down";
    default:
      return "Unknown";
  }
}

// ---------------------------------------------------------------------------
// Stats

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="glass rounded-card px-4 py-3">
      <div className="text-xs font-medium text-ink-3">{label}</div>
      <div className={cx("mt-1 text-2xl font-semibold tracking-tight", tone === "bad" ? "text-bad-ink" : tone === "warn" ? "text-warn-ink" : "text-ink")}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-2">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forms

export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-bad-ink">{error}</span> : hint ? <span className="mt-1 block text-xs text-ink-3">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "block w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:opacity-60";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputClass, "pr-8", props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputClass, "min-h-20", props.className)} />;
}

export function Checkbox({ label, hint, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" {...props} className="mt-0.5 h-4 w-4 rounded border-line-strong accent-brand" />
      <span>
        <span className="block text-sm text-ink">{label}</span>
        {hint && <span className="block text-xs text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Misc

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cx("mono rounded bg-surface-2 px-1.5 py-0.5 text-[0.8em] text-ink", className)}>{children}</code>;
}

export function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return <pre className={cx("mono overflow-x-auto rounded-lg border border-line bg-surface-2 p-4 text-xs leading-5 text-ink", className)}>{children}</pre>;
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={cx("w-full border-collapse text-sm", className)}>{children}</table>
    </div>
  );
}

export function Th({ children, className, align = "left", ...rest }: React.ThHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" }) {
  return (
    <th {...rest} className={cx("border-b border-line px-3 py-2 text-xs font-medium text-ink-3", align === "right" ? "text-right" : "text-left", className)}>
      {children}
    </th>
  );
}

export function Td({ children, className, align = "left", ...rest }: React.TdHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" }) {
  return (
    <td {...rest} className={cx("border-b border-line px-3 py-2.5 align-middle", align === "right" ? "text-right tnum" : "", className)}>
      {children}
    </td>
  );
}

export function Tabs({ items, current }: { items: Array<{ href: string; label: string; badge?: ReactNode }>; current: string }) {
  return (
    <nav className="mb-6 flex gap-1 border-b border-line">
      {items.map((t) => {
        const active = current === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cx(
              "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors",
              active ? "border-brand font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            {t.label}
            {t.badge}
          </Link>
        );
      })}
    </nav>
  );
}

export function Callout({ tone = "info", title, children }: { tone?: Tone; title?: ReactNode; children: ReactNode }) {
  const border = { good: "border-good/30", warn: "border-warn/40", bad: "border-bad/30", idle: "border-line", brand: "border-brand/30", info: "border-line" }[tone];
  return (
    <div className={cx("rounded-lg border px-4 py-3 text-sm", TONE_CLASSES[tone], border)}>
      {title && <div className="mb-0.5 font-medium">{title}</div>}
      <div className="opacity-90">{children}</div>
    </div>
  );
}
