import { z } from "zod";
import { deviceCookie, deviceFromRequest, login, requestSource, sessionCookie } from "@/server/auth";
import { json, parseBody, withPublic } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().max(200), password: z.string().max(200) });

export const POST = withPublic(async (req) => {
  const body = await parseBody(req, schema);
  const device = deviceFromRequest(req);
  const token = await login(body.email, body.password, requestSource(req), device);
  const res = json({ ok: true });
  res.headers.append("Set-Cookie", sessionCookie(token));
  res.headers.append("Set-Cookie", deviceCookie(device));
  return res;
});
