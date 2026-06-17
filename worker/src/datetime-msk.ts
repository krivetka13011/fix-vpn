export const MSK_TIMEZONE = "Europe/Moscow";

/** YYYY-MM-DD в часовом поясе Москвы (для колонки date в Supabase). */
export function formatMskDateOnly(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MSK_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** Дата и время с точностью до минут, МСК. */
export function formatMskDateTime(ms: number): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: MSK_TIMEZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

/** Короткая дата+время для подписи клиента в панели (ДД.ММ.ГГГГ ЧЧ:ММ). */
export function formatMskShortDateTime(ms: number): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: MSK_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("day")}.${pick("month")}.${pick("year")} ${pick("hour")}:${pick("minute")}`;
}

export function formatSubscriptionPeriodMsk(input: {
  startsAt?: string | null;
  endsAt?: string | null;
  expiresAt?: string | null;
  purchasedAt?: string | null;
  planLabel?: string | null;
  durationMs?: number;
}): string {
  const expiresMs = input.expiresAt
    ? new Date(input.expiresAt).getTime()
    : NaN;

  if (Number.isFinite(expiresMs)) {
    const purchasedMs = input.purchasedAt
      ? new Date(input.purchasedAt).getTime()
      : NaN;
    const startMs = Number.isFinite(purchasedMs)
      ? purchasedMs
      : input.durationMs && input.durationMs > 0
        ? expiresMs - input.durationMs
        : input.startsAt
          ? new Date(`${input.startsAt}T00:00:00+03:00`).getTime()
          : expiresMs - 5 * 60 * 1000;

    if (Number.isFinite(startMs)) {
      return `${formatMskDateTime(startMs)} — ${formatMskDateTime(expiresMs)} МСК`;
    }
    return `до ${formatMskDateTime(expiresMs)} МСК`;
  }

  if (input.startsAt && input.endsAt) {
    const start = new Date(`${input.startsAt}T00:00:00+03:00`);
    const end = new Date(`${input.endsAt}T23:59:59+03:00`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      return `${formatMskDateTime(start.getTime())} — ${formatMskDateTime(end.getTime())} МСК`;
    }
  }

  if (input.endsAt) {
    const end = new Date(`${input.endsAt}T23:59:59+03:00`);
    if (!Number.isNaN(end.getTime())) {
      return `до ${formatMskDateTime(end.getTime())} МСК`;
    }
  }

  return input.planLabel?.trim() || "—";
}
