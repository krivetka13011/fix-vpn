import type { BotEnv } from "./env";
import {
  resolveVpnHost,
  subscriptionBaseUrl,
  subscriptionClientBaseUrl,
  subscriptionPublicHost,
  webappPublicUrl,
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
const PANEL_EGRESS_IP = "31.76.2.248";

export function workerBaseUrl(env: BotEnv): string {
  return webappPublicUrl(env);
}

export function isHappEncryptedLink(link: string): boolean {
  return /^happ:\/\/crypt[45]\//i.test(link.trim());
}

export function buildPanelSubscriptionUrl(env: BotEnv, subId: string): string {
  const base = subscriptionBaseUrl(env);
  const path = (env.SUBSCRIPTION_PATH || "/sub").replace(/\/$/, "");
  return `${base}${path}/${subId}`;
}

/** Публичный URL подписки — Worker custom domain sub.fixvp.xyz (HTTPS :443). */
export function buildClientSubscriptionUrl(env: BotEnv, subId: string): string {
  const trimmed = subId.trim();
  const path = (env.SUBSCRIPTION_PATH || "/sub").replace(/\/$/, "");
  const base = subscriptionClientBaseUrl(env);
  if (base) {
    return `${base.replace(/\/$/, "")}${path}/${trimmed}`;
  }
  const host = subscriptionPublicHost(env);
  return `https://${host}${path}/${trimmed}`;
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

  const path = (env.SUBSCRIPTION_PATH || "/sub").replace(/\/$/, "");
  const encoded = encodeURIComponent(subId);
  const egressHost = subscriptionEgressHost(env);
  const bases = [
    workerSubscriptionFetchBase(env),
    subscriptionClientBaseUrl(env),
    subscriptionBaseUrl(env),
    `https://${PANEL_EGRESS_IP}:2096`,
  ].filter((base, index, list) => base && list.indexOf(base) === index);

  for (const base of bases) {
    try {
      const response = await panelFetch(env, `${base}${path}/${encoded}`);
      const raw = await response.text();
      if (!response.ok || isPanelErrorBody(raw, response.status)) continue;
      if (!subscriptionBodyLooksValid(raw)) continue;
      let body = normalizeSubscriptionBody(raw);
      if (!subscriptionBodyLooksValid(body)) continue;
      body = rewriteSubscriptionEgressHost(body, egressHost);
      body = filterUnreachableSubscriptionLines(body);
      body = sanitizeSubscriptionLineRemarks(body);
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

  try {
    const xui = new XuiApi(env);
    const links = await xui.getClientSubLinks(subId);
    if (links.length > 0) {
      let body = links.join("\n");
      if (subscriptionBodyLooksValid(body) && PLAIN_PROTOCOL_RE.test(body)) {
        body = rewriteSubscriptionEgressHost(body, egressHost);
        body = filterUnreachableSubscriptionLines(body);
        body = sanitizeSubscriptionLineRemarks(body);
        return { body, headers: {} };
      }
    }
  } catch (error) {
    console.error("fetchPanelSubscriptionBody subLinks:", error);
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

const DEAD_OUTBOUND_PORTS = new Set([53120]);

export function subscriptionEgressHost(env: BotEnv): string {
  return env.VPN_SUBSCRIPTION_HOST?.trim() || PANEL_EGRESS_IP;
}

export function rewriteSubscriptionEgressHost(body: string, host: string): string {
  if (!host) return body;
  return body.replace(/@fixvp\.xyz:/g, `@${host}:`);
}

export function filterUnreachableSubscriptionLines(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      for (const port of DEAD_OUTBOUND_PORTS) {
        if (new RegExp(`:${port}([/?#]|$)`).test(trimmed)) return false;
      }
      return true;
    })
    .join("\n");
}

/** Strip panel test markers (⛔️ N/A-) from Happ server names in URL fragments. */
export function sanitizeSubscriptionLineRemarks(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !PLAIN_PROTOCOL_RE.test(trimmed)) {
        return line;
      }
      const hash = trimmed.indexOf("#");
      if (hash < 0) return line;

      const prefix = trimmed.slice(0, hash + 1);
      let fragment = trimmed.slice(hash + 1);
      try {
        fragment = decodeURIComponent(fragment);
      } catch {
        // keep encoded fragment
      }

      const cleaned = fragment
        .replace(/^[\u26D4\uFE0F\u200D\s]+/u, "")
        .replace(/^N\/A\s*[-–—]?\s*/i, "")
        .replace(/^\s+/, "")
        .trim();
      if (!cleaned) return trimmed.slice(0, hash);

      return `${prefix}${encodeURIComponent(cleaned)}`;
    })
    .join("\n");
}

type JsonRecord = Record<string, unknown>;

function fixJsonInboundForHapp(inbounds: JsonRecord[]): JsonRecord[] {
  const mixed = inbounds.find((row) => row.protocol === "mixed");
  const http = inbounds.find((row) => row.protocol === "http");
  const sniffing = mixed?.sniffing;
  const socks: JsonRecord = {
    listen: "127.0.0.1",
    port: 10808,
    protocol: "socks",
    settings: { auth: "noauth", udp: true, userLevel: 8 },
    tag: "socks",
  };
  if (sniffing) socks.sniffing = sniffing;
  const next: JsonRecord[] = [socks];
  if (http) {
    next.push({
      ...http,
      listen: "127.0.0.1",
      port: http.port ?? 10809,
    });
  }
  return next;
}

function jsonProxyPort(item: JsonRecord): number | null {
  const outbounds = item.outbounds;
  if (!Array.isArray(outbounds)) return null;
  const proxy = outbounds.find((row) => (row as JsonRecord).tag === "proxy") as
    | JsonRecord
    | undefined;
  if (!proxy) return null;
  const settings = proxy.settings as JsonRecord | undefined;
  const directPort = Number(settings?.port);
  if (Number.isFinite(directPort)) return directPort;
  const servers = settings?.servers;
  if (!Array.isArray(servers) || servers.length === 0) return null;
  const port = Number((servers[0] as JsonRecord).port);
  return Number.isFinite(port) ? port : null;
}

function rewriteJsonHostInAddress(address: string, host: string): string {
  if (!host || !address) return address;
  return address.replace(/fixvp\.xyz/gi, host);
}

function rewriteJsonOutboundAddresses(item: JsonRecord, host: string): JsonRecord {
  const outbounds = item.outbounds;
  if (!Array.isArray(outbounds) || !host) return item;

  const nextOutbounds = outbounds.map((raw) => {
    const outbound = raw as JsonRecord;
    if (outbound.tag !== "proxy") return outbound;
    const settings = outbound.settings as JsonRecord | undefined;
    if (!settings) return outbound;

    const patched: JsonRecord = { ...settings };
    if (typeof patched.address === "string") {
      patched.address = rewriteJsonHostInAddress(patched.address, host);
    }
    const servers = patched.servers;
    if (Array.isArray(servers)) {
      patched.servers = servers.map((row) => {
        const server = row as JsonRecord;
        if (typeof server.address !== "string") return server;
        return {
          ...server,
          address: rewriteJsonHostInAddress(server.address, host),
        };
      });
    }
    return { ...outbound, settings: patched };
  });

  return { ...item, outbounds: nextOutbounds };
}

export function normalizeJsonSubscriptionForHapp(
  items: unknown[],
  host = PANEL_EGRESS_IP
): string {
  const fixed: JsonRecord[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as JsonRecord;
    const port = jsonProxyPort(item);
    if (port && DEAD_OUTBOUND_PORTS.has(port)) continue;
    const inbounds = Array.isArray(item.inbounds)
      ? (item.inbounds as JsonRecord[])
      : [];
    fixed.push(
      rewriteJsonOutboundAddresses(
        {
          ...item,
          inbounds: fixJsonInboundForHapp(inbounds),
        },
        host
      )
    );
  }
  return JSON.stringify(fixed);
}

export async function fetchPanelJsonSubscription(
  env: BotEnv,
  subId: string
): Promise<string | null> {
  if (!subId.trim()) return null;
  const encoded = encodeURIComponent(subId);
  const bases = [
    workerSubscriptionFetchBase(env),
    subscriptionClientBaseUrl(env),
    subscriptionBaseUrl(env),
    `https://${PANEL_EGRESS_IP}:2096`,
  ].filter((base, index, list) => base && list.indexOf(base) === index);

  for (const base of bases) {
    try {
      const response = await panelFetch(env, `${base}/json/${encoded}`);
      if (!response.ok) continue;
      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload) || payload.length === 0) continue;
      return normalizeJsonSubscriptionForHapp(payload, subscriptionEgressHost(env));
    } catch {
      // try next base
    }
  }
  return null;
}

export function buildProtectedJsonSubscriptionUrl(env: BotEnv, subId: string): string {
  const base = workerBaseUrl(env);
  if (!base) throw new Error("WEBAPP_URL missing");
  return `${base}/json/${encodeURIComponent(subId)}`;
}

export function buildProtectedSubscriptionUrl(env: BotEnv, subId: string): string {
  const base = workerBaseUrl(env);
  if (!base) throw new Error("WEBAPP_URL missing");
  return `${base}/sub/${encodeURIComponent(subId)}`;
}

/** Standard 3X-UI /sub format: base64 blob with #hide-settings lock. */
export function encodeStandardSubscriptionBody(body: string): string {
  let plain = subscriptionBodyForClients(body);
  if (!/^#hide-settings\s*:\s*1\b/im.test(plain)) {
    plain = `#hide-settings: 1\n${plain}`;
  }
  const bytes = new TextEncoder().encode(plain);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function decodeStandardSubscriptionBody(encoded: string): string {
  const trimmed = encoded.trim();
  if (PLAIN_PROTOCOL_RE.test(trimmed)) return trimmed;
  try {
    const binary = atob(trimmed.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return trimmed;
  }
}

export function applyLockedSubscriptionBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^#hide-settings\s*:\s*1\s*\n?/im, "");
}

/** Subscription body for VPN clients with locked settings in Happ. */
export function subscriptionBodyForClients(body: string): string {
  const normalized = dedupeSubscriptionLines(
    sanitizeSubscriptionLineRemarks(body.trim())
  );
  return normalized;
}

export const LOCKED_SUBSCRIPTION_HEADERS: Record<string, string> = {
  "hide-settings": "1",
  "Profile-Update-Interval": "1",
  "Profile-Title": "base64:8J+Up0ZJWCBWUE4=",
};

/** Headers for /sub — hide-settings locks editing in Happ. */
export const SUBSCRIPTION_RESPONSE_HEADERS: Record<string, string> = {
  "hide-settings": "1",
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
      const response = await fetch(`${worker}/sub/${encodeURIComponent(subId)}`);
      const body = decodeStandardSubscriptionBody(await response.text());
      if (response.ok && PLAIN_PROTOCOL_RE.test(body)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

/** Happ скачивает подписку с прямого URL панели 3X-UI /sub/, не с HTML-редиректа Worker. */
export function buildHappSubscriptionUrl(env: BotEnv, subId: string): string {
  return buildClientSubscriptionUrl(env, subId);
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
  return buildHappSubscriptionUrl(env, subId);
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
    const trimmed = importTarget.trim();
    if (isHappEncryptedLink(trimmed) || /^happ:\/\//i.test(trimmed)) return trimmed;
    if (/\/api\/redirect\//i.test(trimmed) || /\/redirect\//i.test(trimmed)) {
      throw new Error("Happ import must use direct panel /sub/ URL, not redirect HTML");
    }
    // 3X-UI / Happ Windows: happ://add/ + прямой URL без encodeURIComponent (как в панели).
    return `happ://add/${trimmed}`;
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
  const safeSub = importTarget.replace(/"/g, "&quot;");
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
    .btn-secondary { background: #243352; color: #e8eefc; }
    .hint { color: #9db0d0; font-size: 14px; line-height: 1.5; }
    .sub-url { word-break: break-all; font-size: 12px; color: #7f93b8; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <p>Импорт подписки в <b>${label}</b></p>
    <p class="hint">Подписка скачивается с панели 3X-UI (base64). Если кнопка не сработала — скопируйте ссылку и вставьте в Happ вручную.</p>
    <a class="btn" id="open-app" href="${safeDeep}">Открыть ${label}</a>
    <button class="btn btn-secondary" id="copy-sub" type="button">Скопировать ссылку подписки</button>
    <p class="sub-url" id="sub-url">${safeSub}</p>
  </div>
  <script>
    (function () {
      var deepLink = ${JSON.stringify(deepLink)};
      var subUrl = ${JSON.stringify(importTarget)};
      var isAndroid = /Android/i.test(navigator.userAgent);
      if (isAndroid) {
        setTimeout(function () { window.location.replace(deepLink); }, 120);
      }
      var copyBtn = document.getElementById("copy-sub");
      if (copyBtn) {
        copyBtn.addEventListener("click", function () {
          var done = function () { copyBtn.textContent = "Скопировано"; };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(subUrl).then(done).catch(function () {
              window.prompt("Скопируйте ссылку подписки:", subUrl);
            });
          } else {
            window.prompt("Скопируйте ссылку подписки:", subUrl);
          }
        });
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
