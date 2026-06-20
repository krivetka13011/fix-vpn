import type { Catalog, UserProfile } from "../types";
import type { BillingMonths, PlanType } from "../types";

const API_TIMEOUT_MS = 12000;
const SLOW_API_TIMEOUT_MS = 45000;

function initDataHeader(): HeadersInit {
  const initData = window.Telegram?.WebApp?.initData ?? "";
  return {
    "Content-Type": "application/json",
    "X-Telegram-Init-Data": initData,
  };
}

async function api<T>(
  path: string,
  options?: RequestInit,
  timeoutMs = API_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      ...options,
      signal: controller.signal,
      headers: { ...initDataHeader(), ...options?.headers },
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function fetchCatalog(): Promise<Catalog> {
  return api("/api/catalog");
}

export function fetchMe(): Promise<{ user: UserProfile }> {
  return api("/api/me");
}

export function purchasePlan(payload: {
  planType: PlanType;
  billingMonths: BillingMonths;
  extraDevices: number;
  paymentMethod?: "sbp" | "crypto_usdt";
}): Promise<{
  ok: boolean;
  paymentUrl: string;
  amount: number;
  message: string;
}> {
  return api("/api/purchase", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function activateTrial(): Promise<{
  ok: boolean;
  message: string;
  user: UserProfile;
}> {
  return api("/api/trial", { method: "POST", body: "{}" }, SLOW_API_TIMEOUT_MS);
}

export function fetchConnect(
  platform: string,
  client: string
): Promise<{
  ok: boolean;
  connectUrl: string;
  subUrl: string;
  subId: string;
  redirectUrl: string;
}> {
  const params = new URLSearchParams({ platform, client });
  return api(`/api/connect?${params.toString()}`, undefined, SLOW_API_TIMEOUT_MS);
}

export function resetDevices(): Promise<{
  ok: boolean;
  message?: string;
  user?: UserProfile;
}> {
  return api("/api/devices/reset", { method: "POST", body: "{}" }, SLOW_API_TIMEOUT_MS);
}

export function purchaseDevices(extraDevices: number): Promise<{
  ok: boolean;
  paymentUrl: string;
  amount: number;
  message: string;
}> {
  return api("/api/purchase-devices", {
    method: "POST",
    body: JSON.stringify({ extraDevices }),
  });
}
