/** Session access for server components and layouts. */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, needsSetup, sessionFromToken, type AdminSession } from "./auth";

export async function currentAdmin(): Promise<AdminSession | null> {
  const jar = await cookies();
  return sessionFromToken(jar.get(SESSION_COOKIE)?.value);
}

/** Redirects to /setup on a fresh install, or /login without a session. */
export async function requireAdmin(): Promise<AdminSession> {
  if (needsSetup()) redirect("/setup");
  const admin = await currentAdmin();
  if (!admin) redirect("/login");
  return admin;
}
