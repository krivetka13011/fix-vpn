import type { BillingMonths, PlanType } from "./catalog";

export type SubscriptionStatus = "none" | "active" | "expired";

export interface DbUser {
  id: string;
  telegram_id: number;
  username: string | null;
  display_name: string;
  photo_url: string | null;
  has_used_trial?: boolean;
  is_tester?: boolean;
  ref_by_partner_id?: number | null;
  first_payment_done?: boolean;
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
  xray_uuid?: string | null;
  xray_sub_id?: string | null;
  subscription_url?: string | null;
  subscription_payload_cache?: string | null;
  client_email?: string | null;
  is_trial?: boolean;
  extra_devices: number;
  purchased_at: string | null;
  panel_ip_clear_requested_at?: string | null;
  last_device_reset?: string | null;
  pending_xray_sub_id?: string | null;
  panel_sub_rotate_requested_at?: string | null;
  expires_at?: string | null;
  expiry_warned_at?: string | null;
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
