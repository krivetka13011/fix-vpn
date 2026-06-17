/** Ключ клиента в нашей БД — всегда Telegram ID. */
export function canonicalClientKey(telegramId: number): string {
  return String(telegramId);
}

function formatExpiryShort(expiryMs: number): string {
  return new Date(expiryMs).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** Имя слота устройства в панели: @username-1, @username-2 … */
export function panelDeviceSlotLabel(
  username: string | null | undefined,
  telegramId: number,
  slot: number
): string {
  const handle = username?.trim().replace(/^@+/, "");
  if (handle) return `@${handle}-${slot}`;
  return `${telegramId}-${slot}`;
}

/** Имя клиента в 3X-UI (поле email в UI панели). */
export function panelDisplayLabel(
  username: string | null | undefined,
  displayName: string | null | undefined,
  telegramId: number,
  options?: { expiryMs?: number; slot?: number }
): string {
  const slot = options?.slot;
  let base: string;
  if (slot && slot > 0) {
    base = panelDeviceSlotLabel(username, telegramId, slot);
  } else {
    const handle = username?.trim().replace(/^@+/, "");
    if (handle) base = `@${handle}`;
    else {
      const name = displayName?.trim().replace(/\s+/g, " ").slice(0, 48);
      base = name ? `${name} · ${telegramId}` : String(telegramId);
    }
  }

  if (options?.expiryMs && options.expiryMs > Date.now()) {
    return `${base} · до ${formatExpiryShort(options.expiryMs)}`;
  }
  return base;
}

export function deviceSlotDisplayName(
  username: string | null | undefined,
  telegramId: number,
  slot: number,
  ip?: string
): string {
  const label = panelDeviceSlotLabel(username, telegramId, slot);
  return ip ? `${label} (${ip})` : label;
}
