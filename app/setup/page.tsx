import { redirect } from "next/navigation";
import {
  adminConfigured,
  bootstrapToken,
  createAdminAccount,
  login,
  passwordProblem,
} from "../../lib/ui/auth.js";

// Auth state is read from the database per request — never prerendered.
export const dynamic = "force-dynamic";

async function doSetup(formData: FormData) {
  "use server";
  if (adminConfigured()) redirect("/login");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const token = String(formData.get("token") ?? "").trim();

  if (password !== confirm) redirect("/setup?err=" + encodeURIComponent("Passwords do not match."));
  const problem = passwordProblem(password);
  if (problem) redirect("/setup?err=" + encodeURIComponent(problem));

  const created = await createAdminAccount(password, token);
  if (!created) {
    redirect("/setup?err=" + encodeURIComponent("That setup token is not valid."));
  }
  await login(password);
  redirect("/");
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string }>;
}) {
  if (adminConfigured()) redirect("/login");
  const params = await searchParams;
  // Generates and logs the token on first render if it does not exist yet.
  bootstrapToken();

  return (
    <div className="mx-auto mt-20 max-w-lg">
      <div className="card">
        <h1 className="h1 mb-1">Welcome to OPNmesh</h1>
        <p className="mb-5 text-sm text-zinc-400">
          Let&rsquo;s create the account you&rsquo;ll use to manage your network. This is the only
          account, and it lives on this machine.
        </p>

        <div className="mb-5 rounded border border-zinc-800 bg-black/40 p-3">
          <div className="label mb-1">Step 1 — find your setup code</div>
          <p className="text-sm text-zinc-400">
            To prove you&rsquo;re the person who installed OPNmesh, we need a one-time code. It was
            printed in the server log when OPNmesh started, and it&rsquo;s also saved on this
            machine.
          </p>
          <pre className="conf mt-2">docker compose logs control | grep &quot;setup token&quot;</pre>
        </div>

        {params.err && <p className="status-bad mb-3 text-sm">{params.err}</p>}

        <form action={doSetup} className="space-y-3">
          <div>
            <div className="label mb-1">Setup code</div>
            <input className="input mono" name="token" placeholder="Paste the code from the log" autoFocus required />
          </div>
          <div>
            <div className="label mb-1">Choose a password (at least 12 characters)</div>
            <input className="input" type="password" name="password" required />
          </div>
          <div>
            <div className="label mb-1">Type it again</div>
            <input className="input" type="password" name="confirm" required />
          </div>
          <button className="btn btn-primary w-full" type="submit">
            Create my account
          </button>
        </form>
      </div>
    </div>
  );
}
