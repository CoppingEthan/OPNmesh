import { errorResponse, json, withAdmin } from "@/server/http";
import { AlertError, SmtpError, sendTestEmail } from "@/server/alerts";

export const dynamic = "force-dynamic";

/** Send a test message to the alert recipients with the saved SMTP settings. */
export const POST = withAdmin(async (_req, { admin }) => {
  try {
    const to = await sendTestEmail(admin.email);
    return json({ ok: true, to });
  } catch (e) {
    if (e instanceof AlertError) return json({ error: e.message }, 400);
    // A category only; the server's own reply is in the controller log.
    if (e instanceof SmtpError) return json({ error: `the test email was not sent: ${e.message}` }, 502);
    return errorResponse(e);
  }
});
