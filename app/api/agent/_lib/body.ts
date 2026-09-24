/**
 * Request bodies from gateways, read under tighter limits than parseBody's
 * 1 MiB. What a gateway sends has a known shape and size, so anything much
 * bigger is refused before it is buffered, parsed or validated.
 *
 * (A private folder: nothing here is a route.)
 */
import type { ZodType } from "zod";
import { HttpError } from "@/server/http";

/**
 * A telemetry report: roughly 180 bytes a peer and 100 a counter. A hub
 * relaying between 40 outbound-only sites reports about 1,600 counters,
 * some 160 KiB; the limit leaves room for several hundred clients on top.
 */
export const TELEMETRY_MAX_BODY = 512 * 1024;
/** Health-check results: a few dozen checks of a few hundred bytes each in a large mesh. */
export const DIAGNOSTICS_MAX_BODY = 256 * 1024;
/** An enrolment request: a token, a key and a few host facts. */
export const ENROL_MAX_BODY = 32 * 1024;

/**
 * The body as text, refused as soon as it passes `max`. A chunked upload has
 * no Content-Length, so the limit is enforced while reading.
 */
async function readBody(req: Request, max: number): Promise<string> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > max) throw new HttpError(413, "body too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "body too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Like parseBody in @/server/http, with the caller's size limit. */
export async function parseAgentBody<T>(req: Request, schema: ZodType<T>, max: number): Promise<T> {
  let raw: unknown;
  try {
    const textBody = await readBody(req, max);
    raw = textBody.length === 0 ? {} : JSON.parse(textBody);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "body must be JSON");
  }
  return schema.parse(raw);
}
