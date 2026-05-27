import type { Plan, UserProfile } from "../types";

function initDataHeader(): HeadersInit {
  const initData = window.Telegram?.WebApp?.initData ?? "";
  return {
    "Content-Type": "application/json",
    "X-Telegram-Init-Data": initData,
  };
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: { ...initDataHeader(), ...options?.headers },
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
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
