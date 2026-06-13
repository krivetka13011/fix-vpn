import type { DbSubscription } from "./types";
/** Panel limitIp: simultaneous distinct IPs allowed for this subscription. 0 = unlimited. */
export function subscriptionDeviceLimit(
  sub: Pick<DbSubscription, "plan_type" | "extra_devices"> | null | undefined
): number {
  if (!sub) return 1;
  if (sub.plan_type === "personal") return 0;
  return 1 + Number(sub.extra_devices || 0);
}

export function isPanelIpClearPending(
  sub: Pick<DbSubscription, "panel_ip_clear_requested_at"> | null | undefined,
  maxAgeMs = 10 * 60 * 1000
): boolean {
  const raw = sub?.panel_ip_clear_requested_at;
  if (!raw) return false;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < maxAgeMs;
}
