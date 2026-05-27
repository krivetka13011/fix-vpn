import {
  displayName,
  validateInitData,
  type TelegramUser,
} from "./telegram";
import { applySubscriptionExpiry } from "./subscription";
import {
  PLANS,
  defaultUser,
  type PlanMonths,
  type Subscription,
  type UserRecord,
} from "./types";

export interface ApiEnv {
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

async function readUser(env: ApiEnv, key: string): Promise<UserRecord | null> {
  try {
    const raw = await env.USERS_KV.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as UserRecord;
  } catch {
    return null;
  }
}

async function getOrCreateUser(
  env: ApiEnv,
  tgUser: TelegramUser
): Promise<UserRecord> {
  const key = `user:${tgUser.id}`;
  const existing = await readUser(env, key);
  if (existing) {
    const merged: UserRecord = {
      ...existing,
      displayName: displayName(tgUser),
      username: tgUser.username ?? null,
      photoUrl: tgUser.photo_url ?? existing.photoUrl,
      subscription: applySubscriptionExpiry(existing.subscription),
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
    const expectedWebhook = env.WEBAPP_URL
      ? `${env.WEBAPP_URL.replace(/\/$/, "")}/api/webhook/telegram`
      : null;
    return json({
      ok: true,
      hasToken: Boolean(env.TELEGRAM_BOT_TOKEN),
      hasWebAppUrl: Boolean(env.WEBAPP_URL),
      botOk,
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

  if (path === "/api/plans" && request.method === "GET") {
    return json({
      plans: Object.entries(PLANS).map(([months, p]) => ({
        months: Number(months),
        ...p,
      })),
    });
  }

  const tgUser = await getAuthUser(request, env);

  if (!tgUser) {
    return json({ error: "Unauthorized: open via Telegram Mini App" }, 401);
  }

  if (path === "/api/me" && request.method === "GET") {
    const user = await getOrCreateUser(env, tgUser);
    const subscription = applySubscriptionExpiry(user.subscription);
    return json({
      user: {
        id: user.telegramId,
        displayName: user.displayName,
        username: user.username,
        photoUrl: user.photoUrl,
        subscription,
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
    const prev = user.subscription;
    const extendFrom =
      prev.status === "active" && prev.endsAt
        ? new Date(`${prev.endsAt}T12:00:00`) > now
          ? new Date(`${prev.endsAt}T12:00:00`)
          : now
        : now;
    const subscription: Subscription = {
      status: "active",
      planMonths,
      planLabel: plan.label,
      startsAt:
        prev.status === "active" && prev.startsAt
          ? prev.startsAt
          : formatDate(now),
      endsAt: formatDate(addMonths(extendFrom, planMonths)),
      vpnKey: prev.vpnKey ?? `FIX-${tgUser.id}-${planMonths}M-DEMO`,
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

  return json({ error: "Not found" }, 404);
}
