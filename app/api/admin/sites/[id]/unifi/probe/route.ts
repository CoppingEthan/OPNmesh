import { z } from "zod";
import { errorResponse, json, parseBody, withAdmin } from "@/server/http";
import { probeConsole, UnifiLinkError } from "@/server/unifi";
import { UnifiError } from "@/server/unifi/client";
import { authSchema } from "../route";

export const dynamic = "force-dynamic";

const schema = z.object({
  baseUrl: z.string().min(1).max(300),
  unifiSite: z.string().max(64).default("default"),
  auth: authSchema,
  standalone: z.boolean().optional(),
  /** Fingerprint the admin has just confirmed; credentials are only sent once trusted. */
  trustFingerprint: z.string().max(128).nullable().optional(),
});

/** Step 1 of linking: fetch the console certificate and, once trusted, verify the credentials. */
export const POST = withAdmin<{ id: string }>(async (req) => {
  try {
    const body = await parseBody(req, schema);
    return json(await probeConsole(body));
  } catch (e) {
    if (e instanceof UnifiLinkError) return json({ error: e.message }, e.status);
    if (e instanceof UnifiError) return json({ error: e.message }, 502);
    return errorResponse(e);
  }
});
