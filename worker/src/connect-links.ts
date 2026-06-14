import type { BotEnv } from "./env";
import {
  resolveVpnHost,
  subscriptionBaseUrl,
  subscriptionClientBaseUrl,
  workerSubscriptionFetchBase,
} from "./env";
import { isPanelErrorBody, panelFetch } from "./panel-fetch";
import { XuiApi } from "./xui";

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

export function buildClientSubscriptionUrl(env: BotEnv, subId: string): string {
  const base = subscriptionClientBaseUrl(env);
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

const PLAIN_PROTOCOL_RE =
  /^(vless|vmess|trojan|ss|hysteria2|tuic):\/\//i;

/** Decode 3X-UI base64 subscription blob into plain protocol lines for VPN clients. */
export function normalizeSubscriptionBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (PLAIN_PROTOCOL_RE.test(trimmed)) {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => PLAIN_PROTOCOL_RE.test(line))
      .join("\n");
  }

  const decodedLines: string[] = [];
  const inputLines = trimmed.split(/\r?\n/).filter(Boolean);

  for (const line of inputLines) {
    if (PLAIN_PROTOCOL_RE.test(line)) {
      decodedLines.push(line.trim());
      continue;
    }
    try {
      const binary = atob(line.replace(/\s/g, ""));
      const text = binary.trim();
      if (PLAIN_PROTOCOL_RE.test(text)) {
        decodedLines.push(
          ...text
            .split(/\r?\n/)
            .map((row) => row.trim())
            .filter((row) => PLAIN_PROTOCOL_RE.test(row))
        );
      }
    } catch {
      // not base64 — skip line
    }
  }

  if (decodedLines.length > 0) {
    return dedupeSubscriptionLines(decodedLines.join("\n"));
  }

  try {
    const binary = atob(trimmed.replace(/\s/g, ""));
    const text = binary.trim();
    if (PLAIN_PROTOCOL_RE.test(text)) {
      return dedupeSubscriptionLines(
        text
          .split(/\r?\n/)
          .map((row) => row.trim())
          .filter((row) => PLAIN_PROTOCOL_RE.test(row))
          .join("\n")
      );
    }
  } catch {
    // keep raw below
  }

  return trimmed;
}

/** Remove duplicate protocol lines (same URL imported twice → N/D in Happ). */
export function dedupeSubscriptionLines(body: string): string {
  const lines = body.split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      out.push(line);
      continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.join("\n");
}

export async function fetchPanelSubscriptionBody(
  env: BotEnv,
  subId: string
): Promise<{ body: string; headers: Record<string, string> } | null> {
  if (!subId.trim()) return null;

  try {
    const xui = new XuiApi(env);
    const links = await xui.getClientSubLinks(subId);
    if (links.length > 0) {
      const body = links.join("\n");
      if (subscriptionBodyLooksValid(body) && PLAIN_PROTOCOL_RE.test(body)) {
        return { body, headers: {} };
      }
    }
  } catch (error) {
    console.error("fetchPanelSubscriptionBody subLinks:", error);
  }

  const path = (env.SUBSCRIPTION_PATH || "/sub").replace(/\/$/, "");
  const encoded = encodeURIComponent(subId);
  const bases = [
    workerSubscriptionFetchBase(env),
    subscriptionClientBaseUrl(env),
    subscriptionBaseUrl(env),
    `https://${resolveVpnHost(env)}:2096`,
  ].filter((base, index, list) => base && list.indexOf(base) === index);

  for (const base of bases) {
    try {
      const response = await panelFetch(env, `${base}${path}/${encoded}`);
      const raw = await response.text();
      if (!response.ok || isPanelErrorBody(raw, response.status)) continue;
      if (!subscriptionBodyLooksValid(raw)) continue;
      const body = normalizeSubscriptionBody(raw);
      if (!subscriptionBodyLooksValid(body)) continue;
      const headers: Record<string, string> = {};
      for (const name of [
        "Profile-Title",
        "Subscription-Userinfo",
        "Profile-Web-Page-Url",
        "Support-Url",
        "Announce",
      ]) {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
      }
      return { body, headers };
    } catch {
      // try next base
    }
  }
  return null;
}

export async function verifyPanelSubscription(
  env: BotEnv,
  subId: string
): Promise<boolean> {
  if (!subId.trim()) return false;
  const path = (env.SUBSCRIPTION_PATH || "/sub").replace(/\/$/, "");
  const encoded = encodeURIComponent(subId);
  const bases = [
    subscriptionClientBaseUrl(env),
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

export function applyLockedSubscriptionBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^#hide-settings\s*:\s*1\s*\n?/im, "");
}

/** Subscription body for VPN clients — без #hide-settings (ломает пинг в Happ). */
export function subscriptionBodyForClients(body: string): string {
  const normalized = dedupeSubscriptionLines(applyLockedSubscriptionBody(body).trim());
  return normalized;
}

export const LOCKED_SUBSCRIPTION_HEADERS: Record<string, string> = {
  "hide-settings": "1",
  "Profile-Update-Interval": "1",
  "Profile-Title": "base64:8J+Up0ZJWCBWUE4=",
};

/** Headers for /api/sub — без hide-settings (ломает refresh в Happ на Windows). */
export const SUBSCRIPTION_RESPONSE_HEADERS: Record<string, string> = {
  "Profile-Update-Interval": "1",
  "Profile-Title": "base64:8J+Up0ZJWCBWUE4=",
};

export function subscriptionUserinfoHeader(
  endsAt: string | null | undefined
): string | null {
  if (!endsAt) return null;
  const end = new Date(`${endsAt}T23:59:59`);
  if (Number.isNaN(end.getTime())) return null;
  const expire = Math.floor(end.getTime() / 1000);
  return `upload=0; download=0; total=0; expire=${expire}`;
}

export async function panelSubscriptionIsLive(
  env: BotEnv,
  subId: string
): Promise<boolean> {
  if (!subId.trim()) return false;
  const live = await fetchPanelSubscriptionBody(env, subId);
  if (live?.body && subscriptionBodyLooksValid(live.body)) {
    return PLAIN_PROTOCOL_RE.test(live.body);
  }
  const worker = workerBaseUrl(env);
  if (worker) {
    try {
      const response = await fetch(`${worker}/api/sub/${encodeURIComponent(subId)}`);
      const body = await response.text();
      if (response.ok && PLAIN_PROTOCOL_RE.test(body)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

/** Happ fetches Worker proxy — returns plain vless lines, not panel base64. */
export function buildHappSubscriptionUrl(env: BotEnv, subId: string): string {
  return buildProtectedSubscriptionUrl(env, subId);
}

export function buildPanelSubscriptionUrlForUser(env: BotEnv, subId: string): string {
  return buildProtectedSubscriptionUrl(env, subId);
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

export async function buildHappImportTarget(
  env: BotEnv,
  subId: string
): Promise<string> {
  const url = buildHappSubscriptionUrl(env, subId);
  try {
    return await encryptHappLink(url);
  } catch (error) {
    console.error("encryptHappLink fallback:", error);
    return `happ://add/${encodeURIComponent(url)}`;
  }
}

export async function buildClientImportTarget(
  env: BotEnv,
  client: VpnClientId,
  subId: string
): Promise<string> {
  if (client === "happ") {
    const alive = await panelSubscriptionIsLive(env, subId);
    if (!alive) {
      console.error("panelSubscriptionIsLive false for", subId);
    }
    return buildHappImportTarget(env, subId);
  }
  return buildProtectedSubscriptionUrl(env, subId);
}

export function buildRedirectUrl(
  env: BotEnv,
  client: VpnClientId,
  subId: string
): string {
  const base = workerBaseUrl(env);
  if (!base) throw new Error("WEBAPP_URL missing");
  return `${base}/api/redirect/${client}?sid=${encodeURIComponent(subId)}`;
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
