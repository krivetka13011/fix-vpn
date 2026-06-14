import type { BotEnv } from "./env";
import { md5HexUpper } from "./md5";

const CARDLINK_API = "https://cardlink.link/api/v1/bill/create";

export type CardlinkBillResult = {
  billId: string;
  linkPageUrl: string;
  linkUrl: string;
};

export type CardlinkPostback = {
  invId: string;
  outSum: string;
  status: string;
  trsId: string;
  currencyIn: string;
  custom: string | null;
  signatureValue: string;
};

export function isCardlinkConfigured(env: BotEnv): boolean {
  return Boolean(
    env.CARDLINK_API_TOKEN?.trim() && env.CARDLINK_SHOP_ID?.trim()
  );
}

export function cardlinkPaymentMethod(method: string): "BANK_CARD" | "SBP" | undefined {
  if (method === "card") return "BANK_CARD";
  if (method === "sbp") return "SBP";
  return undefined;
}

export function shouldUseCardlink(env: BotEnv, method: string): boolean {
  return isCardlinkConfigured(env) && Boolean(cardlinkPaymentMethod(method));
}

export async function createCardlinkBill(
  env: BotEnv,
  input: {
    amount: number;
    orderId: string;
    description: string;
    method: string;
    custom?: string;
  }
): Promise<CardlinkBillResult> {
  const token = env.CARDLINK_API_TOKEN?.trim();
  const shopId = env.CARDLINK_SHOP_ID?.trim();
  if (!token || !shopId) {
    throw new Error("Cardlink не настроен");
  }

  const base = env.WEBAPP_URL?.replace(/\/$/, "") || "";
  const form = new URLSearchParams();
  form.set("amount", String(input.amount));
  form.set("shop_id", shopId);
  form.set("order_id", input.orderId);
  form.set("description", input.description);
  form.set("type", "normal");
  form.set("currency_in", "RUB");
  form.set("locale", "ru");
  form.set("name", "FIX VPN");
  if (input.custom) form.set("custom", input.custom);
  if (env.CARDLINK_PAYER_PAYS_COMMISSION === "1") {
    form.set("payer_pays_commission", "1");
  }
  const panelMethod = cardlinkPaymentMethod(input.method);
  if (panelMethod) form.set("payment_method", panelMethod);
  if (base) {
    form.set("return_url", `${base}/`);
    form.set("success_url", `${base}/api/payment/cardlink/success`);
    form.set("fail_url", `${base}/api/payment/cardlink/fail`);
  }

  const response = await fetch(CARDLINK_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const success = payload.success === true || payload.success === "true";
  if (!response.ok || !success) {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.msg === "string"
          ? payload.msg
          : `Cardlink HTTP ${response.status}`;
    throw new Error(message);
  }

  const linkPageUrl = String(payload.link_page_url || "").trim();
  const billId = String(payload.bill_id || "").trim();
  const linkUrl = String(payload.link_url || linkPageUrl).trim();
  if (!linkPageUrl || !billId) {
    throw new Error("Cardlink: пустой ответ");
  }
  return { billId, linkPageUrl, linkUrl };
}

export function verifyCardlinkPostbackSignature(
  env: BotEnv,
  outSum: string,
  invId: string,
  signatureValue: string
): boolean {
  const token = env.CARDLINK_API_TOKEN?.trim();
  if (!token || !signatureValue) return false;
  const expected = md5HexUpper(`${outSum}:${invId}:${token}`);
  return expected === signatureValue.trim().toUpperCase();
}

export async function parseCardlinkPostback(request: Request): Promise<CardlinkPostback> {
  const contentType = request.headers.get("Content-Type") || "";
  let params: URLSearchParams;
  if (contentType.includes("application/json")) {
    const json = (await request.json()) as Record<string, unknown>;
    params = new URLSearchParams();
    for (const [key, value] of Object.entries(json)) {
      if (value != null) params.set(key, String(value));
    }
  } else {
    const text = await request.text();
    params = new URLSearchParams(text);
  }

  return {
    invId: params.get("InvId") || "",
    outSum: params.get("OutSum") || "",
    status: (params.get("Status") || "").toUpperCase(),
    trsId: params.get("TrsId") || "",
    currencyIn: params.get("CurrencyIn") || "",
    custom: params.get("custom"),
    signatureValue: params.get("SignatureValue") || "",
  };
}

export function cardlinkResultHtml(title: string, body: string): Response {
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e8eef5;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}main{max-width:420px;text-align:center}h1{font-size:1.4rem}p{opacity:.85;line-height:1.5}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
