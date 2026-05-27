export type PlanMonths = 1 | 3 | 6 | 12;

export type SubscriptionStatus = "none" | "active" | "expired";

export interface Subscription {
  status: SubscriptionStatus;
  planMonths: PlanMonths | null;
  planLabel: string | null;
  startsAt: string | null;
  endsAt: string | null;
  vpnKey: string | null;
}

export interface UserRecord {
  telegramId: number;
  username: string | null;
  displayName: string;
  photoUrl: string | null;
  subscription: Subscription;
  updatedAt: string;
}

export const PLANS: Record<
  PlanMonths,
  { label: string; priceRub: number; badge?: string }
> = {
  1: { label: "1 месяц", priceRub: 199 },
  3: { label: "3 месяца", priceRub: 499, badge: "−15%" },
  6: { label: "6 месяцев", priceRub: 899, badge: "−25%" },
  12: { label: "1 год", priceRub: 1499, badge: "Лучшая цена" },
};

export function emptySubscription(): Subscription {
  return {
    status: "none",
    planMonths: null,
    planLabel: null,
    startsAt: null,
    endsAt: null,
    vpnKey: null,
  };
}

export function defaultUser(
  telegramId: number,
  displayName: string,
  username: string | null,
  photoUrl: string | null
): UserRecord {
  return {
    telegramId,
    username,
    displayName,
    photoUrl,
    subscription: emptySubscription(),
    updatedAt: new Date().toISOString(),
  };
}
