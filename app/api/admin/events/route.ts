import { json, withAdmin } from "@/server/http";
import { listEvents } from "@/server/events";

export const dynamic = "force-dynamic";

/** A whole number from a query parameter, undefined when absent, null when malformed. */
function wholeNumber(v: string | null): number | null | undefined {
  if (v === null || v === "") return undefined;
  return /^-?\d{1,16}$/.test(v) ? Number(v) : null;
}

/** `limit` is clamped to 1–1000; `before` is an event id cursor. */
export const GET = withAdmin(async (req) => {
  const u = new URL(req.url);
  const limit = wholeNumber(u.searchParams.get("limit"));
  const before = wholeNumber(u.searchParams.get("before"));
  if (limit === null) return json({ error: "limit must be a whole number" }, 400);
  if (before === null || (before !== undefined && before < 1)) return json({ error: "before must be a positive event id" }, 400);
  return json(listEvents(limit ?? 200, before));
});
