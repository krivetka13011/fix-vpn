import type { BotEnv } from "../env";
import { clientBotToken, managerChatId } from "../env";
import { sendMessage } from "./telegram-api";

export async function notifyManager(
  env: BotEnv,
  text: string,
  replyMarkup?: Record<string, unknown>
): Promise<void> {
  const token = clientBotToken(env);
  const chatId = managerChatId(env);
  if (!token || !chatId) return;
  await sendMessage(token, chatId, text, replyMarkup);
}

export function managerTxnKeyboard(txnId: string) {
  return {
    inline_keyboard: [
      [
        { text: "Подтвердить", callback_data: `mgr:txn:ok:${txnId}` },
        { text: "Отклонить", callback_data: `mgr:txn:no:${txnId}` },
      ],
    ],
  };
}

export function managerWithdrawKeyboard(withdrawalId: string) {
  return {
    inline_keyboard: [
      [
        { text: "Выплатить через Cardlink", callback_data: `mgr:wd:ok:${withdrawalId}` },
        { text: "Отклонить", callback_data: `mgr:wd:no:${withdrawalId}` },
      ],
    ],
  };
}
