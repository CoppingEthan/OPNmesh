/** Where an audit-log entry points: the page of the site or client it is about. */

/** Kinds whose subject is a site id (alert emails are about a site's gateway). */
const SITE_KINDS = new Set(["site", "lan", "gateway", "enrol", "unifi", "apply-error", "alert"]);
/** Kinds whose subject is a client id. */
const CLIENT_KINDS = new Set(["client", "invite"]);

export function eventHref(e: { kind: string; subject: string }): string | null {
  if (!e.subject) return null;
  if (SITE_KINDS.has(e.kind)) return `/sites/${encodeURIComponent(e.subject)}`;
  if (CLIENT_KINDS.has(e.kind)) return `/clients/${encodeURIComponent(e.subject)}`;
  return null;
}
