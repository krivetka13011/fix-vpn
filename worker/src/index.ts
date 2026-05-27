import {
  displayName,
  validateInitData,
  type TelegramUser,
} from "./telegram";
import {
  PLANS,
  defaultUser,
  type PlanMonths,
  type Subscription,
  type UserRecord,
} from "./types";

export interface Env {
  ASSETS: Fetcher;
  USERS_KV: KVNamespace;
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
  env: Env
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

async function getOrCreateUser(
  env: Env,
  tgUser: TelegramUser
): Promise<UserRecord> {
  const key = `user:${tgUser.id}`;
  const existing = await env.USERS_KV.get<UserRecord>(key, "json");
  if (existing) {
    const merged: UserRecord = {
      ...existing,
      displayName: displayName(tgUser),
      username: tgUser.username ?? null,
      photoUrl: tgUser.photo_url ?? existing.photoUrl,
      updatedAt: new Date().toISOString(),
    };
    await env.USERS_KV.put(key, JSON.stringify(merged));
    return merged;
  }

  const user = defaultUser(
    tgUser.id,
    displayName(tgUser),
    tgUser.username ?? null,
    tgUser.photo_url ?? null
  );
  await env.USERS_KV.put(key, JSON.stringify(user));
  return user;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function handleApi(
  request: Request,
  env: Env,
  path: string
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (path === "/api/health" && request.method === "GET") {
    return json({
      ok: true,
      hasToken: Boolean(env.TELEGRAM_BOT_TOKEN),
      hasWebAppUrl: Boolean(env.WEBAPP_URL),
    });
  }

  const tgUser = await getAuthUser(request, env);

  if (path === "/api/plans" && request.method === "GET") {
    return json({
      plans: Object.entries(PLANS).map(([months, p]) => ({
        months: Number(months),
        ...p,
      })),
    });
  }

  if (!tgUser) {
    return json({ error: "Unauthorized: open via Telegram Mini App" }, 401);
  }

  if (path === "/api/me" && request.method === "GET") {
    const user = await getOrCreateUser(env, tgUser);
    return json({
      user: {
        id: user.telegramId,
        displayName: user.displayName,
        username: user.username,
        photoUrl: user.photoUrl,
        subscription: user.subscription,
      },
    });
  }

  if (path === "/api/purchase" && request.method === "POST") {
    const body = (await request.json()) as { planMonths?: number };
    const planMonths = body.planMonths as PlanMonths | undefined;
    if (!planMonths || !(planMonths in PLANS)) {
      return json({ error: "Invalid plan" }, 400);
    }

    const user = await getOrCreateUser(env, tgUser);
    const now = new Date();
    const plan = PLANS[planMonths];
    const subscription: Subscription = {
      status: "active",
      planMonths,
      planLabel: plan.label,
      startsAt: formatDate(now),
      endsAt: formatDate(addMonths(now, planMonths)),
      vpnKey: `FIX-${tgUser.id}-${planMonths}M-DEMO`,
    };

    const updated: UserRecord = {
      ...user,
      subscription,
      updatedAt: new Date().toISOString(),
    };
    await env.USERS_KV.put(`user:${tgUser.id}`, JSON.stringify(updated));

    return json({
      ok: true,
      message: "Демо-оплата: ключ создан (реальная оплата подключится позже)",
      subscription,
    });
  }

  if (path === "/api/webhook/telegram" && request.method === "POST") {
    return handleTelegramWebhook(request, env);
  }

  return json({ error: "Not found" }, 404);
}

async function handleTelegramWebhook(
  request: Request,
  env: Env
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

  if (text === "/start" || text?.startsWith("/start ")) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, {
      chat_id: chatId,
      text: "FIX VPN — защищённый доступ через Hiddify, v2rayTun и другие клиенты.\n\nОткройте мини-приложение для покупки подписки и управления аккаунтом:",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Открыть FIX VPN",
              web_app: { url: webAppUrl },
            },
          ],
        ],
      },
    });
  }

  return new Response("ok");
}

async function sendTelegram(
  token: string,
  body: Record<string, unknown>
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url.pathname);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("Worker error:", message);
      return new Response(`FIX VPN error: ${message}`, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  },
};
