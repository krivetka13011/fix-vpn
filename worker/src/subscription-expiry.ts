import { clientBotToken, type BotEnv } from "./env";
import { sendMessage } from "./bots/telegram-api";
import { d1All } from "./d1-db";
import { patchSubscription, patchUser, kvClearSubscriptionPayloadCache } from "./repository";
import { XuiApi } from "./xui";

type ExpiringRow = {
  id: string;
  user_id: string;
  plan_type: string;
  is_trial: number | boolean;
  expires_at: string;
  telegram_id: number;
};

async function fetchExpiringRows(
  env: BotEnv,
  extraWhere: string,
  extraParams: unknown[] = []
): Promise<ExpiringRow[]> {
  return d1All<ExpiringRow>(
    env.DB,
    `SELECT s.id, s.user_id, s.plan_type, s.is_trial, s.expires_at, u.telegram_id
     FROM subscriptions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.status = 'active'
       AND s.expires_at IS NOT NULL
       ${extraWhere}`,
    ...extraParams
  );
}

export async function runSubscriptionExpiryJobs(env: BotEnv): Promise<void> {
  const token = clientBotToken(env);
  if (!token) return;

  const now = Date.now();
  const warnBeforeMs = 60_000;

  const warnRows = await fetchExpiringRows(
    env,
    "AND s.expiry_warned_at IS NULL AND s.expires_at > ? ORDER BY s.expires_at ASC",
    [new Date(now).toISOString()]
  );

  for (const row of warnRows) {
    const expiresMs = new Date(row.expires_at).getTime();
    if (!Number.isFinite(expiresMs)) continue;
    const msLeft = expiresMs - now;
    if (msLeft > warnBeforeMs || msLeft <= 0) continue;

    const chatId = row.telegram_id;
    if (!chatId) continue;

    const isTrial = row.is_trial === 1 || row.is_trial === true;
    try {
      await sendMessage(
        token,
        chatId,
        isTrial
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

  const expiredRows = await fetchExpiringRows(
    env,
    "AND s.expires_at < ? ORDER BY s.expires_at ASC",
    [new Date(now).toISOString()]
  );

  for (const row of expiredRows) {
    try {
      const isTrial = row.is_trial === 1 || row.is_trial === true;
      await patchSubscription(env, row.user_id, {
        status: "expired",
      });
      if (isTrial) {
        await patchUser(env, row.user_id, { has_used_trial: true });
      }
      await kvClearSubscriptionPayloadCache(env, row.user_id);
      const chatId = row.telegram_id;
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
        isTrial
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
