import { z } from "zod";
import { completeSetup, login, needsSetup, requestSource, sessionCookie } from "@/server/auth";
import { json, parseBody, withPublic } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = withPublic(async () => json({ needsSetup: needsSetup() }));

const schema = z.object({ code: z.string().min(1).max(64), email: z.string().max(200), password: z.string().max(200) });

/** First run: create the admin with the code printed in the controller log, then sign in. */
export const POST = withPublic(async (req) => {
  const body = await parseBody(req, schema);
  const source = requestSource(req);
  await completeSetup(body, source);
  const token = await login(body.email, body.password, source);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
});
