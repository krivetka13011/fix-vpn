import {
  TARIFFS,
  BILLING_MONTHS,
  EXTRA_DEVICE_PRICE_PER_MONTH,
  SUPPORT_TELEGRAM_USERNAME,
  TELEGRAM_CHANNEL_URL,
  calcTotalRub,
  type BillingMonths,
  type PlanType,
} from "./catalog";
import {
  bundleToApiUser,
  ensureUser,
  getBundle,
  purchaseExtraDevices,
  purchaseSubscription,
} from "./db";
import { sbRequest } from "./supabase";
import { validateInitData, type TelegramUser } from "./telegram";
import type { BotEnv } from "./env";
import { clientBotToken, partnerBotToken, subscriptionBaseUrl, subscriptionClientBaseUrl, workerSubscriptionFetchBase, xuiBaseUrl } from "./env";
import { isPanelErrorBody, panelFetch } from "./panel-fetch";
import { handleClientBotUpdate } from "./bots/client-bot";
import { handlePartnerBotUpdate } from "./bots/partner-bot";
import { XuiApi } from "./xui";
import { getSubscriptionBySubId } from "./repository";
import {
  buildMiniappConnectUrl,
  canConnectSubscription,
  fetchMiniappDevices,
  resetMiniappDevices,
  resolvePanelSubIdForUser,
  subscriptionPeriodText,
  type MiniappClient,
  type MiniappPlatform,
} from "./miniapp-services";
import {
  buildClientImportTarget,
  fetchPanelSubscriptionBody,
  LOCKED_SUBSCRIPTION_HEADERS,
  normalizeSubscriptionBody,
  redirectHtml,
  subscriptionUserinfoHeader,
  type VpnClientId,
} from "./connect-links";

export interface ApiEnv extends BotEnv {
  TELEGRAM_BOT_TOKEN?: string;
  WEBAPP_URL?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function getAuthUser(
  request: Request,
  env: ApiEnv
): Promise<TelegramUser | null> {
  const initData =
    request.headers.get("X-Telegram-Init-Data") ??
    new URL(request.url).searchParams.get("initData") ??
    "";

  const token = clientBotToken(env);
  if (!initData || !token) return null;

  try {
    const parsed = await validateInitData(initData, token);
    return parsed?.user ?? null;
  } catch {
    return null;
  }
}

async function handleLegacyTelegramWebhook(
  request: Request,
  env: ApiEnv
): Promise<Response> {
  try {
    const update = await request.json();
    await handleClientBotUpdate(env, update);
  } catch (error) {
    console.error("client webhook:", error);
  }
  return new Response("ok");
}

export async function handleApiRequest(
  request: Request,
  env: ApiEnv,
  path: string
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (path.startsWith("/api/sub/") && request.method === "GET") {
    const subId = decodeURIComponent(path.slice("/api/sub/".length))
      .replace(/\/$/, "")
      .trim();
    if (!subId || subId.includes("/")) {
      return new Response("bad sub", { status: 400, headers: CORS });
    }

    const lockedHeaders: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...LOCKED_SUBSCRIPTION_HEADERS,
      ...CORS,
    };

    let dbSub: Awaited<ReturnType<typeof getSubscriptionBySubId>> = null;
    try {
      dbSub = await getSubscriptionBySubId(env, subId);
    } catch (error) {
      console.error("subscription db lookup:", error);
    }

    const live = await fetchPanelSubscriptionBody(env, subId);
    if (live?.body) {
      const headers: Record<string, string> = { ...lockedHeaders, ...live.headers };
      const userinfo = subscriptionUserinfoHeader(dbSub?.ends_at ?? null);
      if (userinfo) headers["Subscription-Userinfo"] = userinfo;
      return new Response(live.body, { status: 200, headers });
    }

    let allowCache = true;
    try {
      const links = await new XuiApi(env).getClientSubLinks(subId);
      if (links.length === 0) {
        allowCache = false;
      }
    } catch (error) {
      console.error("subscription subLinks probe:", error);
    }

    if (allowCache) {
      try {
        const cached = dbSub?.subscription_payload_cache?.trim();
        if (cached && cached.length > 100) {
          const body = normalizeSubscriptionBody(cached);
          const headers: Record<string, string> = { ...lockedHeaders };
          const userinfo = subscriptionUserinfoHeader(dbSub?.ends_at ?? null);
          if (userinfo) headers["Subscription-Userinfo"] = userinfo;
          return new Response(body, { status: 200, headers });
        }
      } catch (error) {
        console.error("subscription cache:", error);
      }
    }

    const subPath = (env.SUBSCRIPTION_PATH || "/sub").replace(/\/$/, "");
    const encodedSubId = encodeURIComponent(subId);
    const upstreamBases = [
      workerSubscriptionFetchBase(env),
      subscriptionClientBaseUrl(env),
      subscriptionBaseUrl(env),
    ].filter((base, index, list) => base && list.indexOf(base) === index);
    if (upstreamBases.length === 0) {
      return new Response("subscription cache missing", { status: 503, headers: CORS });
    }
    try {
      let upstreamRes: Response | null = null;
      for (const upstreamBase of upstreamBases) {
        const upstream = `${upstreamBase}${subPath}/${encodedSubId}`;
        const attempt = await panelFetch(env, upstream);
        const preview = await attempt.clone().text();
        if (
          attempt.ok &&
          preview.trim().length > 20 &&
          !isPanelErrorBody(preview, attempt.status)
        ) {
          upstreamRes = attempt;
          break;
        }
      }
      if (!upstreamRes) {
        return new Response("subscription unavailable", { status: 503, headers: CORS });
      }
      const rawBody = await upstreamRes.text();
      if (isPanelErrorBody(rawBody, upstreamRes.status)) {
        return new Response("subscription unavailable", { status: 503, headers: CORS });
      }
      const body = normalizeSubscriptionBody(rawBody);
      const headers: Record<string, string> = {
        ...lockedHeaders,
        "Content-Type":
          upstreamRes.headers.get("Content-Type") || "text/plain; charset=utf-8",
      };
      const userinfo = subscriptionUserinfoHeader(dbSub?.ends_at ?? null);
      if (userinfo) headers["Subscription-Userinfo"] = userinfo;
      for (const name of [
        "Profile-Title",
        "Profile-Web-Page-Url",
        "Support-Url",
        "Announce",
      ]) {
        const value = upstreamRes.headers.get(name);
        if (value) headers[name] = value;
      }
      return new Response(body, { status: 200, headers });
    } catch (error) {
      console.error("subscription proxy:", error);
      return new Response("subscription proxy failed", { status: 502, headers: CORS });
    }
  }

  if (path.startsWith("/api/redirect/") && request.method === "GET") {
    const client = path.slice("/api/redirect/".length).replace(/\/$/, "") as VpnClientId;
    const allowed: VpnClientId[] = ["happ", "v2rayng", "hiddify", "shadowrocket"];
    if (!allowed.includes(client)) {
      return new Response("unknown client", { status: 404, headers: CORS });
    }

    const params = new URL(request.url).searchParams;
    const sid = params.get("sid")?.trim();
    const legacySub = params.get("sub")?.trim();
    let importTarget = legacySub || "";
    if (sid) {
      try {
        importTarget = await buildClientImportTarget(env, client, sid);
      } catch (error) {
        console.error("redirect import prep:", error);
        return new Response("import prep failed", { status: 502, headers: CORS });
      }
    }
    if (!importTarget) {
      return new Response("missing sid", { status: 400, headers: CORS });
    }

    return new Response(redirectHtml(client, importTarget), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...CORS,
      },
    });
  }

  if (path === "/api/health" && request.method === "GET") {
    let clientBotOk = false;
    let partnerBotOk = false;
    let clientWebhookUrl: string | null = null;
    let supabaseOk = false;
    let supabaseStatus: number | null = null;
    let xuiOk = false;
    let xuiBase: string | null = null;
    const clientToken = clientBotToken(env);
    const partnerToken = partnerBotToken(env);
    if (clientToken) {
      try {
        const me = await fetch(`https://api.telegram.org/bot${clientToken}/getMe`);
        const data = (await me.json()) as { ok?: boolean };
        clientBotOk = Boolean(data.ok);
        const wh = await fetch(
          `https://api.telegram.org/bot${clientToken}/getWebhookInfo`
        );
        const whData = (await wh.json()) as { result?: { url?: string } };
        clientWebhookUrl = whData.result?.url ?? null;
      } catch {
        clientBotOk = false;
      }
    }
    if (partnerToken) {
      try {
        const me = await fetch(`https://api.telegram.org/bot${partnerToken}/getMe`);
        const data = (await me.json()) as { ok?: boolean };
        partnerBotOk = Boolean(data.ok);
      } catch {
        partnerBotOk = false;
      }
    }
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const sb = await sbRequest(env, "users?select=id&limit=1");
        supabaseStatus = sb.status;
        supabaseOk = sb.ok;
      } catch {
        supabaseOk = false;
      }
    }
    if (env.XUI_BASE_URL && env.XUI_API_TOKEN) {
      try {
        xuiBase = xuiBaseUrl(env);
        xuiOk = await new XuiApi(env).ping();
      } catch {
        xuiOk = false;
      }
    }
    const base = env.WEBAPP_URL?.replace(/\/$/, "") ?? null;
    const expectedClientWebhook = base ? `${base}/api/webhook/client` : null;
    return json({
      ok: true,
      hasClientToken: Boolean(clientToken),
      hasPartnerToken: Boolean(partnerToken),
      hasWebAppUrl: Boolean(env.WEBAPP_URL),
      hasSupabaseUrl: Boolean(env.SUPABASE_URL),
      hasSupabaseKey: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
      clientBotOk,
      partnerBotOk,
      supabaseOk,
      supabaseStatus,
      xuiOk,
      xuiBaseUrl: xuiBase,
      subscriptionBaseUrl: subscriptionBaseUrl(env) || null,
      webAppUrl: base,
      clientWebhookUrl,
      clientWebhookOk: Boolean(
        expectedClientWebhook &&
          clientWebhookUrl &&
          clientWebhookUrl === expectedClientWebhook
      ),
    });
  }

  if (
    (path === "/api/webhook/client" || path === "/api/webhook/telegram") &&
    request.method === "POST"
  ) {
    return handleLegacyTelegramWebhook(request, env);
  }

  if (path === "/api/webhook/partner" && request.method === "POST") {
    try {
      const update = await request.json();
      await handlePartnerBotUpdate(env, update);
    } catch (error) {
      console.error("partner webhook:", error);
    }
    return new Response("ok");
  }

  if (path === "/api/catalog" && request.method === "GET") {
    return json({
      tariffs: Object.values(TARIFFS),
      extraDevicePricePerMonth: EXTRA_DEVICE_PRICE_PER_MONTH,
      supportTelegramUsername:
        env.SUPPORT_TELEGRAM_USERNAME || SUPPORT_TELEGRAM_USERNAME,
      telegramChannelUrl: env.TELEGRAM_CHANNEL_URL || TELEGRAM_CHANNEL_URL,
      billingMonths: BILLING_MONTHS,
    });
  }

  const tgUser = await getAuthUser(request, env);

  if (!tgUser) {
    return json({ error: "Unauthorized: open via Telegram Mini App" }, 401);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Database not configured" }, 503);
  }

  if (path === "/api/me" && request.method === "GET") {
    try {
      const bundle = await ensureUser(env, tgUser);
      await resolvePanelSubIdForUser(env, tgUser);
      const fresh = await ensureUser(env, tgUser);
      const deviceInfo = await fetchMiniappDevices(env, fresh.user.id);
      const sub = fresh.subscription;
      const base = bundleToApiUser(fresh);
      return json({
        user: {
          ...base,
          subscription: {
            ...base.subscription,
            isTrial: Boolean(sub.is_trial),
            canConnect: canConnectSubscription(sub),
            periodText: subscriptionPeriodText(sub),
            devicesUsed: deviceInfo.used,
            devicesMax: deviceInfo.limit,
            panelOnline: deviceInfo.panelOnline,
            devices: deviceInfo.devices,
          },
        },
      });
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Database error" },
        500
      );
    }
  }

  if (path === "/api/connect" && request.method === "GET") {
    try {
      const params = new URL(request.url).searchParams;
      const platform = params.get("platform")?.trim() as MiniappPlatform | null;
      const client = params.get("client")?.trim() as MiniappClient | null;
      const allowedPlatforms: MiniappPlatform[] = ["android", "ios", "windows", "mac"];
      const allowedClients: MiniappClient[] = ["happ", "v2raytun", "hiddify"];
      if (!platform || !allowedPlatforms.includes(platform)) {
        return json({ error: "Invalid platform" }, 400);
      }
      if (!client || !allowedClients.includes(client)) {
        return json({ error: "Invalid client" }, 400);
      }
      const result = await buildMiniappConnectUrl(env, tgUser, platform, client);
      return json({ ok: true, ...result });
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Connect failed" },
        400
      );
    }
  }

  if (path === "/api/devices/reset" && request.method === "POST") {
    try {
      await resetMiniappDevices(env, tgUser);
      const bundle = await ensureUser(env, tgUser);
      const deviceInfo = await fetchMiniappDevices(env, bundle.user.id);
      return json({ ok: true, devices: deviceInfo });
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Reset failed" },
        400
      );
    }
  }

  if (path === "/api/purchase" && request.method === "POST") {
    try {
      const body = (await request.json()) as {
        planType?: PlanType;
        billingMonths?: number;
        extraDevices?: number;
      };
      const planType = body.planType;
      const months = body.billingMonths as BillingMonths | undefined;
      if (
        !planType ||
        !(planType in TARIFFS) ||
        !months ||
        !(months in TARIFFS[planType].periods)
      ) {
        return json({ error: "Invalid plan" }, 400);
      }
      const extraDevices = body.extraDevices ?? 0;
      const bundle = await purchaseSubscription(
        env,
        tgUser,
        planType,
        months,
        extraDevices
      );
      const total = calcTotalRub(
        planType,
        months,
        planType === "basic" ? extraDevices : 0
      );
      return json({
        ok: true,
        message: `Демо-оплата: ${total} ₽ · подписка активирована`,
        user: bundleToApiUser(bundle),
      });
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Purchase failed" },
        500
      );
    }
  }

  if (path === "/api/purchase-devices" && request.method === "POST") {
    try {
      const body = (await request.json()) as { extraDevices?: number };
      const add = body.extraDevices ?? 0;
      if (add < 1) return json({ error: "Invalid device count" }, 400);
      const bundle = await purchaseExtraDevices(env, tgUser, add);
      return json({
        ok: true,
        message: "Дополнительные устройства добавлены",
        user: bundleToApiUser(bundle),
      });
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Purchase failed" },
        400
      );
    }
  }

  return json({ error: "Not found" }, 404);
}
