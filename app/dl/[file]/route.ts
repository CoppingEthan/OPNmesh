import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { json } from "@/server/http";

export const dynamic = "force-dynamic";

const ALLOWED = /^opnmesh-gw-linux-(amd64|arm64)(\.sha256)?$/;

/**
 * Public: agent binaries built into the image under public/dl (or agent/bin
 * in development). Only the exact expected names are served.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await ctx.params;
  if (!ALLOWED.test(file)) return json({ error: "not found" }, 404);
  for (const dir of [join(process.cwd(), "public", "dl"), join(process.cwd(), "agent", "bin")]) {
    const path = join(dir, file);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        headers: {
          "Content-Type": file.endsWith(".sha256") ? "text/plain" : "application/octet-stream",
          "Content-Length": String(st.size),
          "Cache-Control": "no-cache",
        },
      });
    } catch {
      /* try next */
    }
  }
  return json({ error: `${file} is not available on this controller — was the image built with the agent?` }, 404);
}
