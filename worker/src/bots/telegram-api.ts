import { isE2eDryRun, recordE2eTrace } from "../e2e-trace";

export async function tgCall<T = Record<string, unknown>>(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<T> {
  recordE2eTrace(method, body);
  if (isE2eDryRun()) {
    return { ok: true, result: {} } as T & { ok?: boolean };
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { ok?: boolean; description?: string };
  if (!payload.ok) {
    throw new Error(payload.description || `telegram ${method} failed`);
  }
  return payload;
}

export async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>
): Promise<void> {
  await tgCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
    parse_mode: "HTML",
  });
}

export async function editMessage(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: Record<string, unknown>
): Promise<void> {
  await tgCall(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: replyMarkup,
    parse_mode: "HTML",
  });
}

export async function answerCallback(
  token: string,
  callbackQueryId: string,
  text?: string,
  options?: { url?: string; showAlert?: boolean }
): Promise<void> {
  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId,
  };
  if (text) {
    body.text = text;
    body.show_alert = options?.showAlert ?? text.length > 40;
  }
  if (options?.url) {
    body.url = options.url;
  }
  await tgCall(token, "answerCallbackQuery", body);
}

export async function forwardMessage(
  token: string,
  chatId: number,
  fromChatId: number,
  messageId: number
): Promise<{ message_id: number }> {
  const payload = await tgCall<{ result: { message_id: number } }>(
    token,
    "forwardMessage",
    {
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    }
  );
  return payload.result;
}
