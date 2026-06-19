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

export function openSupportChat(username: string) {
  const handle = username.replace(/^@/, "");
  openTelegramLink(`https://t.me/${handle}`);
}

export function openTelegramLink(url: string) {
  const tg = window.Telegram?.WebApp;
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(url);
  } else if (tg?.openLink) {
    tg.openLink(url);
  } else {
    window.open(url, "_blank");
  }
}

export function openExternalLink(url: string) {
  const tg = window.Telegram?.WebApp;
  if (tg?.openLink) {
    try {
      tg.openLink(url, { try_browser: true });
      return;
    } catch {
      tg.openLink(url);
      return;
    }
  }
  window.open(url, "_blank");
}
