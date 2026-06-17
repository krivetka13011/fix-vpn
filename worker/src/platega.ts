import type { BotEnv } from "./env";

const PLATEGA_API = "https://app.platega.io/transaction/process";

export type PlategaBillResult = {
  transactionId: string;
  redirect: string;
  status: string;
};

export type PlategaCallback = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  paymentMethod: number;
};

export function isPlategaConfigured(env: BotEnv): boolean {
  return Boolean(
    env.PLATEGA_MERCHANT_ID?.trim() && env.PLATEGA_API_SECRET?.trim()
  );
}

export function plategaPaymentMethod(method: string): number | undefined {
  if (method === "sbp") return 2;
  if (method === "card") return 11;
  if (method === "crypto_usdt") return 13;
  return undefined;
}

export function shouldUsePlatega(env: BotEnv, method: string): boolean {
  return isPlategaConfigured(env) && plategaPaymentMethod(method) !== undefined;
}

function plategaHeaders(env: BotEnv): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-MerchantId": env.PLATEGA_MERCHANT_ID!.trim(),
    "X-Secret": env.PLATEGA_API_SECRET!.trim(),
  };
}

export async function createPlategaPayment(
  env: BotEnv,
  input: {
    amount: number;
    orderId: string;
    description: string;
    method: string;
    telegramId: number;
    username?: string | null;
  }
): Promise<PlategaBillResult> {
  if (!isPlategaConfigured(env)) {
    throw new Error("Platega не настроена");
  }
  const paymentMethod = plategaPaymentMethod(input.method);
  if (!paymentMethod) {
    throw new Error(`Platega: способ ${input.method} не поддерживается`);
  }

  const base = env.WEBAPP_URL?.replace(/\/$/, "") || "https://app.fixvp.xyz";
  const amount = Math.max(1, Math.round(input.amount));

  const response = await fetch(PLATEGA_API, {
    method: "POST",
    headers: plategaHeaders(env),
    body: JSON.stringify({
      paymentMethod,
      paymentDetails: { amount, currency: "RUB" },
      description: input.description,
      return: `${base}/api/payment/platega/success`,
      failedUrl: `${base}/api/payment/platega/fail`,
      payload: input.orderId,
      metadata: {
        userId: String(input.telegramId),
        userName: input.username ? `@${input.username.replace(/^@+/, "")}` : String(input.telegramId),
      },
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.title === "string"
          ? payload.title
          : `Platega HTTP ${response.status}`;
    throw new Error(message);
  }

  const transactionId = String(payload.transactionId || "").trim();
  const redirect = String(payload.redirect || "").trim();
  const status = String(payload.status || "PENDING");
  if (!transactionId || !redirect) {
    throw new Error("Platega: пустой ответ");
  }
  return { transactionId, redirect, status };
}

export function verifyPlategaCallback(env: BotEnv, request: Request): boolean {
  const merchantId = request.headers.get("X-MerchantId")?.trim();
  const secret = request.headers.get("X-Secret")?.trim();
  return (
    merchantId === env.PLATEGA_MERCHANT_ID?.trim() &&
    secret === env.PLATEGA_API_SECRET?.trim()
  );
}

export async function parsePlategaCallback(request: Request): Promise<PlategaCallback> {
  const body = (await request.json()) as Record<string, unknown>;
  return {
    id: String(body.id || ""),
    amount: Number(body.amount || 0),
    currency: String(body.currency || "RUB"),
    status: String(body.status || "").toUpperCase(),
    paymentMethod: Number(body.paymentMethod || 0),
  };
}

export async function getPlategaBalance(
  env: BotEnv
): Promise<Array<{ amount: number; currency: string }> | null> {
  if (!isPlategaConfigured(env)) return null;
  const response = await fetch("https://app.platega.io/balance/all", {
    headers: plategaHeaders(env),
  });
  if (!response.ok) return null;
  const rows = (await response.json()) as Array<{ amount: number; currency: string }>;
  return Array.isArray(rows) ? rows : null;
}

export function plategaResultHtml(title: string, body: string): Response {
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e8eef5;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}main{max-width:420px;text-align:center}h1{font-size:1.4rem}p{opacity:.85;line-height:1.5}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
