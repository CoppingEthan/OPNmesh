import { InvitePickup } from "@/ui/invite-pickup";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your VPN configuration" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InvitePickup token={token} />;
}
