import type { Plan, UserProfile } from "../types";

const API_TIMEOUT_MS = 8000;

function initDataHeader(): HeadersInit {
  const initData = window.Telegram?.WebApp?.initData ?? "";
  return {
    "Content-Type": "application/json",
    "X-Telegram-Init-Data": initData,
  };
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
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
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

export function fetchMe(): Promise<{ user: UserProfile }> {
  return api("/api/me");
}

export function fetchPlans(): Promise<{ plans: Plan[] }> {
  return api("/api/plans");
}

export function purchasePlan(planMonths: number): Promise<{
  ok: boolean;
  message: string;
  subscription: UserProfile["subscription"];
}> {
  return api("/api/purchase", {
    method: "POST",
    body: JSON.stringify({ planMonths }),
  });
}
