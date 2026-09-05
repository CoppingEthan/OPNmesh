import { json, withAdmin } from "@/server/http";
import { listEvents } from "@/server/events";

export const dynamic = "force-dynamic";

export const GET = withAdmin(async (req) => {
  const u = new URL(req.url);
  const limit = Number(u.searchParams.get("limit") ?? "200");
  const before = u.searchParams.get("before");
  return json(listEvents(Number.isFinite(limit) ? limit : 200, before ? Number(before) : undefined));
});
