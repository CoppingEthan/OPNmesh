import Link from "next/link";
import { requireAdmin } from "@/server/session";
import { listEvents } from "@/server/events";
import { Badge, Card, PageHeader, Table, Td, Th, type Tone } from "@/ui/components";
import { dateTime } from "@/ui/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Events" };

const KIND_TONE: Record<string, Tone> = {
  "apply-error": "bad",
  gateway: "brand",
  enrol: "brand",
  login: "info",
  setup: "info",
  client: "info",
  invite: "info",
  site: "info",
  lan: "info",
  settings: "info",
  unifi: "info",
  system: "idle",
};

export default async function EventsPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  await requireAdmin();
  const { before } = await searchParams;
  const rows = listEvents(100, before ? Number(before) : undefined);
  const last = rows[rows.length - 1];
  return (
    <div>
      <PageHeader title="Events" description="Everything that changed and everything the gateways reported, newest first." />
      <Card padded={false}>
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>What</Th>
              <Th>Who</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <Td className="text-ink-3" colSpan={3}>
                  Nothing yet.
                </Td>
              </tr>
            )}
            {rows.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap text-xs text-ink-3">{dateTime(e.ts)}</Td>
                <Td>
                  <div className="flex items-start gap-2">
                    <Badge tone={KIND_TONE[e.kind] ?? "info"} className="mt-0.5 shrink-0">
                      {e.kind}
                    </Badge>
                    <span className="text-ink">
                      {e.subject && e.kind !== "login" ? <Link href={["site", "lan", "gateway", "enrol", "unifi", "apply-error"].includes(e.kind) ? `/sites/${e.subject}` : `/clients/${e.subject}`} className="hover:underline">{e.message}</Link> : e.message}
                    </span>
                  </div>
                </Td>
                <Td className="text-xs text-ink-2">{e.actor}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {rows.length === 100 && last && (
          <div className="border-t border-line px-5 py-3 text-sm">
            <Link href={`/events?before=${last.id}`} className="text-brand-ink hover:underline">
              Older events
            </Link>
          </div>
        )}
      </Card>
    </div>
  );
}
