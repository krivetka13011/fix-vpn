import type { BotEnv } from "./env";
import {
  cardlinkPaymentMethod,
  isCardlinkConfigured,
} from "./cardlink";
import {
  isPlategaConfigured,
  plategaPaymentMethod,
} from "./platega";

export type PaymentBackend = "cardlink" | "platega" | "manual";

/** Cardlink first for СБП/карта — стабильнее при неверном Platega merchant id. */
export function resolvePaymentBackend(env: BotEnv, method: string): PaymentBackend {
  if (cardlinkPaymentMethod(method) && isCardlinkConfigured(env)) {
    return "cardlink";
  }
  if (plategaPaymentMethod(method) !== undefined && isPlategaConfigured(env)) {
    return "platega";
  }
  return "manual";
}
