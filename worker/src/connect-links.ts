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
  const safeSub = subscriptionUrl.replace(/"/g, "&quot;");
  const label = clientLabel(client);
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FIX VPN · ${label}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0b1220; color: #e8eefc; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px; text-align: center; }
    .card { max-width: 420px; width: 100%; }
    .btn { display: block; width: 100%; box-sizing: border-box; margin: 10px 0; padding: 14px 18px; border-radius: 12px; border: 0; font-size: 17px; font-weight: 600; cursor: pointer; text-decoration: none; }
    .primary { background: #3d7eff; color: #fff; }
    .secondary { background: #1a2744; color: #e8eefc; }
    .hint { color: #9db0d0; font-size: 14px; line-height: 1.5; }
    code { display: block; word-break: break-all; background: #111a2e; padding: 12px; border-radius: 10px; margin-top: 12px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <p>Импорт подписки в <b>${label}</b></p>
    <p class="hint">На Android в Telegram нажмите кнопку ниже. Если приложение не открылось — скопируйте ссылку и вставьте в ${label} вручную.</p>
    <a class="btn primary" id="open-app" href="${safeDeep}">Открыть ${label}</a>
    <button class="btn secondary" id="copy-sub" type="button">Скопировать ссылку</button>
    <code id="sub-text">${safeSub}</code>
  </div>
  <script>
    (function () {
      var subUrl = ${JSON.stringify(subscriptionUrl)};
      var deepLink = ${JSON.stringify(deepLink)};
      var isAndroid = /Android/i.test(navigator.userAgent);
      var copyBtn = document.getElementById("copy-sub");
      var openBtn = document.getElementById("open-app");
      if (copyBtn) {
        copyBtn.addEventListener("click", function () {
          var done = function () { copyBtn.textContent = "Ссылка скопирована"; };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(subUrl).then(done).catch(function () {
              window.prompt("Скопируйте ссылку:", subUrl);
              done();
            });
          } else {
            window.prompt("Скопируйте ссылку:", subUrl);
            done();
          }
        });
      }
      if (!isAndroid && openBtn) {
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
