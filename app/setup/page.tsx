import { redirect } from "next/navigation";
import { adminConfigured, setAdminPassword, login } from "../../lib/ui/auth.js";

// Auth state is read from the database per request — never prerendered.
export const dynamic = "force-dynamic";

async function doSetup(formData: FormData) {
  "use server";
  if (adminConfigured()) redirect("/login");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password !== confirm || password.length < 10) redirect("/setup?failed=1");
  await setAdminPassword(password);
  await login(password);
  redirect("/");
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ failed?: string }>;
}) {
  if (adminConfigured()) redirect("/login");
  const params = await searchParams;
  return (
    <div className="mx-auto mt-24 max-w-sm">
      <div className="card">
        <h1 className="h1 mb-2">First run — create the admin account</h1>
        <p className="mb-4 text-sm text-zinc-400">
          One local admin account controls this panel. Minimum 10 characters.
        </p>
        {params.failed && <p className="status-bad mb-3 text-sm">Passwords must match and be ≥ 10 characters.</p>}
        <form action={doSetup} className="space-y-3">
          <input className="input" type="password" name="password" placeholder="Admin password" autoFocus />
          <input className="input" type="password" name="confirm" placeholder="Confirm password" />
          <button className="btn btn-primary w-full" type="submit">
            Create account
          </button>
        </form>
      </div>
    </div>
  );
}
