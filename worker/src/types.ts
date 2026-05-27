import type { BillingMonths, PlanType } from "./catalog";

export type SubscriptionStatus = "none" | "active" | "expired";

export interface DbUser {
  id: string;
  telegram_id: number;
  username: string | null;
  display_name: string;
  photo_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbSubscription {
  id: string;
  user_id: string;
  plan_type: PlanType | "none";
  status: SubscriptionStatus;
  plan_label: string | null;
  billing_months: number | null;
  starts_at: string | null;
  ends_at: string | null;
  vpn_key: string | null;
  extra_devices: number;
  purchased_at: string | null;
  updated_at: string;
}

export interface DbAddon {
  id: string;
  user_id: string;
  addon_type: string;
  label: string;
  quantity: number;
  price_rub: number;
  purchased_at: string;
}

export interface UserBundle {
  user: DbUser;
  subscription: DbSubscription;
  addons: DbAddon[];
}
