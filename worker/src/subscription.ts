import type { Subscription } from "./types";

export function applySubscriptionExpiry(sub: Subscription): Subscription {
  if (sub.status !== "active" || !sub.endsAt) return sub;
  const end = new Date(`${sub.endsAt}T23:59:59`);
  if (end < new Date()) {
    return { ...sub, status: "expired" };
  }
  return sub;
}
