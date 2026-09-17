import { z } from "zod";
import { completeSetup, deviceCookie, login, needsSetup, requestSource, sessionCookie, setupCode } from "@/server/auth";
import { json, parseBody, withPublic } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = withPublic(async () => {
  const pending = needsSetup();
  // Makes sure data/setup-code exists while setup is pending, including after a reset.
  if (pending) setupCode();
  return json({ needsSetup: pending });
});

const schema = z.object({ code: z.string().min(1).max(64), email: z.string().max(200), password: z.string().max(200) });

/** First run: create the admin with the code printed in the controller log, then sign in. */
export const POST = withPublic(async (req) => {
  const body = await parseBody(req, schema);
  const source = requestSource(req);
  await completeSetup(body, source);
  const token = await login(body.email, body.password, source);
  const res = json({ ok: true });
  res.headers.append("Set-Cookie", sessionCookie(token));
  res.headers.append("Set-Cookie", deviceCookie(null));
  return res;
});
