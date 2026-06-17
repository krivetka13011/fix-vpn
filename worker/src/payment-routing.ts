import type { BotEnv } from "./env";
import {
  isPlategaConfigured,
  plategaPaymentMethod,
} from "./platega";

export type PaymentBackend = "platega" | "manual";

/** Оплата только через Platega (Cardlink не используется). */
export function resolvePaymentBackend(env: BotEnv, method: string): PaymentBackend {
  if (plategaPaymentMethod(method) !== undefined && isPlategaConfigured(env)) {
    return "platega";
  }
  return "manual";
}
