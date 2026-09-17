import { redirect } from "next/navigation";
import { needsSetup, setupCode } from "@/server/auth";
import { SetupForm } from "@/ui/auth-forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "First-run setup" };

export default function SetupPage() {
  if (!needsSetup()) redirect("/login");
  setupCode(); // writes data/setup-code if a reset removed it
  return <SetupForm />;
}
