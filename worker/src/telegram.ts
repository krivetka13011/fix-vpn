export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  language_code?: string;
}

export interface InitDataUser {
  user: TelegramUser;
  auth_date: number;
  hash: string;
}

/** Проверка подписи initData от Telegram Web App */
export async function validateInitData(
  initData: string,
  botToken: string
): Promise<InitDataUser | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  params.delete("hash");
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

  const webAppKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const secretRaw = await crypto.subtle.sign(
    "HMAC",
    webAppKey,
    new TextEncoder().encode(botToken)
  );

  const secretKey = await crypto.subtle.importKey(
    "raw",
    secretRaw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    secretKey,
    new TextEncoder().encode(dataCheckString)
  );

  const calculated = [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (calculated !== hash) return null;

  const authDate = Number(params.get("auth_date") ?? 0);
  const maxAge = 86400;
  if (Date.now() / 1000 - authDate > maxAge) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;

  const user = JSON.parse(userRaw) as TelegramUser;
  return { user, auth_date: authDate, hash };
}

export function displayName(user: TelegramUser): string {
  const parts = [user.first_name, user.last_name].filter(Boolean);
  return parts.join(" ") || user.username || `ID ${user.id}`;
}
