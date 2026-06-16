/** Ключ клиента в нашей БД — всегда Telegram ID. */
export function canonicalClientKey(telegramId: number): string {
  return String(telegramId);
}

/** Имя клиента в 3X-UI (поле email в UI панели). */
export function panelDisplayLabel(
  username: string | null | undefined,
  displayName: string | null | undefined,
  telegramId: number
): string {
  const handle = username?.trim().replace(/^@+/, "");
  if (handle) return `@${handle}`;

  const name = displayName?.trim().replace(/\s+/g, " ").slice(0, 48);
  if (name) return `${name} · ${telegramId}`;

  return String(telegramId);
}
