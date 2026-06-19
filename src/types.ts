export type PlanType = "basic" | "personal";
export type BillingMonths = 1 | 2 | 3 | 6 | 12;
export type SubscriptionStatus = "none" | "active" | "expired";
export type DevicePlatform = "android" | "ios" | "windows" | "mac";
export type VpnClientId = "happ" | "v2raytun" | "hiddify";

export interface DeviceBinding {
  id: string;
  label: string;
  os: string;
  client: string;
  lastSeenAt: string;
  online: boolean;
}

export interface Subscription {
  status: SubscriptionStatus;
  planType: PlanType | null;
  planLabel: string | null;
  billingMonths: number | null;
  startsAt: string | null;
  endsAt: string | null;
  purchasedAt: string | null;
  extraDevices: number;
  deviceTotal: number | null;
  isTrial?: boolean;
  canConnect?: boolean;
  connectBlockReason?: string | null;
  periodText?: string | null;
  devicesUsed?: number;
  devicesMax?: number;
  panelOnline?: boolean;
  devices?: DeviceBinding[];
  canAddDevices?: boolean;
  hasClient?: boolean;
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
  displayName: string;
  username: string | null;
  photoUrl: string | null;
  subscription: Subscription;
  addons: UserAddon[];
  trialAvailable?: boolean;
}

export interface Tariff {
  id: PlanType;
  name: string;
  subtitle: string;
  includedDevices: number | null;
  speedMbps: number | null;
  features: string[];
  periods: Record<BillingMonths, number>;
}

export interface Catalog {
  tariffs: Tariff[];
  extraDevicePricePerMonth: number;
  supportTelegramUsername: string;
  telegramChannelUrl: string;
  billingMonths: BillingMonths[];
  testMode?: boolean;
  testCheckoutPriceRub?: number | null;
  testSubscriptionMinutes?: number | null;
  trialDurationMinutes?: number | null;
}

export type TabId = "help" | "plans" | "profile";
