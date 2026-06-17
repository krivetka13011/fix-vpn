/** Ключ клиента в нашей БД — всегда Telegram ID. */
export function canonicalClientKey(telegramId: number): string {
  return String(telegramId);
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

/** Имя клиента в 3X-UI (поле email в UI панели). По умолчанию слот 1: @username-1 */
export function panelDisplayLabel(
  username: string | null | undefined,
  displayName: string | null | undefined,
  telegramId: number,
  options?: { slot?: number }
): string {
  const slot = options?.slot ?? 1;
  if (slot > 0) {
    return panelDeviceSlotLabel(username, telegramId, slot);
  }
  const handle = username?.trim().replace(/^@+/, "");
  if (handle) return `@${handle}`;
  const name = displayName?.trim().replace(/\s+/g, " ").slice(0, 48);
  return name ? `${name} · ${telegramId}` : String(telegramId);
}

export function deviceSlotDisplayName(
  username: string | null | undefined,
  telegramId: number,
  slot: number
): string {
  return panelDeviceSlotLabel(username, telegramId, slot);
}
