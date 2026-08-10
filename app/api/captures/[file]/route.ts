/**
 * Authenticated pcap download proxy.
 *
 * Captures contain raw traffic, so they are never fetched directly from the
 * control server by the browser (that would need the admin credential in the
 * page). The UI streams them through this route, which is behind the same
 * session gate as every other page.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/ui/auth.js";
import { controlFetch } from "../../../../lib/ui/control.js";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  await requireAdmin();
  const { file } = await ctx.params;
  if (!/^cap-[a-z0-9]{1,32}\.pcap$/.test(file)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const upstream = await controlFetch(`/api/v1/admin/captures/${file}`);
  if (!upstream.ok) {
    return NextResponse.json({ error: "not found" }, { status: upstream.status });
  }
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type": "application/vnd.tcpdump.pcap",
      "content-disposition": `attachment; filename="${file}"`,
      "cache-control": "no-store",
    },
  });
}
