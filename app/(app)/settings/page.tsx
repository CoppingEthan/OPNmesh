import { requireAdmin } from "@/server/session";
import { getSettings } from "@/server/settings";
import { env } from "@/server/env";
import { smtpView } from "@/server/alerts";
import { SettingsForms } from "@/ui/settings-forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const admin = await requireAdmin();
  const s = getSettings();
  return (
    <SettingsForms
      admin={{ email: admin.email }}
      settings={{
        networkName: s.networkName,
        gatewayCidr: s.gatewayCidr,
        clientCidr: s.clientCidr,
        listenPort: s.listenPort,
        mtu: s.mtu,
        keepalive: s.keepalive,
        interfaceName: s.interfaceName,
        telemetryIntervalS: s.telemetryIntervalS,
        publicUrl: s.publicUrl,
        configVersion: s.configVersion,
      }}
      env={{ publicUrl: env().publicUrl, dataDir: env().dataDir, insecureHttp: env().insecureHttp }}
      smtp={smtpView()}
    />
  );
}
