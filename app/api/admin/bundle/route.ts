import { json, withAdmin } from "@/server/http";
import { getGenerated } from "@/server/snapshot";

export const dynamic = "force-dynamic";

/** Exactly what every gateway and client receives (client private keys are placeholders here). */
export const GET = withAdmin(async () => {
  const gen = getGenerated();
  return json({ version: gen.version, hash: gen.bundle.hash, gateways: gen.bundle.gateways, clients: gen.bundle.clients, routers: gen.bundle.routers, findings: gen.findings });
});
