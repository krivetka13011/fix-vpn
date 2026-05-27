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

export interface UserProfile {
  id: number;
  displayName: string;
  username: string | null;
  photoUrl: string | null;
  subscription: Subscription;
}

export interface Plan {
  months: PlanMonths;
  label: string;
  priceRub: number;
  badge?: string;
}

export type TabId = "home" | "subscriptions" | "profile";
