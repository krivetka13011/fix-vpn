import type { BotEnv } from "./env";
import { subscriptionBaseUrl, workerSubscriptionFetchBase } from "./env";

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

const HAPP_CRYPTO_API = "https://crypto.happ.su/api-v2.php";

export function workerBaseUrl(env: BotEnv): string {
  return (env.WEBAPP_URL || "").replace(/\/$/, "");
}

export function isHappEncryptedLink(link: string): boolean {
  return /^happ:\/\/crypt[45]\//i.test(link.trim());
}

export function buildPanelSubscriptionUrl(env: BotEnv, subId: string): string {
  const base = subscriptionBaseUrl(env);
  const path = (env.SUBSCRIPTION_PATH || "/sub").replace(/\/$/, "");
  return `${base}${path}/${subId}`;
}

function subscriptionBodyLooksValid(body: string): boolean {
  const trimmed = body.trim();
  return (
    trimmed.length > 200 &&
    !trimmed.includes("error code:") &&
    !trimmed.startsWith("<!DOCTYPE")
  );
}

export async function verifyPanelSubscription(
  env: BotEnv,
  subId: string
): Promise<boolean> {
  if (!subId.trim()) return false;
  const path = (env.SUBSCRIPTION_PATH || "/sub").replace(/\/$/, "");
  const encoded = encodeURIComponent(subId);
  const bases = [
    workerSubscriptionFetchBase(env),
    subscriptionBaseUrl(env),
  ].filter((base, index, list) => base && list.indexOf(base) === index);

  for (const base of bases) {
    try {
      const response = await fetch(`${base}${path}/${encoded}`);
      const body = await response.text();
      if (response.ok && subscriptionBodyLooksValid(body)) return true;
    } catch {
      // Worker-side verify is best-effort only
    }
  }
  return false;
}

export function buildProtectedSubscriptionUrl(env: BotEnv, subId: string): string {
  const base = workerBaseUrl(env);
  if (!base) throw new Error("WEBAPP_URL missing");
  const path = (env.SUBSCRIPTION_PATH || "/sub").replace(/\/$/, "");
  return `${base}/api/sub/${encodeURIComponent(subId)}`;
}

export async function encryptHappLink(subscriptionUrl: string): Promise<string> {
  const response = await fetch(HAPP_CRYPTO_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: subscriptionUrl }),
  });
  const payload = (await response.json()) as {
    encrypted_link?: string;
    error?: string;
    message?: string;
  };
  const encrypted = payload.encrypted_link?.trim();
  if (!response.ok || !encrypted) {
    throw new Error(payload.error || payload.message || "Happ encrypt failed");
  }
  return encrypted;
}

export async function buildClientImportTarget(
  env: BotEnv,
  client: VpnClientId,
  subId: string
): Promise<string> {
  const panelUrl = buildPanelSubscriptionUrl(env, subId);
  if (client === "happ") {
    return encryptHappLink(panelUrl);
  }
  return panelUrl;
}

export function buildDeepLink(client: VpnClientId, importTarget: string): string {
  if (client === "happ") {
    if (isHappEncryptedLink(importTarget)) return importTarget;
    return `happ://add/${importTarget}`;
  }
  const encoded = encodeURIComponent(importTarget);
  switch (client) {
    case "v2rayng":
      return `v2rayng://install-sub?url=${encoded}`;
    case "hiddify":
      return `hiddify://install-sub?url=${encoded}`;
    case "shadowrocket":
      return `shadowrocket://add/sub?url=${encoded}`;
    default:
      return `happ://add/${importTarget}`;
  }
}

export function buildRedirectUrl(
  env: BotEnv,
  client: VpnClientId,
  importTarget: string
): string {
  const base = workerBaseUrl(env);
  if (!base) throw new Error("WEBAPP_URL missing");
  return `${base}/api/redirect/${client}?sub=${encodeURIComponent(importTarget)}`;
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

export function redirectHtml(client: VpnClientId, importTarget: string): string {
  const deepLink = buildDeepLink(client, importTarget);
  const safeDeep = deepLink.replace(/"/g, "&quot;");
  const label = clientLabel(client);
  const locked = client === "happ" || isHappEncryptedLink(importTarget);

  if (locked) {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FIX VPN · ${label}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0b1220; color: #e8eefc; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; text-align: center; }
    .card { max-width: 420px; width: 100%; }
    .btn { display: block; width: 100%; box-sizing: border-box; margin: 10px 0; padding: 14px 18px; border-radius: 12px; border: 0; font-size: 17px; font-weight: 600; cursor: pointer; text-decoration: none; background: #3d7eff; color: #fff; }
    .hint { color: #9db0d0; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <p>Импорт подписки в <b>${label}</b></p>
    <p class="hint">Подписка защищена: ссылку и настройки серверов нельзя просмотреть или изменить после импорта.</p>
    <a class="btn" id="open-app" href="${safeDeep}">Открыть ${label}</a>
  </div>
  <script>
    (function () {
      var deepLink = ${JSON.stringify(deepLink)};
      var isAndroid = /Android/i.test(navigator.userAgent);
      if (!isAndroid) {
        setTimeout(function () { window.location.replace(deepLink); }, 120);
      }
    })();
  </script>
</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FIX VPN · ${label}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0b1220; color: #e8eefc; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; text-align: center; }
    .card { max-width: 420px; width: 100%; }
    .btn { display: block; width: 100%; box-sizing: border-box; margin: 10px 0; padding: 14px 18px; border-radius: 12px; border: 0; font-size: 17px; font-weight: 600; cursor: pointer; text-decoration: none; background: #3d7eff; color: #fff; }
    .hint { color: #9db0d0; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <p>Импорт подписки в <b>${label}</b></p>
    <p class="hint">Нажмите кнопку ниже, чтобы открыть ${label}. Настройки серверов защищены от случайного редактирования.</p>
    <a class="btn" id="open-app" href="${safeDeep}">Открыть ${label}</a>
  </div>
  <script>
    (function () {
      var deepLink = ${JSON.stringify(deepLink)};
      var isAndroid = /Android/i.test(navigator.userAgent);
      if (!isAndroid) {
        setTimeout(function () { window.location.replace(deepLink); }, 120);
      }
    })();
  </script>
</body>
</html>`;
}

export async function subscriptionIsReady(subscriptionUrl: string): Promise<boolean> {
  if (!subscriptionUrl.trim()) return false;
  try {
    const response = await fetch(subscriptionUrl);
    const body = await response.text();
    return response.ok && body.trim().length > 200;
  } catch {
    return false;
  }
}
