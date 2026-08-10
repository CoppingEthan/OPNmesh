import { redirect } from "next/navigation";
import { adminConfigured, login } from "../../lib/ui/auth.js";

// Auth state is read from the database per request — never prerendered.
export const dynamic = "force-dynamic";

async function doLogin(formData: FormData) {
  "use server";
  const ok = await login(String(formData.get("password") ?? ""));
  redirect(ok ? "/" : "/login?failed=1");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ failed?: string }>;
}) {
  if (!adminConfigured()) redirect("/setup");
  const params = await searchParams;
  return (
    <div className="mx-auto mt-24 max-w-sm">
      <div className="card">
        <h1 className="h1 mb-4">Sign in</h1>
        {params.failed && (
          <p className="status-bad mb-3 text-sm">Wrong password (or too many attempts — wait 15 minutes).</p>
        )}
        <form action={doLogin} className="space-y-3">
          <input className="input" type="password" name="password" placeholder="Admin password" autoFocus />
          <button className="btn btn-primary w-full" type="submit">
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
