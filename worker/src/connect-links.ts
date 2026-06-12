import type { BotEnv } from "./env";

export type VpnClientId = "happ" | "v2rayng" | "hiddify" | "shadowrocket";

export const DEFAULT_CLIENT_BY_OS: Record<string, VpnClientId> = {
  android: "happ",
  ios: "happ",
  windows: "happ",
  macos: "happ",
};

const CLIENT_LABELS: Record<VpnClientId, string> = {
  happ: "Happ",
  v2rayng: "V2rayNG",
  hiddify: "Hiddify",
  shadowrocket: "Shadowrocket",
};

const CLIENTS_BY_OS: Record<string, VpnClientId[]> = {
  android: ["happ", "v2rayng", "hiddify"],
  ios: ["happ", "shadowrocket", "hiddify"],
  windows: ["happ", "hiddify"],
  macos: ["happ", "hiddify"],
};

export function workerBaseUrl(env: BotEnv): string {
  return (env.WEBAPP_URL || "").replace(/\/$/, "");
}

export function buildDeepLink(client: VpnClientId, subscriptionUrl: string): string {
  const encoded = encodeURIComponent(subscriptionUrl);
  switch (client) {
    case "happ":
      return `happ://add/${subscriptionUrl}`;
    case "v2rayng":
      return `v2rayng://install-sub?url=${encoded}`;
    case "hiddify":
      return `hiddify://install-sub?url=${encoded}`;
    case "shadowrocket":
      return `shadowrocket://add/sub?url=${encoded}`;
    default:
      return `happ://add/${subscriptionUrl}`;
  }
}

export function buildRedirectUrl(
  env: BotEnv,
  client: VpnClientId,
  subscriptionUrl: string
): string {
  const base = workerBaseUrl(env);
  if (!base) throw new Error("WEBAPP_URL missing");
  return `${base}/api/redirect/${client}?sub=${encodeURIComponent(subscriptionUrl)}`;
}

export function clientLabel(client: VpnClientId): string {
  return CLIENT_LABELS[client];
}

export function clientsForOs(os: string): VpnClientId[] {
  return CLIENTS_BY_OS[os] || CLIENTS_BY_OS.android;
}

export function defaultClientForOs(os: string): VpnClientId {
  return DEFAULT_CLIENT_BY_OS[os] || "happ";
}

export function redirectHtml(client: VpnClientId, subscriptionUrl: string): string {
  const deepLink = buildDeepLink(client, subscriptionUrl);
  const safeDeep = deepLink.replace(/"/g, "&quot;");
  const label = clientLabel(client);
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0;url=${safeDeep}" />
  <title>FIX VPN · ${label}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0b1220; color: #e8eefc; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; text-align: center; }
    a { color: #6ea8ff; font-size: 18px; }
  </style>
</head>
<body>
  <div>
    <p>Открываем <b>${label}</b>…</p>
    <p><a href="${safeDeep}">Нажмите здесь, если приложение не открылось</a></p>
  </div>
  <script>location.replace(${JSON.stringify(deepLink)});</script>
</body>
</html>`;
}
