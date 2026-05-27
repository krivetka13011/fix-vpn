import {
  TARIFFS,
  BILLING_MONTHS,
  EXTRA_DEVICE_PRICE_PER_MONTH,
  SUPPORT_TELEGRAM_ID,
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
import { sbRequest, type SupabaseEnv } from "./supabase";
import {
  displayName,
  validateInitData,
  type TelegramUser,
} from "./telegram";

export interface ApiEnv extends SupabaseEnv {
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

  if (!initData || !env.TELEGRAM_BOT_TOKEN) return null;

  try {
    const parsed = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
    return parsed?.user ?? null;
  } catch {
    return null;
  }
}

function isStartCommand(text: string | undefined): boolean {
  if (!text) return false;
  const cmd = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return cmd === "/start" || cmd.startsWith("/start@");
}

async function handleTelegramWebhook(
  request: Request,
  env: ApiEnv
): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return new Response("Bot token not configured", { status: 500 });
  }

  const webAppUrl = env.WEBAPP_URL;
  if (!webAppUrl) {
    return new Response("WEBAPP_URL not configured", { status: 500 });
  }

  const update = (await request.json()) as {
    message?: {
      chat: { id: number };
      text?: string;
    };
  };

  const chatId = update.message?.chat.id;
  const text = update.message?.text?.trim();

  if (!chatId) return new Response("ok");

  if (isStartCommand(text)) {
    const appUrl = webAppUrl.replace(/\/$/, "");
    const tgRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "FIX VPN — защищённый доступ через Hiddify, v2rayTun и другие клиенты.\n\nОткройте мини-приложение для покупки подписки и управления аккаунтом:",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Открыть FIX VPN",
                  web_app: { url: appUrl },
                },
              ],
            ],
          },
        }),
      }
    );
    const tgJson = (await tgRes.json()) as { ok?: boolean; description?: string };
    if (!tgJson.ok) {
      console.error("Telegram sendMessage:", tgJson.description ?? tgRes.status);
    }
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

  if (path === "/api/health" && request.method === "GET") {
    let botOk = false;
    let webhookUrl: string | null = null;
    let supabaseOk = false;
    if (env.TELEGRAM_BOT_TOKEN) {
      try {
        const me = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`
        );
        const data = (await me.json()) as { ok?: boolean };
        botOk = Boolean(data.ok);
        const wh = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`
        );
        const whData = (await wh.json()) as { result?: { url?: string } };
        webhookUrl = whData.result?.url ?? null;
      } catch {
        botOk = false;
      }
    }
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const sb = await sbRequest(env, "users?select=id&limit=1");
        supabaseOk = sb.ok;
      } catch {
        supabaseOk = false;
      }
    }
    const expectedWebhook = env.WEBAPP_URL
      ? `${env.WEBAPP_URL.replace(/\/$/, "")}/api/webhook/telegram`
      : null;
    return json({
      ok: true,
      hasToken: Boolean(env.TELEGRAM_BOT_TOKEN),
      hasWebAppUrl: Boolean(env.WEBAPP_URL),
      botOk,
      supabaseOk,
      webAppUrl: env.WEBAPP_URL?.replace(/\/$/, "") ?? null,
      webhookUrl,
      webhookOk: Boolean(
        expectedWebhook && webhookUrl && webhookUrl === expectedWebhook
      ),
    });
  }

  if (path === "/api/webhook/telegram" && request.method === "POST") {
    return handleTelegramWebhook(request, env);
  }

  if (path === "/api/catalog" && request.method === "GET") {
    return json({
      tariffs: Object.values(TARIFFS),
      extraDevicePricePerMonth: EXTRA_DEVICE_PRICE_PER_MONTH,
      supportTelegramId: SUPPORT_TELEGRAM_ID,
      telegramChannelUrl: TELEGRAM_CHANNEL_URL,
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
      return json({ user: bundleToApiUser(bundle) });
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Database error" },
        500
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
      const total = calcTotalRub(planType, months, planType === "basic" ? extraDevices : 0);
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
