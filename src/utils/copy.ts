export function copyText(text: string) {
  navigator.clipboard?.writeText(text);
  window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
}

export function formatRuDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function openSupportChat(telegramId: number) {
  const tg = window.Telegram?.WebApp;
  const url = `https://t.me/user?id=${telegramId}`;
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(url);
  } else {
    window.open(url, "_blank");
  }
}
