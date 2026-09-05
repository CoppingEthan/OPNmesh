import { json, withAdmin } from "@/server/http";
import { buildState } from "@/server/state";

export const dynamic = "force-dynamic";

export const GET = withAdmin(async () => json(buildState()));
