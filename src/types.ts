export type PlanType = "basic" | "personal";
export type BillingMonths = 1 | 3 | 6 | 12;
export type SubscriptionStatus = "none" | "active" | "expired";

export interface Subscription {
  status: SubscriptionStatus;
  planType: PlanType | null;
  planLabel: string | null;
  billingMonths: number | null;
  startsAt: string | null;
  endsAt: string | null;
  purchasedAt: string | null;
  vpnKey: string | null;
  extraDevices: number;
  deviceTotal: number | null;
}

export interface UserAddon {
  id: string;
  type: string;
  label: string;
  quantity: number;
  priceRub: number;
  purchasedAt: string;
}

export interface UserProfile {
  id: number;
  publicId: string;
  displayName: string;
  username: string | null;
  photoUrl: string | null;
  subscription: Subscription;
  addons: UserAddon[];
}

export interface Tariff {
  id: PlanType;
  name: string;
  subtitle: string;
  includedDevices: number | null;
  periods: Record<BillingMonths, number>;
}

export interface Catalog {
  tariffs: Tariff[];
  extraDevicePricePerMonth: number;
  supportTelegramId: number;
  billingMonths: BillingMonths[];
}

export type TabId = "instructions" | "plans" | "support" | "profile";
