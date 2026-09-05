import { logout, sessionCookie, tokenFromRequest } from "@/server/auth";
import { json, withPublic } from "@/server/http";

export const dynamic = "force-dynamic";

export const POST = withPublic(async (req) => {
  logout(tokenFromRequest(req));
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(null) });
});
