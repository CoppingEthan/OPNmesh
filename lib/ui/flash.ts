/**
 * One-shot server-side store for values that must be shown to the operator
 * exactly once and must never appear in a URL — enrolment tokens above all.
 * A token in a query string survives in browser history, proxy access logs
 * and Referer headers; anyone reading those could enrol a node.
 */
import { randomBytes } from "node:crypto";

interface Entry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();
const TTL_MS = 5 * 60 * 1000;

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of store) if (now > v.expiresAt) store.delete(k);
}

/** Stash a value and return an opaque id safe to put in a redirect URL. */
export function stash(value: unknown): string {
  sweep();
  const id = randomBytes(12).toString("hex");
  store.set(id, { value, expiresAt: Date.now() + TTL_MS });
  return id;
}

/** Read and delete. Returns null if unknown or expired. */
export function take<T>(id: string | undefined): T | null {
  if (!id) return null;
  sweep();
  const entry = store.get(id);
  if (!entry) return null;
  store.delete(id);
  return entry.value as T;
}
