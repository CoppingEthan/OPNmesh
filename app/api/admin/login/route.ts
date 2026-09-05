import { z } from "zod";
import { login, requestSource, sessionCookie } from "@/server/auth";
import { json, parseBody, withPublic } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().max(200), password: z.string().max(200) });

export const POST = withPublic(async (req) => {
  const body = await parseBody(req, schema);
  const token = await login(body.email, body.password, requestSource(req));
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
});
