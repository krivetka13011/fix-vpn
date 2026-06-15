import type { BotEnv } from "../env";
import { partnerBotToken } from "../env";
import {
  addRequisite,
  clearSession,
  createPartner,
  createPromoRequest,
  getDefaultRequisite,
  getPartner,
  getSession,
  listRequisites,
  setDefaultRequisite,
  setSession,
} from "../repository";
import {
  approveWithdrawalWithCardlink,
  rejectWithdrawal,
  submitPartnerWithdrawal,
} from "../partner-withdrawal";
import type { TelegramUser } from "../telegram";
import { answerCallback, editMessage, sendMessage } from "./telegram-api";
import { notifyManager } from "./manager";
import { sbpBankKeyboard, sbpBankLabel } from "../sbp-banks";

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

function backRow(callback = "p:menu"): Array<Record<string, string>> {
  return [{ text: "← Назад", callback_data: callback }];
}

function partnerMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "💰 Баланс и статистика", callback_data: "p:stats" }],
      [{ text: "💳 Мои реквизиты", callback_data: "p:reqs" }],
      [{ text: "🎟 Запросить промокод", callback_data: "p:promo" }],
      [{ text: "🏧 Вывести бабки", callback_data: "p:withdraw" }],
    ],
  };
}

function cancelKeyboard(backCallback = "p:menu") {
  return {
    inline_keyboard: [backRow(backCallback)],
  };
}

function referralLink(env: BotEnv, partnerId: number): string {
  const clientBot = env.CLIENT_BOT_USERNAME || "FIXVPNfast_bot";
  return `https://t.me/${clientBot}?start=ref_${partnerId}`;
}

function partnerWelcomeText(env: BotEnv, partner: { id: number; balance: number | string }): string {
  return (
    `🚀 <b>FIX Partner</b>\n\n` +
    `Привет! Ты в партнёрке — кидай ссылку друзьям, получай процент с оплат.\n\n` +
    `🔗 Твоя ссылка:\n<code>${referralLink(env, partner.id)}</code>\n\n` +
    `💵 На балансе: <b>${partner.balance} ₽</b>`
  );
}

function guestWelcomeText(): string {
  return (
    `🚀 <b>FIX Partner</b>\n\n` +
    `Хочешь зарабатывать с VPN без напряга?\n` +
    `Регистрируйся — дам личную ссылку и будем делить профит 🤝`
  );
}

function statsText(partner: {
  total_referrals: number;
  commission_percent: number;
  balance: number | string;
}): string {
  return (
    `📊 <b>Баланс и статистика</b>\n\n` +
    `👥 Рефералов: <b>${partner.total_referrals}</b>\n` +
    `📈 Твоя ставка: <b>${partner.commission_percent}%</b>\n` +
    `💰 Баланс: <b>${partner.balance} ₽</b>\n\n` +
    `Чем больше народу по твоей ссылке — тем веселее цифры 🎯`
  );
}

function requisitesText(
  reqs: Array<{ method: string; details: string; is_default: boolean; sbp_bank_id?: string | null }>
): string {
  if (!reqs.length) {
    return (
      `💳 <b>Мои реквизиты</b>\n\n` +
      `Укажи СБП или карту — сюда уйдут выплаты через Cardlink 🏧`
    );
  }
  const lines = reqs
    .map((row) => {
      const icon = row.method === "sbp" ? "📱" : "💳";
      const star = row.is_default ? "⭐ " : "";
      const bank = row.method === "sbp" ? sbpBankLabel(row.sbp_bank_id) : null;
      const bankSuffix = bank ? ` (${bank})` : "";
      return `${star}${icon} <b>${row.method.toUpperCase()}</b>${bankSuffix}: <code>${row.details}</code>`;
    })
    .join("\n");
  return `💳 <b>Мои реквизиты</b>\n\n${lines}\n\n⭐ — куда уходит вывод через Cardlink`;
}

function requisitesKeyboard(
  reqs: Array<{ id: string; method: string }>
): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: "➕ Добавить СБП", callback_data: "p:addreq:sbp" }],
      [{ text: "➕ Добавить карту", callback_data: "p:addreq:card" }],
      ...(reqs.length
        ? reqs.map((row) => [
            {
              text: `⭐ Сделать основным: ${row.method.toUpperCase()}`,
              callback_data: `p:defreq:${row.id}`,
            },
          ])
        : []),
      backRow(),
    ],
  };
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
    const markup = {
      inline_keyboard: [[{ text: "🤝 Стать партнёром", callback_data: "p:register" }]],
    };
    if (messageId) {
      await editMessage(token, chatId, messageId, guestWelcomeText(), markup);
    } else {
      await sendMessage(token, chatId, guestWelcomeText(), markup);
    }
    return;
  }
  const text = partnerWelcomeText(env, partner);
  if (messageId) {
    await editMessage(token, chatId, messageId, text, partnerMenuKeyboard());
  } else {
    await sendMessage(token, chatId, text, partnerMenuKeyboard());
  }
}

async function showRequisites(
  env: BotEnv,
  chatId: number,
  tg: TelegramUser,
  messageId: number
): Promise<void> {
  const token = partnerBotToken(env)!;
  const reqs = await listRequisites(env, tg.id);
  await editMessage(
    token,
    chatId,
    messageId,
    requisitesText(reqs),
    requisitesKeyboard(reqs)
  );
}

async function cancelPartnerFlow(
  env: BotEnv,
  chatId: number,
  tg: TelegramUser,
  messageId?: number
): Promise<void> {
  await clearSession(env, tg.id, "partner");
  await showPartnerMenu(env, chatId, tg, messageId);
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
    return approveWithdrawalWithCardlink(env, id);
  }
  if (data.startsWith("mgr:wd:no:")) {
    const id = data.slice("mgr:wd:no:".length);
    await rejectWithdrawal(env, id);
    return "Вывод отклонен, баланс возвращён";
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

    if (data === "p:menu" || data === "p:cancel") {
      await cancelPartnerFlow(env, chatId, tg, messageId);
      await answerCallback(token, cq.id);
      return;
    }

    if (data === "p:register") {
      await setSession(env, tg.id, "partner", "reg_name", {});
      await editMessage(
        token,
        chatId,
        messageId,
        `📝 <b>Регистрация</b>\n\nКак тебя подписать в партнёрке?\nНапиши имя или ник одним сообщением 👇`,
        cancelKeyboard()
      );
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
        `🎉 <b>Готово, ты в деле!</b>\n\n` +
          `${env.MSG_PARTNER_REGISTERED || "Вот твоя реферальная ссылка:"}\n` +
          `<code>${referralLink(env, partner.id)}</code>\n\n` +
          `Кидай её куда хочешь — мы посчитаем профит 💸`,
        partnerMenuKeyboard()
      );
      await answerCallback(token, cq.id);
      return;
    }

    if (data === "p:stats") {
      const partner = await getPartner(env, tg.id);
      if (!partner) return;
      await editMessage(token, chatId, messageId, statsText(partner), {
        inline_keyboard: [
          [{ text: "🏧 Вывести бабки", callback_data: "p:withdraw" }],
          backRow(),
        ],
      });
      await answerCallback(token, cq.id);
      return;
    }

    if (data === "p:reqs") {
      await showRequisites(env, chatId, tg, messageId);
      await answerCallback(token, cq.id);
      return;
    }

    if (data.startsWith("p:addreq:")) {
      const method = data.split(":")[2] as "sbp" | "card";
      if (method === "sbp") {
        await setSession(env, tg.id, "partner", "add_requisite_sbp_phone", {});
        await editMessage(
          token,
          chatId,
          messageId,
          `✍️ <b>СБП</b>\n\n` +
            `Отправь номер телефона, привязанный к СБП — на него уйдёт выплата через Cardlink 📱`,
          cancelKeyboard("p:reqs")
        );
      } else {
        await setSession(env, tg.id, "partner", "add_requisite", { method });
        await editMessage(
          token,
          chatId,
          messageId,
          `✍️ <b>Карта</b>\n\n` +
            `Отправь номер карты одним сообщением.\n` +
            `Выплата пойдёт через Cardlink на эту карту 💳\n\n` +
            `⚠️ Банк может взять свою комиссию — мы со своей стороны не дерём.`,
          cancelKeyboard("p:reqs")
        );
      }
      await answerCallback(token, cq.id);
      return;
    }

    if (data.startsWith("p:sbpbank:")) {
      const bankId = data.split(":")[2];
      const session = await getSession(env, tg.id, "partner");
      const phone = session?.state === "add_requisite_sbp_bank" ? String(session.payload.phone || "") : "";
      if (!phone) {
        await answerCallback(token, cq.id, "Сначала укажи телефон СБП");
        return;
      }
      await addRequisite(env, tg.id, "sbp", phone, false, bankId);
      await clearSession(env, tg.id, "partner");
      const bank = sbpBankLabel(bankId);
      await editMessage(
        token,
        chatId,
        messageId,
        `✅ <b>СБП сохранён</b>\n\n` +
          `📱 <code>${phone}</code>${bank ? `\n🏦 ${bank}` : ""}\n\n` +
          `Выплаты на эти реквизиты идут через Cardlink.`,
        {
          inline_keyboard: [
            [{ text: "💳 Мои реквизиты", callback_data: "p:reqs" }],
            backRow(),
          ],
        }
      );
      await answerCallback(token, cq.id);
      return;
    }

    if (data.startsWith("p:defreq:")) {
      const requisiteId = data.split(":")[2];
      await setDefaultRequisite(env, tg.id, requisiteId);
      await showRequisites(env, chatId, tg, messageId);
      await answerCallback(token, cq.id, "⭐ Основной способ обновлён");
      return;
    }

    if (data === "p:promo") {
      await setSession(env, tg.id, "partner", "promo_request", {});
      await editMessage(
        token,
        chatId,
        messageId,
        `🎟 <b>Промокод на заказ</b>\n\n` +
          `Придумай слово для промика (латиница/цифры) — менеджер глянет и одобрит ✨\n\n` +
          `Напиши желаемый код одним сообщением 👇`,
        cancelKeyboard()
      );
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
          `🏧 <b>Вывод</b>\n\n` +
            `Сначала добавь реквизиты в «💳 Мои реквизиты» — без них некуда слать деньги 😅`,
          {
            inline_keyboard: [
              [{ text: "💳 Мои реквизиты", callback_data: "p:reqs" }],
              backRow(),
            ],
          }
        );
        await answerCallback(token, cq.id);
        return;
      }
      await editMessage(
        token,
        chatId,
        messageId,
        `🏧 <b>Вывод средств</b>\n\n` +
          `💵 Доступно: <b>${partner.balance} ₽</b>\n` +
          `📤 Куда: <b>${defaultReq.method.toUpperCase()}</b> · <code>${defaultReq.details}</code>\n` +
          (defaultReq.method === "sbp" && sbpBankLabel(defaultReq.sbp_bank_id)
            ? `🏦 ${sbpBankLabel(defaultReq.sbp_bank_id)}\n`
            : "") +
          `\nВыплата на привязанные реквизиты через Cardlink.\n\nВыводим всё или свою сумму?`,
        {
          inline_keyboard: [
            [{ text: "💸 Вывести всё", callback_data: "p:wdall" }],
            [{ text: "✏️ Ввести сумму", callback_data: "p:wdamt" }],
            backRow(),
          ],
        }
      );
      await answerCallback(token, cq.id);
      return;
    }

    if (data === "p:wdall") {
      const partner = await getPartner(env, tg.id);
      if (!partner || Number(partner.balance) <= 0) {
        await answerCallback(token, cq.id, "💸 Пока нечего выводить");
        return;
      }
      const req = await getDefaultRequisite(env, tg.id);
      if (!req) return;
      const result = await submitPartnerWithdrawal(env, {
        partnerId: tg.id,
        amount: Number(partner.balance),
        method: req.method as "sbp" | "card",
        details: req.details,
        sbpBankId: req.sbp_bank_id,
        username: tg.username,
      });
      const note =
        result.mode === "cardlink"
          ? `Отправлено на ваши реквизиты через Cardlink.`
          : `В очереди — выплата через Cardlink, как только поступят средства.`;
      await editMessage(
        token,
        chatId,
        messageId,
        `✅ <b>Заявка принята!</b>\n\n` +
          `Сумма: <b>${partner.balance} ₽</b>\n` +
          `${note}`,
        partnerMenuKeyboard()
      );
      await answerCallback(token, cq.id);
      return;
    }

    if (data === "p:wdamt") {
      await setSession(env, tg.id, "partner", "withdraw_amount", {});
      await editMessage(
        token,
        chatId,
        messageId,
        `✏️ <b>Своя сумма</b>\n\nСколько выводим? Напиши число в ₽ 👇`,
        cancelKeyboard("p:withdraw")
      );
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
      `🔥 Отлично, <b>${text}</b>!\n\n` +
        `Теперь кинь ссылку на свой ресурс (Telegram, TikTok, YouTube, Instagram)\n` +
        `или жми «Пропустить», если пока без площадки 👇`,
      {
        inline_keyboard: [
          [{ text: "⏭ Пропустить / нет ресурса", callback_data: "p:skip_social" }],
          backRow("p:cancel"),
        ],
      }
    );
    return;
  }

  if (session.state === "reg_social") {
    const existing = await getPartner(env, tg.id);
    if (existing) {
      await clearSession(env, tg.id, "partner");
      await sendMessage(
        token,
        chatId,
        `😎 Ты уже в партнёрке — добро пожаловать обратно!`,
        partnerMenuKeyboard()
      );
      return;
    }
    const displayName = String(session.payload.displayName || tg.first_name || "Partner");
    const partner = await createPartner(env, { ...tg, first_name: displayName }, [text]);
    await clearSession(env, tg.id, "partner");
    await sendMessage(
      token,
      chatId,
      `🎉 <b>Готово, ты в деле!</b>\n\n` +
        `${env.MSG_PARTNER_REGISTERED || "Вот твоя реферальная ссылка:"}\n` +
        `<code>${referralLink(env, partner.id)}</code>\n\n` +
        `Делись ссылкой — кайфуй от цифр на балансе 🚀`,
      partnerMenuKeyboard()
    );
    return;
  }

  if (session.state === "add_requisite_sbp_phone") {
    const digits = text.replace(/\D/g, "");
    if (digits.length < 10) {
      await sendMessage(
        token,
        chatId,
        `📱 Нужен номер телефона для СБП — например <code>+79001234567</code>`,
        cancelKeyboard("p:reqs")
      );
      return;
    }
    await setSession(env, tg.id, "partner", "add_requisite_sbp_bank", { phone: text.trim() });
    await sendMessage(
      token,
      chatId,
      `🏦 <b>Выбери банк СБП</b>\n\nТелефон: <code>${text.trim()}</code>`,
      {
        inline_keyboard: [...sbpBankKeyboard(), ...cancelKeyboard("p:reqs").inline_keyboard],
      }
    );
    return;
  }

  if (session.state === "add_requisite") {
    const method = session.payload.method as "card";
    await addRequisite(env, tg.id, method, text, false);
    await clearSession(env, tg.id, "partner");
    await sendMessage(
      token,
      chatId,
      `✅ <b>Карта сохранена</b>\n\n` +
        `Выплаты на эти реквизиты идут через Cardlink 💳`,
      {
        inline_keyboard: [
          [{ text: "💳 Мои реквизиты", callback_data: "p:reqs" }],
          backRow(),
        ],
      }
    );
    return;
  }

  if (session.state === "promo_request") {
    const req = await createPromoRequest(env, tg.id, text.toUpperCase());
    await clearSession(env, tg.id, "partner");
    await notifyManager(
      env,
      `Запрос промокода\nПартнер: @${tg.username || "—"} (${tg.id})\nКод: ${text.toUpperCase()}\nID: ${req.id}`
    );
    await sendMessage(
      token,
      chatId,
      `📨 <b>Запрос отправлен!</b>\n\n` +
        `Промокод <code>${text.toUpperCase()}</code> на рассмотрении.\n` +
        `Менеджер ответит, как только глянет 👀`,
      partnerMenuKeyboard()
    );
    return;
  }

  if (session.state === "withdraw_amount") {
    const amount = Number(text.replace(",", "."));
    const partner = await getPartner(env, tg.id);
    const req = await getDefaultRequisite(env, tg.id);
    if (!partner || !req || !Number.isFinite(amount) || amount <= 0) {
      await sendMessage(
        token,
        chatId,
        `🤔 Хм, сумма не похожа на число.\nПопробуй ещё раз, например: <code>1500</code>`,
        cancelKeyboard("p:withdraw")
      );
      return;
    }
    if (amount > Number(partner.balance)) {
      await sendMessage(
        token,
        chatId,
        `😅 На балансе только <b>${partner.balance} ₽</b> — меньше напиши.`,
        cancelKeyboard("p:withdraw")
      );
      return;
    }
    const result = await submitPartnerWithdrawal(env, {
      partnerId: tg.id,
      amount,
      method: req.method as "sbp" | "card",
      details: req.details,
      sbpBankId: req.sbp_bank_id,
      username: tg.username,
    });
    await clearSession(env, tg.id, "partner");
    const note =
      result.mode === "cardlink"
        ? `Средства отправлены на ваши реквизиты через Cardlink.`
        : `В очереди — выплата через Cardlink, как только поступят средства.`;
    await sendMessage(
      token,
      chatId,
      `✅ <b>Заявка принята!</b>\n\n` +
        `Сумма: <b>${amount} ₽</b>\n` +
        `${note}`,
      partnerMenuKeyboard()
    );
  }
}
