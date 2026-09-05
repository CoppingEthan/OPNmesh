"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "./api";
import { Button, Card, Field, Input } from "./components";
import { Notice } from "./components-client";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Sign in" description="Use the admin account created during setup.">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await apiFetch("POST", "/api/admin/login", { email, password });
            router.push("/");
            router.refresh();
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : String(e2));
          } finally {
            setBusy(false);
          }
        }}
      >
        {err && <Notice tone="error">{err}</Notice>}
        <Field label="Email">
          <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </Card>
  );
}

export function SetupForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Welcome to OPNmesh" description="Create the admin account. The setup code is printed in the controller's log at start-up, so only someone with access to the server can do this.">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (password !== confirm) {
            setErr("passwords do not match");
            return;
          }
          setBusy(true);
          setErr(null);
          try {
            await apiFetch("POST", "/api/admin/setup", { code, email, password });
            router.push("/");
            router.refresh();
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : String(e2));
          } finally {
            setBusy(false);
          }
        }}
      >
        {err && <Notice tone="error">{err}</Notice>}
        <Field label="Setup code" hint="From the controller log: docker compose logs controller">
          <Input className="mono uppercase" required value={code} onChange={(e) => setCode(e.target.value)} autoFocus placeholder="XXXXXXXXXXXX" />
        </Field>
        <Field label="Your email">
          <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" hint="At least 12 characters. A sentence works well.">
          <Input type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Confirm password">
          <Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? "Creating…" : "Create admin account"}
        </Button>
      </form>
    </Card>
  );
}
