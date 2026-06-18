import type { BotEnv } from "./env";

const PLATEGA_BASE = "https://app.platega.io";

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
  payload?: string;
};

export type PlategaHealth = {
  ok: boolean;
  error?: string;
};

class PlategaApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PlategaApiError";
    this.status = status;
  }
}

export function isPlategaConfigured(env: BotEnv): boolean {
  return Boolean(
    env.PLATEGA_MERCHANT_ID?.trim() && env.PLATEGA_API_SECRET?.trim()
  );
}

export function plategaPaymentMethod(method: string): number | undefined {
  if (method === "sbp") return 2;
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

function parsePlategaError(
  payload: Record<string, unknown>,
  status: number
): string {
  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }
  if (typeof payload.title === "string" && payload.title.trim()) {
    return payload.title.trim();
  }
  if (typeof payload.detail === "string" && payload.detail.trim()) {
    return payload.detail.trim();
  }
  const errors = payload.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as Record<string, unknown>;
    if (typeof first.message === "string" && first.message.trim()) {
      return first.message.trim();
    }
  }
  if (status === 401) {
    return "Неверный PLATEGA_MERCHANT_ID или PLATEGA_API_SECRET";
  }
  return `Platega HTTP ${status}`;
}

function paymentRedirect(payload: Record<string, unknown>): string {
  return String(payload.redirect || payload.url || "").trim();
}

async function postPlatega(
  env: BotEnv,
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${PLATEGA_BASE}${path}`, {
    method: "POST",
    headers: plategaHeaders(env),
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new PlategaApiError(parsePlategaError(payload, response.status), response.status);
  }
  return payload;
}

export async function checkPlategaHealth(env: BotEnv): Promise<PlategaHealth> {
  if (!isPlategaConfigured(env)) {
    return {
      ok: false,
      error: "PLATEGA_MERCHANT_ID или PLATEGA_API_SECRET не заданы",
    };
  }
  try {
    const response = await fetch(`${PLATEGA_BASE}/balance/all`, {
      headers: plategaHeaders(env),
    });
    const payload = (await response.json().catch(() => ({}))) as
      | Record<string, unknown>
      | Array<unknown>;
    if (response.ok && Array.isArray(payload)) {
      return { ok: true };
    }
    const record = Array.isArray(payload) ? {} : payload;
    return {
      ok: false,
      error: parsePlategaError(record, response.status),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Platega недоступна",
    };
  }
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
  const baseBody: Record<string, unknown> = {
    paymentDetails: { amount, currency: "RUB" },
    description: input.description,
    return: `${base}/api/payment/platega/success`,
    failedUrl: `${base}/api/payment/platega/fail`,
    payload: input.orderId,
    metadata: {
      userId: String(input.telegramId),
      userName: input.username
        ? `@${input.username.replace(/^@+/, "")}`
        : String(input.telegramId),
    },
  };

  let payload: Record<string, unknown>;
  try {
    payload = await postPlatega(env, "/transaction/process", {
      ...baseBody,
      paymentMethod,
    });
  } catch (v1Error) {
    const status = v1Error instanceof PlategaApiError ? v1Error.status : 0;
    if (status !== 400) throw v1Error;
    payload = await postPlatega(env, "/v2/transaction/process", baseBody);
  }

  const transactionId = String(payload.transactionId || "").trim();
  const redirect = paymentRedirect(payload);
  const status = String(payload.status || "PENDING");
  if (!transactionId || !redirect) {
    throw new Error("Platega: пустой ответ (нет transactionId или ссылки на оплату)");
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
    id: String(body.id || body.transactionId || ""),
    amount: Number(body.amount || 0),
    currency: String(body.currency || "RUB"),
    status: String(body.status || "").toUpperCase(),
    paymentMethod: Number(body.paymentMethod || 0),
    payload: body.payload != null ? String(body.payload) : undefined,
  };
}

export async function getPlategaBalance(
  env: BotEnv
): Promise<Array<{ amount: number; currency: string }> | null> {
  const health = await checkPlategaHealth(env);
  if (!health.ok) return null;
  const response = await fetch(`${PLATEGA_BASE}/balance/all`, {
    headers: plategaHeaders(env),
  });
  if (!response.ok) return null;
  const rows = (await response.json()) as Array<{ amount: number; currency: string }>;
  return Array.isArray(rows) ? rows : null;
}

export async function getPlategaTransactionStatus(
  env: BotEnv,
  transactionId: string
): Promise<string> {
  const id = transactionId.trim();
  if (!isPlategaConfigured(env) || !id) return "";
  try {
    const response = await fetch(`${PLATEGA_BASE}/transaction/${encodeURIComponent(id)}`, {
      headers: plategaHeaders(env),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return "";
    return String(payload.status || "").toUpperCase();
  } catch {
    return "";
  }
}

export function plategaResultHtml(title: string, body: string): Response {
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e8eef5;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}main{max-width:420px;text-align:center}h1{font-size:1.4rem}p{opacity:.85;line-height:1.5}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
