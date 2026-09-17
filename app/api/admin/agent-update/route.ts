import { APP_VERSION } from "@/server/env";
import { json, withAdmin } from "@/server/http";
import { gatewayCommand } from "@/server/install-script";

export const dynamic = "force-dynamic";

/**
 * The agent version this controller ships, and the command that updates an
 * enrolled gateway to it in place (no token; the gateway keeps its identity).
 */
export const GET = withAdmin(async () => json({ controllerVersion: APP_VERSION, ...gatewayCommand({ upgrade: true }) }));
