import { redirect } from "next/navigation";
import { needsSetup } from "@/server/auth";
import { currentAdmin } from "@/server/session";
import { LoginForm } from "@/ui/auth-forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (needsSetup()) redirect("/setup");
  if (await currentAdmin()) redirect("/");
  return <LoginForm />;
}
