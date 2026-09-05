import { json, withAdmin } from "@/server/http";
import { AlertError, sendTestEmail } from "@/server/alerts";

export const dynamic = "force-dynamic";

/** Send a test message to the alert recipients with the saved SMTP settings. */
export const POST = withAdmin(async (_req, { admin }) => {
  try {
    const to = await sendTestEmail(admin.email);
    return json({ ok: true, to });
  } catch (e) {
    if (e instanceof AlertError) return json({ error: e.message }, 400);
    return json({ error: `the mail server refused the message: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }
});
