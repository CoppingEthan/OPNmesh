import { z } from "zod";
import { json, parseBody, withAdmin } from "@/server/http";
import { getSettings, updateSettings } from "@/server/settings";
import { AlertError, smtpView, updateSmtp } from "@/server/alerts";

export const dynamic = "force-dynamic";

function view() {
  const { smtpPassEnc: _p, ...rest } = getSettings();
  return { ...rest, ...smtpView() };
}

export const GET = withAdmin(async () => json(view()));

const schema = z.object({
  networkName: z.string().min(1).max(80).optional(),
  gatewayCidr: z.string().max(18).optional(),
  clientCidr: z.string().max(18).optional(),
  listenPort: z.number().int().optional(),
  mtu: z.number().int().optional(),
  keepalive: z.number().int().optional(),
  interfaceName: z.string().max(15).optional(),
  telemetryIntervalS: z.number().int().optional(),
  publicUrl: z.string().max(200).nullable().optional(),
  smtpHost: z.string().max(253).optional(),
  smtpPort: z.number().int().optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().max(200).optional(),
  smtpPassword: z.string().max(500).optional(),
  smtpFrom: z.string().max(200).optional(),
  alertTo: z.string().max(2000).optional(),
});

export const PUT = withAdmin(async (req, { admin }) => {
  const body = await parseBody(req, schema);
  const { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword, smtpFrom, alertTo, ...network } = body;
  const smtp = { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword, smtpFrom, alertTo };
  try {
    if (Object.values(network).some((v) => v !== undefined)) updateSettings(network, admin.email);
    if (Object.values(smtp).some((v) => v !== undefined)) updateSmtp(smtp, admin.email);
  } catch (e) {
    if (e instanceof AlertError) return json({ error: e.message }, 400);
    throw e;
  }
  return json(view());
});
