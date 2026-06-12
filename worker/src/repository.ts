import { sbJson, sbRequest, type SupabaseEnv } from "./supabase";
import type { DbSubscription, DbUser } from "./types";
import type { TelegramUser } from "./telegram";
import { displayName } from "./telegram";

export interface PartnerRow {
  id: number;
  username: string | null;
  display_name: string;
  social_links: unknown;
  balance: number;
  total_referrals: number;
  commission_percent: number;
}

export interface TransactionRow {
  id: string;
  user_id: string;
  amount: number;
  billing_months: number;
  promo_code_id: string | null;
  payment_method: string;
  status: string;
  screenshot_file_id: string | null;
  sender_name: string | null;
  is_first_payment: boolean;
}

export interface BotSessionRow {
  telegram_id: number;
  bot_kind: string;
  state: string;
  payload: Record<string, unknown>;
}

export async function getUserByTelegramId(
  env: SupabaseEnv,
  telegramId: number
): Promise<DbUser | null> {
  const rows = await sbJson<DbUser[]>(
    await sbRequest(env, `users?telegram_id=eq.${telegramId}&select=*&limit=1`)
  );
  return rows[0] ?? null;
}

export async function upsertTelegramUser(
  env: SupabaseEnv,
  tg: TelegramUser,
  refPartnerId?: number | null
): Promise<DbUser> {
  const existing = await getUserByTelegramId(env, tg.id);
  if (existing) {
    const patch = await sbJson<DbUser[]>(
      await sbRequest(env, `users?id=eq.${existing.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          username: tg.username ?? null,
          display_name: displayName(tg),
          photo_url: tg.photo_url ?? existing.photo_url,
          updated_at: new Date().toISOString(),
        }),
      })
    );
    return patch[0] ?? existing;
  }

  const created = await sbJson<DbUser[]>(
    await sbRequest(env, "users", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        telegram_id: tg.id,
        username: tg.username ?? null,
        display_name: displayName(tg),
        photo_url: tg.photo_url ?? null,
        ref_by_partner_id: refPartnerId ?? null,
      }),
    })
  );
  const user = created[0];
  await sbRequest(env, "subscriptions", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      user_id: user.id,
      plan_type: "basic",
      status: "none",
      extra_devices: 0,
    }),
  });
  if (refPartnerId) {
    await incrementPartnerReferrals(env, refPartnerId);
  }
  return user;
}

export async function getSubscription(
  env: SupabaseEnv,
  userId: string
): Promise<DbSubscription | null> {
  const rows = await sbJson<DbSubscription[]>(
    await sbRequest(env, `subscriptions?user_id=eq.${userId}&select=*&limit=1`)
  );
  return rows[0] ?? null;
}

export async function patchSubscription(
  env: SupabaseEnv,
  userId: string,
  body: Record<string, unknown>
): Promise<void> {
  await sbRequest(env, `subscriptions?user_id=eq.${userId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }),
  });
}

export async function patchUser(
  env: SupabaseEnv,
  userId: string,
  body: Record<string, unknown>
): Promise<void> {
  await sbRequest(env, `users?id=eq.${userId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }),
  });
}

export async function saveXuiInboundClients(
  env: SupabaseEnv,
  userId: string,
  rows: Array<{ inboundId: number; clientUuid: string; clientEmail: string }>
): Promise<void> {
  for (const row of rows) {
    await sbRequest(env, "xui_client_inbounds", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        user_id: userId,
        inbound_id: row.inboundId,
        client_uuid: row.clientUuid,
        client_email: row.clientEmail,
      }),
    });
  }
}

export async function getXuiInboundClients(
  env: SupabaseEnv,
  userId: string
): Promise<Array<{ inbound_id: number; client_uuid: string; client_email: string }>> {
  return sbJson(
    await sbRequest(
      env,
      `xui_client_inbounds?user_id=eq.${userId}&select=inbound_id,client_uuid,client_email`
    )
  );
}

export async function getSession(
  env: SupabaseEnv,
  telegramId: number,
  botKind: "client" | "partner"
): Promise<BotSessionRow | null> {
  const rows = await sbJson<BotSessionRow[]>(
    await sbRequest(
      env,
      `bot_sessions?telegram_id=eq.${telegramId}&bot_kind=eq.${botKind}&select=*&limit=1`
    )
  );
  return rows[0] ?? null;
}

export async function setSession(
  env: SupabaseEnv,
  telegramId: number,
  botKind: "client" | "partner",
  state: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await sbRequest(env, "bot_sessions?on_conflict=telegram_id,bot_kind", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      telegram_id: telegramId,
      bot_kind: botKind,
      state,
      payload,
      updated_at: new Date().toISOString(),
    }),
  });
}

export async function clearSession(
  env: SupabaseEnv,
  telegramId: number,
  botKind: "client" | "partner"
): Promise<void> {
  await setSession(env, telegramId, botKind, "idle", {});
}

export async function createTransaction(
  env: SupabaseEnv,
  body: Record<string, unknown>
): Promise<TransactionRow> {
  const rows = await sbJson<TransactionRow[]>(
    await sbRequest(env, "transactions", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body),
    })
  );
  return rows[0];
}

export async function getTransaction(
  env: SupabaseEnv,
  id: string
): Promise<TransactionRow | null> {
  const rows = await sbJson<TransactionRow[]>(
    await sbRequest(env, `transactions?id=eq.${id}&select=*&limit=1`)
  );
  return rows[0] ?? null;
}

export async function patchTransaction(
  env: SupabaseEnv,
  id: string,
  body: Record<string, unknown>
): Promise<void> {
  await sbRequest(env, `transactions?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }),
  });
}

export async function getPartner(
  env: SupabaseEnv,
  telegramId: number
): Promise<PartnerRow | null> {
  const rows = await sbJson<PartnerRow[]>(
    await sbRequest(env, `partners?id=eq.${telegramId}&select=*&limit=1`)
  );
  return rows[0] ?? null;
}

export async function createPartner(
  env: SupabaseEnv,
  tg: TelegramUser,
  socialLinks: string[]
): Promise<PartnerRow> {
  const rows = await sbJson<PartnerRow[]>(
    await sbRequest(env, "partners", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        id: tg.id,
        username: tg.username ?? null,
        display_name: displayName(tg),
        social_links: socialLinks,
      }),
    })
  );
  return rows[0];
}

export async function incrementPartnerReferrals(
  env: SupabaseEnv,
  partnerId: number
): Promise<void> {
  const partner = await getPartner(env, partnerId);
  if (!partner) return;
  await sbRequest(env, `partners?id=eq.${partnerId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      total_referrals: partner.total_referrals + 1,
      updated_at: new Date().toISOString(),
    }),
  });
}

export async function addPartnerBalance(
  env: SupabaseEnv,
  partnerId: number,
  amount: number
): Promise<void> {
  const partner = await getPartner(env, partnerId);
  if (!partner) return;
  await sbRequest(env, `partners?id=eq.${partnerId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      balance: Number(partner.balance) + amount,
      updated_at: new Date().toISOString(),
    }),
  });
}

export async function getDefaultRequisite(
  env: SupabaseEnv,
  partnerId: number
): Promise<{ method: string; details: string } | null> {
  const rows = await sbJson<Array<{ method: string; details: string }>>(
    await sbRequest(
      env,
      `partner_requisites?partner_id=eq.${partnerId}&is_default=eq.true&select=method,details&limit=1`
    )
  );
  return rows[0] ?? null;
}

export async function listRequisites(
  env: SupabaseEnv,
  partnerId: number
): Promise<Array<{ id: string; method: string; details: string; is_default: boolean }>> {
  return sbJson(
    await sbRequest(
      env,
      `partner_requisites?partner_id=eq.${partnerId}&select=id,method,details,is_default&order=created_at.asc`
    )
  );
}

export async function addRequisite(
  env: SupabaseEnv,
  partnerId: number,
  method: "sbp" | "card",
  details: string,
  makeDefault: boolean
): Promise<void> {
  if (makeDefault) {
    await sbRequest(env, `partner_requisites?partner_id=eq.${partnerId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ is_default: false }),
    });
  }
  const existing = await listRequisites(env, partnerId);
  await sbRequest(env, "partner_requisites", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      partner_id: partnerId,
      method,
      details,
      is_default: makeDefault || existing.length === 0,
    }),
  });
}

export async function setDefaultRequisite(
  env: SupabaseEnv,
  partnerId: number,
  requisiteId: string
): Promise<void> {
  await sbRequest(env, `partner_requisites?partner_id=eq.${partnerId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ is_default: false }),
  });
  await sbRequest(env, `partner_requisites?id=eq.${requisiteId}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ is_default: true }),
  });
}

export async function createWithdrawal(
  env: SupabaseEnv,
  body: Record<string, unknown>
): Promise<{ id: string }> {
  const rows = await sbJson<Array<{ id: string }>>(
    await sbRequest(env, "withdrawals", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body),
    })
  );
  return rows[0];
}

export async function getWithdrawal(
  env: SupabaseEnv,
  id: string
): Promise<Record<string, unknown> | null> {
  const rows = await sbJson<Record<string, unknown>[]>(
    await sbRequest(env, `withdrawals?id=eq.${id}&select=*&limit=1`)
  );
  return rows[0] ?? null;
}

export async function patchWithdrawal(
  env: SupabaseEnv,
  id: string,
  body: Record<string, unknown>
): Promise<void> {
  await sbRequest(env, `withdrawals?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }),
  });
}

export async function createPromoRequest(
  env: SupabaseEnv,
  partnerId: number,
  code: string
): Promise<{ id: string }> {
  const rows = await sbJson<Array<{ id: string }>>(
    await sbRequest(env, "promo_requests", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        partner_id: partnerId,
        requested_code: code,
      }),
    })
  );
  return rows[0];
}

export async function getPromoByCode(
  env: SupabaseEnv,
  code: string
): Promise<{ id: string; discount_percent: number } | null> {
  const rows = await sbJson<Array<{ id: string; discount_percent: number }>>(
    await sbRequest(
      env,
      `promo_codes?code=eq.${encodeURIComponent(code)}&is_active=eq.true&select=id,discount_percent&limit=1`
    )
  );
  return rows[0] ?? null;
}
