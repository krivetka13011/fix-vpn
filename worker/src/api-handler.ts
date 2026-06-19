import {
  TARIFFS,
  BILLING_MONTHS,
  EXTRA_DEVICE_PRICE_PER_MONTH,
  SUPPORT_TELEGRAM_USERNAME,
  TELEGRAM_CHANNEL_URL,
  calcTotalRub,
  catalogForEnv,
  type BillingMonths,
  type PlanType,
} from "./catalog";
import {
  ensureUser,
  getBundle,
} from "./db";
import { startMiniappAddonDevicesCheckout, startMiniappPlategaCheckout } from "./miniapp-checkout";
import { activateMiniappTrial } from "./miniapp-trial";
import { runUserPendingPlategaReconcile } from "./platega-reconcile";
import { trialButtonHidden } from "./trial-button";
import {
  getSubscriptionBySubId,
  getTransactionByPayloadId,
  getTransactionByPlategaId,
  getUserById,
  kvGetSubscriptionPayloadCache,
  kvSetSubscriptionPayloadCache,
} from "./repository";
import { validateInitData, type TelegramUser } from "./telegram";
import type { BotEnv } from "./env";
import {
  clientBotToken,
  partnerBotToken,
  subscriptionBaseUrl,
  subscriptionClientBaseUrl,
  workerSubscriptionFetchBase,
  xuiBaseUrl,
  healthPingPanel,
} from "./env";
import { isPanelErrorBody, panelFetch } from "./panel-fetch";
import { handleClientBotUpdate } from "./bots/client-bot";
import { handlePartnerBotUpdate } from "./bots/partner-bot";
import { beginE2eTrace, endE2eTrace } from "./e2e-trace";
import { DeviceResetCooldownError, DeviceResetPanelError } from "./device-reset";
import { approvePaidTransaction } from "./approve-transaction";
import { isTestMode, trialDurationMs } from "./test-mode";
import { debugSessionLog } from "./debug-session-log";
import {
  reconcilePlategaFromReturnUrl,
} from "./platega-reconcile";
import {
  cardlinkResultHtml,
  isCardlinkConfigured,
  parseCardlinkPostback,
  verifyCardlinkPostbackSignature,
} from "./cardlink";
import { getCardlinkBalance, isCardlinkPayoutConfigured } from "./cardlink-payout";
import {
  checkPlategaHealth,
  getPlategaBalance,
  isPlategaConfigured,
  parsePlategaCallback,
  plategaResultHtml,
  verifyPlategaCallback,
} from "./platega";
import { ensureActiveSubscriptionPanel } from "./subscription-activate";
import { syncPanelSubIdForUser } from "./panel-sync";
import { XuiApi } from "./xui";
import {
  buildMiniappConnectUrl,
  buildMiniappUserProfile,
  fetchMiniappDevices,
  resetMiniappDevices,
  type MiniappClient,
  type MiniappPlatform,
} from "./miniapp-services";
import {
  buildClientImportTarget,
  buildSubscriptionResponseHeaders,
  mergeHappSubscriptionHeaders,
  encodeJsonSubscriptionBodyForHapp,
  fetchPanelJsonSubscription,
  encodeStandardSubscriptionBody,
  fetchPanelSubscriptionBody,
  normalizeSubscriptionBody,
  subscriptionBodyForClients,
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

function miniappTrialAvailable(
  env: BotEnv,
  telegramId: number,
  user: Parameters<typeof trialButtonHidden>[0],
  sub: Parameters<typeof trialButtonHidden>[1]
): boolean {
  void env;
  void telegramId;
  if (sub?.status === "active") return false;
  return !trialButtonHidden(user, sub);
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

function e2eTraceResponse(
  ok: boolean,
  trace: ReturnType<typeof endE2eTrace>,
  error?: unknown
): Response {
  try {
    return json(
      ok
        ? { ok: true, trace }
        : { ok: false, error: String(error), trace },
      ok ? 200 : 500
    );
  } catch (serializeError) {
    console.error("e2e trace serialize:", serializeError);
    return new Response(
      JSON.stringify({
        ok: false,
        error: error ? String(error) : "trace serialize failed",
        serializeError: String(serializeError),
        entryCount: trace?.entries?.length ?? 0,
      }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }
}

async function handleLegacyTelegramWebhook(
  request: Request,
  env: ApiEnv,
  ctx?: ExecutionContext
): Promise<Response> {
  const e2eSecret = env.E2E_TRACE_SECRET?.trim();
  const e2eHeader = request.headers.get("X-Fix-Vpn-E2E")?.trim();
  const tracing = Boolean(e2eSecret && e2eHeader && e2eHeader === e2eSecret);
  const dry = tracing && request.headers.get("X-Fix-Vpn-E2E-Dry") === "1";

  if (tracing) {
    beginE2eTrace(dry);
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch (error) {
    console.error("client webhook parse:", error);
    return new Response("ok");
  }

  const run = async (): Promise<void> => {
    try {
      await handleClientBotUpdate(env, update);
    } catch (error) {
      console.error("client webhook:", error);
      if (tracing) throw error;
    }
  };

  if (tracing) {
    let handlerError: unknown = null;
    try {
      await run();
    } catch (error) {
      handlerError = error;
    }
    return e2eTraceResponse(!handlerError, endE2eTrace(), handlerError);
  }

  if (ctx) {
    ctx.waitUntil(run());
    return new Response("ok");
  }

  await run();
  return new Response("ok");
}

export async function handleApiRequest(
  request: Request,
  env: ApiEnv,
  path: string,
  ctx?: ExecutionContext
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (path === "/health" && request.method === "GET") {
    return json({
      ok: true,
      service: "FIX VPN",
      bot: "https://t.me/FIXVPNfast_bot",
      site: "https://app.fixvp.xyz",
    });
  }

  if (
    (path.startsWith("/api/sub/") || path.startsWith("/sub/")) &&
    request.method === "GET"
  ) {
    const prefix = path.startsWith("/api/sub/") ? "/api/sub/" : "/sub/";
    const subId = decodeURIComponent(path.slice(prefix.length))
      .replace(/\/$/, "")
      .trim();
    if (!subId || subId.includes("/")) {
      return new Response("bad sub", { status: 400, headers: CORS });
    }

    const lockedHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...buildSubscriptionResponseHeaders(env),
      ...CORS,
    };

    let dbSub: Awaited<ReturnType<typeof getSubscriptionBySubId>> = null;
    try {
      dbSub = await getSubscriptionBySubId(env, subId);
    } catch (error) {
      console.error("subscription db lookup:", error);
    }

    if (!dbSub || dbSub.status !== "active") {
      // #region agent log
      debugSessionLog(
        "api-handler.ts:/sub",
        "subscription lookup miss",
        {
          subIdPrefix: subId.slice(0, 8),
          found: Boolean(dbSub),
          status: dbSub?.status ?? null,
        },
        "A"
      );
      // #endregion
      return new Response("subscription revoked", { status: 404, headers: CORS });
    }

    try {
      let live = await fetchPanelSubscriptionBody(env, subId);
      if (!live?.body) {
        for (let attempt = 0; attempt < 2 && !live?.body; attempt += 1) {
          try {
            await ensureActiveSubscriptionPanel(env, dbSub);
          } catch (error) {
            console.error("subscription ensure attempt:", error);
          }
          live = await fetchPanelSubscriptionBody(env, subId);
        }
      }
      if (live?.body) {
        const headers = mergeHappSubscriptionHeaders(
          {
            ...lockedHeaders,
            ...live.headers,
            "Content-Disposition": `attachment; filename=${subId}`,
          },
          env
        );
        const userinfo = subscriptionUserinfoHeader(dbSub.ends_at ?? null);
        if (userinfo) headers["Subscription-Userinfo"] = userinfo;
        const body = encodeStandardSubscriptionBody(live.body, env);
        ctx?.waitUntil(
          (async () => {
            try {
              const user = await getUserById(env, dbSub.user_id);
              if (user) {
                await syncPanelSubIdForUser(
                  env,
                  user.id,
                  user.telegram_id,
                  user.username,
                  user.display_name,
                  dbSub,
                  { force: true }
                );
              }
            } catch (error) {
              console.error("subscription panel sync:", error);
            }
            await kvSetSubscriptionPayloadCache(
              env,
              dbSub.user_id,
              subscriptionBodyForClients(live.body)
            );
          })().catch((error) => console.error("subscription cache write:", error))
        );
        return new Response(body, { status: 200, headers });
      }

      const cached = (await kvGetSubscriptionPayloadCache(env, dbSub.user_id))?.trim();
      if (cached && cached.length > 100) {
        const headers = mergeHappSubscriptionHeaders(
          {
            ...lockedHeaders,
            "Content-Disposition": `attachment; filename=${subId}`,
          },
          env
        );
        const userinfo = subscriptionUserinfoHeader(dbSub.ends_at ?? null);
        if (userinfo) headers["Subscription-Userinfo"] = userinfo;
        const body = encodeStandardSubscriptionBody(normalizeSubscriptionBody(cached), env);
        return new Response(body, { status: 200, headers });
      }

      // #region agent log
      debugSessionLog(
        "api-handler.ts:/sub",
        "subscription unavailable after ensure",
        {
          subIdPrefix: subId.slice(0, 8),
          hadCache: false,
          panelLive: Boolean(live?.body),
        },
        "B"
      );
      // #endregion
      return new Response("subscription unavailable", {
        status: 503,
        headers: { ...CORS, "Retry-After": "3" },
      });
    } catch (error) {
      console.error("subscription serve:", error);
      // #region agent log
      debugSessionLog(
        "api-handler.ts:/sub",
        "subscription serve exception",
        { subIdPrefix: subId.slice(0, 8) },
        "F"
      );
      // #endregion
      return new Response("subscription unavailable", {
        status: 503,
        headers: { ...CORS, "Retry-After": "3" },
      });
    }
  }

  if (path.startsWith("/json/") && request.method === "GET") {
    const subId = decodeURIComponent(path.slice("/json/".length))
      .replace(/\/$/, "")
      .trim();
    if (!subId || subId.includes("/")) {
      return new Response("bad sub", { status: 400, headers: CORS });
    }

    let dbSub: Awaited<ReturnType<typeof getSubscriptionBySubId>> = null;
    try {
      dbSub = await getSubscriptionBySubId(env, subId);
    } catch (error) {
      console.error("json subscription db lookup:", error);
    }
    if (!dbSub || dbSub.status !== "active") {
      return new Response("subscription revoked", { status: 404, headers: CORS });
    }

    try {
      let live = await fetchPanelJsonSubscription(env, subId);
      if (!live?.body) {
        for (let attempt = 0; attempt < 4 && !live?.body; attempt += 1) {
          await fetchPanelSubscriptionBody(env, subId);
          await ensureActiveSubscriptionPanel(env, dbSub);
          live = await fetchPanelJsonSubscription(env, subId);
        }
      }
      if (!live?.body) {
        // #region agent log
        debugSessionLog(
          "api-handler.ts:/json",
          "json subscription unavailable",
          { subIdPrefix: subId.slice(0, 8) },
          "C"
        );
        // #endregion
        return new Response("json subscription unavailable", { status: 503, headers: CORS });
      }

      const headers = mergeHappSubscriptionHeaders(
        {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          ...live.headers,
          ...CORS,
          "Content-Disposition": `attachment; filename=${subId}`,
        },
        env
      );
      const userinfo = subscriptionUserinfoHeader(dbSub.ends_at ?? null);
      if (userinfo) headers["Subscription-Userinfo"] = userinfo;
      const wireBody = encodeJsonSubscriptionBodyForHapp(live.body);
      return new Response(wireBody, { status: 200, headers });
    } catch (error) {
      console.error("json subscription:", error);
      return new Response("json subscription unavailable", { status: 503, headers: CORS });
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
    let d1Ok = false;
    let kvOk = false;
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
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      d1Ok = true;
    } catch {
      d1Ok = false;
    }
    try {
      await env.KV.put("health:ping", "1", { expirationTtl: 60 });
      kvOk = (await env.KV.get("health:ping")) === "1";
    } catch {
      kvOk = false;
    }
    if (env.XUI_BASE_URL && env.XUI_API_TOKEN) {
      xuiBase = xuiBaseUrl(env);
      if (healthPingPanel(env)) {
        try {
          xuiOk = await new XuiApi(env).ping();
        } catch {
          xuiOk = false;
        }
      } else {
        xuiOk = true;
      }
    }
    const base = env.WEBAPP_URL?.replace(/\/$/, "") ?? null;
    const expectedClientWebhook = base ? `${base}/api/webhook/client` : null;
    const cardlinkConfigured = isCardlinkConfigured(env);
    const cardlinkPayoutEnabled = isCardlinkPayoutConfigured(env);
    const plategaConfigured = isPlategaConfigured(env);
    let cardlinkBalance: { available: number; hold: number } | null = null;
    let plategaBalance: Array<{ amount: number; currency: string }> | null = null;
    let plategaOk = false;
    let plategaError: string | null = null;
    if (cardlinkConfigured) {
      const balance = await getCardlinkBalance(env);
      if (balance) {
        cardlinkBalance = { available: balance.available, hold: balance.hold };
      }
    }
    if (plategaConfigured) {
      const health = await checkPlategaHealth(env);
      plategaOk = health.ok;
      plategaError = health.error ?? null;
      if (health.ok) {
        plategaBalance = await getPlategaBalance(env);
      }
    }
    return json({
      ok: true,
      hasClientToken: Boolean(clientToken),
      hasPartnerToken: Boolean(partnerToken),
      hasWebAppUrl: Boolean(env.WEBAPP_URL),
      hasD1: Boolean(env.DB),
      hasKv: Boolean(env.KV),
      clientBotOk,
      partnerBotOk,
      d1Ok,
      kvOk,
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
      cardlinkConfigured,
      cardlinkPayoutEnabled,
      cardlinkBalance,
      plategaConfigured,
      plategaOk,
      plategaError,
      plategaBalance,
      plategaWebhookUrl: base ? `${base}/api/webhook/platega` : null,
      testMode: isTestMode(env),
      trialDurationMinutes: env.TRIAL_DURATION_MINUTES || (isTestMode(env) ? "5" : null),
      testCheckoutPriceRub: env.TEST_CHECKOUT_PRICE_RUB || (isTestMode(env) ? "1" : null),
      testSubscriptionMinutes:
        env.TEST_SUBSCRIPTION_MINUTES || (isTestMode(env) ? "10" : null),
    });
  }

  if (path === "/api/payment/cardlink/success" && (request.method === "GET" || request.method === "POST")) {
    return cardlinkResultHtml(
      "Оплата принята",
      "Спасибо! Вернитесь в Telegram — бот пришлёт подтверждение в течение минуты."
    );
  }

  if (path === "/api/payment/cardlink/fail" && (request.method === "GET" || request.method === "POST")) {
    return cardlinkResultHtml(
      "Оплата не прошла",
      "Платёж отменён или отклонён. Вернитесь в бот и попробуйте снова."
    );
  }

  if (path === "/api/payment/platega/success" && (request.method === "GET" || request.method === "POST")) {
    const reconcile = reconcilePlategaFromReturnUrl(env, request).catch((error) =>
      console.error("platega success reconcile:", error)
    );
    if (ctx) ctx.waitUntil(reconcile);
    else await reconcile;
    return plategaResultHtml(
      "Оплата принята",
      "Спасибо! Подписка активируется автоматически. Вернитесь в Telegram — бот пришлёт подтверждение."
    );
  }

  if (path === "/api/payment/platega/fail" && (request.method === "GET" || request.method === "POST")) {
    return plategaResultHtml(
      "Оплата не прошла",
      "Платёж отменён или отклонён. Вернитесь в бот и попробуйте снова."
    );
  }

  if (path === "/api/webhook/platega" && request.method === "POST") {
    if (!isPlategaConfigured(env)) {
      return new Response("platega disabled", { status: 503 });
    }
    try {
      if (!verifyPlategaCallback(env, request)) {
        console.error("platega callback: bad auth");
        return new Response("unauthorized", { status: 401 });
      }
      const callback = await parsePlategaCallback(request);
      if (!callback.id) return new Response("bad payload", { status: 400 });

      let txn = await getTransactionByPlategaId(env, callback.id);
      if (!txn && callback.payload) {
        txn = await getTransactionByPayloadId(env, callback.payload);
      }
      if (!txn) txn = await getTransactionByPayloadId(env, callback.id);

      if (callback.status === "CONFIRMED" && txn) {
        const approve = approvePaidTransaction(env, txn.id).then((result) => {
          if (!result.ok) {
            console.error("platega approve:", result.message, callback.id);
          }
        });
        if (ctx) ctx.waitUntil(approve);
        else await approve;
      } else if (callback.status === "CANCELED" && txn) {
        const { patchTransaction } = await import("./repository");
        await patchTransaction(env, txn.id, { status: "rejected" });
      }

      return new Response("ok", { status: 200 });
    } catch (error) {
      console.error("platega webhook:", error);
      return new Response("error", { status: 500 });
    }
  }

  if (path === "/api/webhook/cardlink" && request.method === "POST") {
    if (!isCardlinkConfigured(env)) {
      return new Response("cardlink disabled", { status: 503 });
    }
    try {
      const postback = await parseCardlinkPostback(request);
      if (
        !postback.invId ||
        !postback.outSum ||
        !verifyCardlinkPostbackSignature(
          env,
          postback.outSum,
          postback.invId,
          postback.signatureValue
        )
      ) {
        console.error("cardlink postback: bad signature", postback.invId);
        return new Response("bad signature", { status: 403 });
      }

      if (postback.status === "SUCCESS") {
        const result = await approvePaidTransaction(env, postback.invId);
        if (!result.ok) {
          console.error("cardlink approve:", result.message, postback.invId);
        }
      } else if (postback.status === "FAIL") {
        const { patchTransaction } = await import("./repository");
        await patchTransaction(env, postback.invId, { status: "rejected" });
      }

      return new Response("ok");
    } catch (error) {
      console.error("cardlink webhook:", error);
      return new Response("error", { status: 500 });
    }
  }

  if (
    (path === "/api/webhook/client" || path === "/api/webhook/telegram") &&
    request.method === "POST"
  ) {
    return handleLegacyTelegramWebhook(request, env, ctx);
  }

  if (path === "/api/webhook/partner" && request.method === "POST") {
    let update: unknown;
    try {
      update = await request.json();
    } catch (error) {
      console.error("partner webhook parse:", error);
      return new Response("ok");
    }
    const run = handlePartnerBotUpdate(env, update).catch((error) => {
      console.error("partner webhook:", error);
    });
    if (ctx) {
      ctx.waitUntil(run);
    } else {
      await run;
    }
    return new Response("ok");
  }

  if (path === "/api/catalog" && request.method === "GET") {
    const catalog = catalogForEnv(env);
    return json({
      ...catalog,
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

  if (!env.DB || !env.KV) {
    return json({ error: "Database not configured" }, 503);
  }

  if (path === "/api/me" && request.method === "GET") {
    try {
      const userRow = await ensureUser(env, tgUser);
      void runUserPendingPlategaReconcile(env, userRow.user.id).catch((error) =>
        console.error("miniapp platega reconcile:", error)
      );
      const fresh = (await getBundle(env, tgUser.id)) ?? userRow;
      const profile = await buildMiniappUserProfile(env, fresh);
      // #region agent log
      debugSessionLog(
        "api-handler.ts:/api/me",
        "profile loaded",
        {
          status: fresh.subscription.status,
          canConnect: profile.subscription.canConnect,
          devicesUsed: profile.subscription.devicesUsed,
          devicesMax: profile.subscription.devicesMax,
          trialAvailable: miniappTrialAvailable(env, tgUser.id, fresh.user, fresh.subscription),
        },
        "B"
      );
      // #endregion
      return json({
        user: {
          ...profile,
          trialAvailable: miniappTrialAvailable(env, tgUser.id, fresh.user, fresh.subscription),
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
      // #region agent log
      debugSessionLog(
        "api-handler.ts:/api/connect",
        "connect ok",
        { platform, client, hasSubId: Boolean(result.subId) },
        "C"
      );
      // #endregion
      return json({ ok: true, ...result });
    } catch (e) {
      // #region agent log
      debugSessionLog(
        "api-handler.ts:/api/connect",
        "connect failed",
        { error: e instanceof Error ? e.message : "unknown" },
        "C"
      );
      // #endregion
      return json(
        { error: e instanceof Error ? e.message : "Connect failed" },
        400
      );
    }
  }

  if (path === "/api/devices/reset" && request.method === "POST") {
    try {
      const message = await resetMiniappDevices(env, tgUser);
      const bundle = await ensureUser(env, tgUser);
      const profile = await buildMiniappUserProfile(env, bundle);
      return json({
        ok: true,
        message,
        user: profile,
      });
    } catch (e) {
      if (e instanceof DeviceResetCooldownError) {
        return json({ error: e.message, cooldownMs: e.remainingMs }, 429);
      }
      if (e instanceof DeviceResetPanelError) {
        return json({ error: e.message }, 502);
      }
      return json(
        { error: e instanceof Error ? e.message : "Reset failed" },
        400
      );
    }
  }

  if (path === "/api/trial" && request.method === "POST") {
    try {
      const result = await activateMiniappTrial(env, tgUser);
      const bundle = (await getBundle(env, tgUser.id))!;
      const profile = await buildMiniappUserProfile(env, bundle, {
        skipPanel: true,
      });
      // #region agent log
      debugSessionLog(
        "api-handler.ts:/api/trial",
        "trial activated",
        {
          canConnect: profile.subscription.canConnect,
          isTrial: profile.subscription.isTrial,
          trialMinutes: Math.round(trialDurationMs(env) / 60000),
        },
        "A"
      );
      // #endregion
      return json({
        ok: true,
        message: result.message,
        user: {
          ...profile,
          trialAvailable: miniappTrialAvailable(env, tgUser.id, bundle.user, bundle.subscription),
        },
      });
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Trial activation failed" },
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
        paymentMethod?: string;
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
      const method = body.paymentMethod?.trim() || "sbp";
      const checkout = await startMiniappPlategaCheckout(env, tgUser, {
        planType,
        months,
        extraDevices,
        method,
      });
      return json({
        ok: true,
        paymentUrl: checkout.paymentUrl,
        amount: checkout.amount,
        message: checkout.message,
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
      const body = (await request.json()) as {
        extraDevices?: number;
        paymentMethod?: string;
      };
      const add = body.extraDevices ?? 1;
      if (add < 1) return json({ error: "Invalid device count" }, 400);
      const method = body.paymentMethod?.trim() || "sbp";
      const checkout = await startMiniappAddonDevicesCheckout(env, tgUser, {
        addDevices: add,
        method,
      });
      return json({
        ok: true,
        paymentUrl: checkout.paymentUrl,
        amount: checkout.amount,
        message: checkout.message,
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
