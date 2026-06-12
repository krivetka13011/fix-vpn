import type { BotEnv } from "../env";
import { partnerBotToken } from "../env";
import {
  addPartnerBalance,
  addRequisite,
  clearSession,
  createPartner,
  createPromoRequest,
  createWithdrawal,
  getDefaultRequisite,
  getPartner,
  getSession,
  listRequisites,
  patchWithdrawal,
  setDefaultRequisite,
  setSession,
} from "../repository";
import type { TelegramUser } from "../telegram";
import { answerCallback, editMessage, sendMessage } from "./telegram-api";
import { managerWithdrawKeyboard, notifyManager } from "./manager";

type TgUpdate = {
  message?: {
    chat: { id: number };
    message_id: number;
    text?: string;
    from?: TelegramUser;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number };
    from: TelegramUser;
  };
};

function partnerMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Баланс и статистика", callback_data: "p:stats" }],
      [{ text: "Мои реквизиты", callback_data: "p:reqs" }],
      [{ text: "Запросить промокод", callback_data: "p:promo" }],
      [{ text: "Вывести средства", callback_data: "p:withdraw" }],
    ],
  };
}

function referralLink(env: BotEnv, partnerId: number): string {
  const clientBot = env.CLIENT_BOT_USERNAME || "FIXVPNfast_bot";
  return `https://t.me/${clientBot}?start=ref_${partnerId}`;
}

async function showPartnerMenu(
  env: BotEnv,
  chatId: number,
  tg: TelegramUser,
  messageId?: number
): Promise<void> {
  const token = partnerBotToken(env)!;
  const partner = await getPartner(env, tg.id);
  if (!partner) {
    await sendMessage(
      token,
      chatId,
      "Добро пожаловать в FIX Partner.\nНажмите «Стать партнером», чтобы начать.",
      {
        inline_keyboard: [[{ text: "Стать партнером", callback_data: "p:register" }]],
      }
    );
    return;
  }
  const text =
    `<b>FIX Partner</b>\n\n` +
    `Реферальная ссылка:\n<code>${referralLink(env, partner.id)}</code>`;
  if (messageId) {
    await editMessage(token, chatId, messageId, text, partnerMenuKeyboard());
  } else {
    await sendMessage(token, chatId, text, partnerMenuKeyboard());
  }
}

export async function handleManagerPartnerCallback(
  env: BotEnv,
  data: string,
  managerId: number
): Promise<string | null> {
  const allowed = (env.MANAGER_TELEGRAM_IDS || env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((part) => Number(part.trim()));
  if (!allowed.includes(managerId)) return "Нет доступа";

  if (data.startsWith("mgr:wd:ok:")) {
    const id = data.slice("mgr:wd:ok:".length);
    await patchWithdrawal(env, id, { status: "approved" });
    return "Вывод отмечен как выплаченный";
  }
  if (data.startsWith("mgr:wd:no:")) {
    const id = data.slice("mgr:wd:no:".length);
    const { getWithdrawal } = await import("../repository");
    const wd = await getWithdrawal(env, id);
    if (wd && wd.status === "pending") {
      await addPartnerBalance(env, Number(wd.partner_id), Number(wd.amount));
      await patchWithdrawal(env, id, { status: "rejected" });
    }
    return "Вывод отклонен";
  }
  return null;
}

export async function handlePartnerBotUpdate(
  env: BotEnv,
  update: TgUpdate
): Promise<void> {
  const token = partnerBotToken(env);
  if (!token) return;

  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || "";
    const chatId = cq.message?.chat.id;
    const messageId = cq.message?.message_id;
    const tg = cq.from;
    if (!chatId || !messageId) return;

    if (data.startsWith("mgr:")) {
      const note = await handleManagerPartnerCallback(env, data, tg.id);
      await answerCallback(token, cq.id, note || undefined);
      return;
    }

    if (data === "p:register") {
      await setSession(env, tg.id, "partner", "reg_name", {});
      await editMessage(token, chatId, messageId, "Введите ваше имя:");
      await answerCallback(token, cq.id);
      return;
    }
    if (data === "p:skip_social") {
      const session = await getSession(env, tg.id, "partner");
      const displayName = String(session?.payload.displayName || tg.first_name || "Partner");
      const partner = await createPartner(env, { ...tg, first_name: displayName }, []);
      await clearSession(env, tg.id, "partner");
      await editMessage(
        token,
        chatId,
        messageId,
        `${env.MSG_PARTNER_REGISTERED || "Вы зарегистрированы."}\n<code>${referralLink(env, partner.id)}</code>`,
        partnerMenuKeyboard()
      );
      await answerCallback(token, cq.id);
      return;
    }
    if (data === "p:stats") {
      const partner = await getPartner(env, tg.id);
      if (!partner) return;
      await editMessage(
        token,
        chatId,
        messageId,
        `<b>Баланс и статистика</b>\n\n` +
          `Рефералов: ${partner.total_referrals}\n` +
          `Ставка: ${partner.commission_percent}%\n` +
          `Баланс: ${partner.balance} ₽`,
        {
          inline_keyboard: [
            [{ text: "Вывести средства", callback_data: "p:withdraw" }],
            [{ text: "Назад", callback_data: "p:menu" }],
          ],
        }
      );
      await answerCallback(token, cq.id);
      return;
    }
    if (data === "p:reqs") {
      const reqs = await listRequisites(env, tg.id);
      const lines = reqs.length
        ? reqs
            .map(
              (row) =>
                `${row.is_default ? "★ " : ""}${row.method.toUpperCase()}: ${row.details}`
            )
            .join("\n")
        : "Реквизиты не добавлены.";
      await editMessage(
        token,
        chatId,
        messageId,
        `<b>Мои реквизиты</b>\n\n${lines}`,
        {
          inline_keyboard: [
            [{ text: "Добавить СБП", callback_data: "p:addreq:sbp" }],
            [{ text: "Добавить карту", callback_data: "p:addreq:card" }],
            ...(reqs.length
              ? reqs.map((row) => [
                  {
                    text: `Сделать основным: ${row.method}`,
                    callback_data: `p:defreq:${row.id}`,
                  },
                ])
              : []),
            [{ text: "Назад", callback_data: "p:menu" }],
          ],
        }
      );
      await answerCallback(token, cq.id);
      return;
    }
    if (data.startsWith("p:addreq:")) {
      const method = data.split(":")[2] as "sbp" | "card";
      await setSession(env, tg.id, "partner", "add_requisite", { method });
      const warn =
        method === "card"
          ? "\n\nВнимание: банк может удержать комиссию при зачислении на карту."
          : "";
      await editMessage(token, chatId, messageId, `Введите реквизиты (${method}):${warn}`);
      await answerCallback(token, cq.id);
      return;
    }
    if (data.startsWith("p:defreq:")) {
      const requisiteId = data.split(":")[2];
      await setDefaultRequisite(env, tg.id, requisiteId);
      await answerCallback(token, cq.id, "Реквизиты по умолчанию обновлены");
      return;
    }
    if (data === "p:promo") {
      await setSession(env, tg.id, "partner", "promo_request", {});
      await editMessage(token, chatId, messageId, "Введите желаемое слово для промокода:");
      await answerCallback(token, cq.id);
      return;
    }
    if (data === "p:withdraw") {
      const partner = await getPartner(env, tg.id);
      if (!partner) return;
      const defaultReq = await getDefaultRequisite(env, tg.id);
      if (!defaultReq) {
        await editMessage(
          token,
          chatId,
          messageId,
          "Сначала добавьте реквизиты в разделе «Мои реквизиты».",
          partnerMenuKeyboard()
        );
        await answerCallback(token, cq.id);
        return;
      }
      await editMessage(
        token,
        chatId,
        messageId,
        `Доступно: <b>${partner.balance} ₽</b>\nВыберите действие:`,
        {
          inline_keyboard: [
            [{ text: "Вывести всё", callback_data: "p:wdall" }],
            [{ text: "Ввести сумму", callback_data: "p:wdamt" }],
            [{ text: "Назад", callback_data: "p:menu" }],
          ],
        }
      );
      await answerCallback(token, cq.id);
      return;
    }
    if (data === "p:wdall") {
      const partner = await getPartner(env, tg.id);
      if (!partner || Number(partner.balance) <= 0) {
        await answerCallback(token, cq.id, "Недостаточно средств");
        return;
      }
      const req = await getDefaultRequisite(env, tg.id);
      if (!req) return;
      await addPartnerBalance(env, tg.id, -Number(partner.balance));
      const wd = await createWithdrawal(env, {
        partner_id: tg.id,
        amount: partner.balance,
        method: req.method,
        details: req.details,
        status: "pending",
      });
      await notifyManager(
        env,
        `Вывод FIX Partner\nПартнер: @${tg.username || "—"} (${tg.id})\n` +
          `Сумма: ${partner.balance} ₽\nМетод: ${req.method}\nРеквизиты: ${req.details}`,
        managerWithdrawKeyboard(wd.id)
      );
      await editMessage(token, chatId, messageId, "Заявка на вывод отправлена менеджеру.");
      await answerCallback(token, cq.id);
      return;
    }
    if (data === "p:wdamt") {
      await setSession(env, tg.id, "partner", "withdraw_amount", {});
      await editMessage(token, chatId, messageId, "Введите сумму вывода в ₽:");
      await answerCallback(token, cq.id);
      return;
    }
    if (data === "p:menu") {
      await showPartnerMenu(env, chatId, tg, messageId);
      await answerCallback(token, cq.id);
      return;
    }
    return;
  }

  const message = update.message;
  if (!message?.from || !message.text) return;
  const tg = message.from;
  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text.startsWith("/start")) {
    await showPartnerMenu(env, chatId, tg);
    return;
  }

  const session = await getSession(env, tg.id, "partner");
  if (!session) return;

  if (session.state === "reg_name") {
    await setSession(env, tg.id, "partner", "reg_social", { displayName: text });
    await sendMessage(
      token,
      chatId,
      "Отправьте ссылку на ресурс (Telegram, TikTok, YouTube, Instagram) или нажмите «Пропустить».",
      {
        inline_keyboard: [[{ text: "Пропустить / Нет ресурса", callback_data: "p:skip_social" }]],
      }
    );
    return;
  }

  if (session.state === "reg_social") {
    const existing = await getPartner(env, tg.id);
    if (existing) {
      await clearSession(env, tg.id, "partner");
      await sendMessage(token, chatId, "Вы уже зарегистрированы как партнёр.", partnerMenuKeyboard());
      return;
    }
    const displayName = String(session.payload.displayName || tg.first_name || "Partner");
    const partner = await createPartner(env, { ...tg, first_name: displayName }, [text]);
    await clearSession(env, tg.id, "partner");
    await sendMessage(
      token,
      chatId,
      `${env.MSG_PARTNER_REGISTERED || "Вы зарегистрированы."}\n<code>${referralLink(env, partner.id)}</code>`,
      partnerMenuKeyboard()
    );
    return;
  }

  if (session.state === "add_requisite") {
    const method = session.payload.method as "sbp" | "card";
    await addRequisite(env, tg.id, method, text, false);
    await clearSession(env, tg.id, "partner");
    await sendMessage(token, chatId, "Реквизиты сохранены.", partnerMenuKeyboard());
    return;
  }

  if (session.state === "promo_request") {
    const req = await createPromoRequest(env, tg.id, text.toUpperCase());
    await clearSession(env, tg.id, "partner");
    await notifyManager(
      env,
      `Запрос промокода\nПартнер: @${tg.username || "—"} (${tg.id})\nКод: ${text.toUpperCase()}\nID: ${req.id}`
    );
    await sendMessage(token, chatId, "Запрос отправлен менеджеру.");
    return;
  }

  if (session.state === "withdraw_amount") {
    const amount = Number(text.replace(",", "."));
    const partner = await getPartner(env, tg.id);
    const req = await getDefaultRequisite(env, tg.id);
    if (!partner || !req || !Number.isFinite(amount) || amount <= 0) {
      await sendMessage(token, chatId, "Некорректная сумма.");
      return;
    }
    if (amount > Number(partner.balance)) {
      await sendMessage(token, chatId, "Сумма больше доступного баланса.");
      return;
    }
    await addPartnerBalance(env, tg.id, -amount);
    const wd = await createWithdrawal(env, {
      partner_id: tg.id,
      amount,
      method: req.method,
      details: req.details,
      status: "pending",
    });
    await clearSession(env, tg.id, "partner");
    await notifyManager(
      env,
      `Вывод FIX Partner\nПартнер: @${tg.username || "—"} (${tg.id})\n` +
        `Сумма: ${amount} ₽\nМетод: ${req.method}\nРеквизиты: ${req.details}`,
      managerWithdrawKeyboard(wd.id)
    );
    await sendMessage(token, chatId, "Заявка на вывод отправлена менеджеру.");
  }
}
