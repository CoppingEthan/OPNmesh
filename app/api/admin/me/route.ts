import { z } from "zod";
import { changePassword } from "@/server/auth";
import { json, parseBody, withAdmin } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = withAdmin(async (_req, { admin }) => json({ email: admin.email }));

const schema = z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) });

export const POST = withAdmin(async (req, { admin }) => {
  const body = await parseBody(req, schema);
  await changePassword(admin.userId, body.currentPassword, body.newPassword);
  return json({ ok: true, message: "password changed — sign in again" });
});
