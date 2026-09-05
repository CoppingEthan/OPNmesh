import { env } from "@/server/env";
import { errorResponse, text } from "@/server/http";
import { installScript } from "@/server/install-script";

export const dynamic = "force-dynamic";

/** Public: the gateway installer with this controller's URL baked in. */
export async function GET(): Promise<Response> {
  try {
    return text(installScript(env().publicUrl), 200, { "Content-Type": "text/x-shellscript; charset=utf-8" });
  } catch (e) {
    return errorResponse(e);
  }
}
