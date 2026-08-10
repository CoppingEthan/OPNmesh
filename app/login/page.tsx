import { redirect } from "next/navigation";
import { adminConfigured, login } from "../../lib/ui/auth.js";

// Auth state is read from the database per request — never prerendered.
export const dynamic = "force-dynamic";

async function doLogin(formData: FormData) {
  "use server";
  const result = await login(String(formData.get("password") ?? ""));
  if (result.ok) redirect("/");
  redirect(result.throttled ? "/login?throttled=1" : "/login?failed=1");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ failed?: string; throttled?: string }>;
}) {
  if (!adminConfigured()) redirect("/setup");
  const params = await searchParams;
  return (
    <div className="mx-auto mt-24 max-w-sm">
      <div className="card">
        <h1 className="h1 mb-1">
          <span className="text-emerald-400">OPN</span>mesh
        </h1>
        <p className="mb-4 text-sm text-zinc-400">Sign in to manage your network.</p>
        {params.failed && <p className="status-bad mb-3 text-sm">That password is not correct.</p>}
        {params.throttled && (
          <p className="status-warn mb-3 text-sm">
            Too many failed attempts from this address. Try again in a few minutes.
          </p>
        )}
        <form action={doLogin} className="space-y-3">
          <input className="input" type="password" name="password" placeholder="Password" autoFocus />
          <button className="btn btn-primary w-full" type="submit">
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
