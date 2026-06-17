import { clientBotToken, type BotEnv } from "./env";
import { sendMessage } from "./bots/telegram-api";
import { sbJson, sbRequest } from "./supabase";
import { patchSubscription } from "./repository";
import { XuiApi } from "./xui";
import { telegramIdFromClientEmail } from "./device-limit";

type ExpiringRow = {
  id: string;
  user_id: string;
  plan_type: string;
  is_trial: boolean;
  expires_at: string;
  users: { telegram_id: number } | Array<{ telegram_id: number }>;
};

function telegramIdFromRow(row: ExpiringRow): number | null {
  const users = row.users;
  if (Array.isArray(users)) return users[0]?.telegram_id ?? null;
  return users?.telegram_id ?? null;
}

async function fetchExpiringRows(
  env: BotEnv,
  params: Record<string, string>
): Promise<ExpiringRow[]> {
  const search = new URLSearchParams({
    status: "eq.active",
    expires_at: "not.is.null",
    select: "id,user_id,plan_type,is_trial,expires_at,users!inner(telegram_id)",
    ...params,
  });
  return sbJson<ExpiringRow[]>(
    await sbRequest(env, `subscriptions?${search.toString()}`)
  );
}

export async function runSubscriptionExpiryJobs(env: BotEnv): Promise<void> {
  const token = clientBotToken(env);
  if (!token) return;

  const now = Date.now();
  const warnBeforeMs = 60_000;

  const warnRows = await fetchExpiringRows(env, {
    expiry_warned_at: "is.null",
    expires_at: `gt.${new Date(now).toISOString()}`,
    order: "expires_at.asc",
  });

  for (const row of warnRows) {
    const expiresMs = new Date(row.expires_at).getTime();
    if (!Number.isFinite(expiresMs)) continue;
    const msLeft = expiresMs - now;
    if (msLeft > warnBeforeMs || msLeft <= 0) continue;

    const chatId = telegramIdFromRow(row);
    if (!chatId) continue;

    try {
      await sendMessage(
        token,
        chatId,
        row.is_trial
          ? "⏳ Через минуту закончится пробный период.\n\n" +
              "Оформите подписку, чтобы продолжить:"
          : "⏳ Через минуту закончится подписка.\n\n" +
              "Продлите сейчас, чтобы не потерять доступ:",
        {
          inline_keyboard: [
            [{ text: "💳 Оформить подписку", callback_data: "c:buy" }],
            [{ text: "👤 Мой профиль", callback_data: "c:profile" }],
          ],
        }
      );
      await patchSubscription(env, row.user_id, {
        expiry_warned_at: new Date().toISOString(),
      });
    } catch (error) {
      console.error("expiry warn:", row.user_id, error);
    }
  }

  const expiredRows = await fetchExpiringRows(env, {
    expires_at: `lt.${new Date(now).toISOString()}`,
    order: "expires_at.asc",
  });

  for (const row of expiredRows) {
    try {
      await patchSubscription(env, row.user_id, {
        status: "expired",
      });
      const chatId = telegramIdFromRow(row);
      if (chatId) {
        try {
          const xui = new XuiApi(env);
          await xui.expireClientAccess(chatId);
        } catch (panelError) {
          console.error("expiry panel disable:", row.user_id, panelError);
        }
      }
      if (!chatId) continue;
      await sendMessage(
        token,
        chatId,
        row.is_trial
          ? "Пробный период завершён.\n\nОформите подписку, чтобы продолжить пользоваться FIX VPN:"
          : "Подписка завершена.\n\nПродлите доступ в боте:",
        {
          inline_keyboard: [
            [{ text: "💳 Оформить подписку", callback_data: "c:buy" }],
          ],
        }
      );
    } catch (error) {
      console.error("expiry close:", row.user_id, error);
    }
  }
}
