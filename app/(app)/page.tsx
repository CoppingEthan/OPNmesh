import { requireAdmin } from "@/server/session";
import { buildState } from "@/server/state";
import { listEvents } from "@/server/events";
import { Overview } from "@/ui/overview";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  await requireAdmin();
  const state = buildState();
  const events = listEvents(8).map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, message: e.message, actor: e.actor }));
  return <Overview initial={state} events={events} />;
}
