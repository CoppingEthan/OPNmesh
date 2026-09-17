/** Audit log. Every state change and every notable gateway event lands here. */
import { desc, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { now } from "./env";

export type EventKind =
  | "setup"
  | "login"
  | "settings"
  | "site"
  | "lan"
  | "gateway"
  | "enrol"
  | "client"
  | "invite"
  | "unifi"
  | "alert"
  | "apply-error"
  | "system";

export function logEvent(
  kind: EventKind,
  message: string,
  opts: { actor?: string; subject?: string; detail?: unknown } = {},
): void {
  getDb()
    .insert(events)
    .values({
      ts: now(),
      actor: opts.actor ?? "system",
      kind,
      subject: opts.subject ?? "",
      message,
      detail: opts.detail === undefined ? null : JSON.stringify(opts.detail),
    })
    .run();
}

export const MAX_EVENTS_PAGE = 1000;

/** Newest first, `limit` clamped to 1–1000 (SQLite reads a negative LIMIT as "no limit"). */
export function listEvents(limit = 200, before?: number) {
  const db = getDb();
  const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_EVENTS_PAGE) : 200;
  const q = db.select().from(events).orderBy(desc(events.id)).limit(n);
  return before !== undefined && Number.isSafeInteger(before) && before > 0 ? q.where(lt(events.id, before)).all() : q.all();
}

export function pruneEvents(olderThanMs: number): number {
  return getDb().delete(events).where(lt(events.ts, now() - olderThanMs)).run().changes;
}
