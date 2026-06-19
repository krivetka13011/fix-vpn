import {
  d1All,
  d1First,
  d1Patch,
  d1Run,
  mapSubscriptionRow,
  mapUserRow,
  newId,
  nowIso,
  toBoolInt,
} from "./d1-db";
import {
  kvCheckRateLimit,
  kvClearSession,
  kvClearSubscriptionPayloadCache,
  kvClearSubscriptionStatusCache,
  kvGetSession,
  kvSetSession,
  kvSetSubscriptionStatusCache,
  type BotSessionRow,
} from "./kv-store";
import type { StorageEnv } from "./storage-env";
import type { DbSubscription, DbUser } from "./types";
import type { TelegramUser } from "./telegram";
import { displayName } from "./telegram";

export type { BotSessionRow };

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
  extra_devices?: number;
  plan_type?: string;
  platega_transaction_id?: string | null;
  promo_code_id: string | null;
  payment_method: string;
  status: string;
  screenshot_file_id: string | null;
  sender_name: string | null;
  is_first_payment: boolean;
  cardlink_bill_id?: string | null;
  payment_url?: string | null;
}

function mapPartnerRow(row: Record<string, unknown>): PartnerRow {
  let social: unknown = row.social_links;
  if (typeof social === "string") {
    try {
      social = JSON.parse(social);
    } catch {
      social = [];
    }
  }
  return {
    id: Number(row.id),
    username: row.username != null ? String(row.username) : null,
    display_name: String(row.display_name),
    social_links: social,
    balance: Number(row.balance ?? 0),
    total_referrals: Number(row.total_referrals ?? 0),
    commission_percent: Number(row.commission_percent ?? 50),
  };
}

function mapTransactionRow(row: Record<string, unknown>): TransactionRow {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    amount: Number(row.amount),
    billing_months: Number(row.billing_months),
    extra_devices: row.extra_devices != null ? Number(row.extra_devices) : 0,
    plan_type: row.plan_type != null ? String(row.plan_type) : undefined,
    platega_transaction_id:
      row.platega_transaction_id != null ? String(row.platega_transaction_id) : null,
    promo_code_id: row.promo_code_id != null ? String(row.promo_code_id) : null,
    payment_method: String(row.payment_method),
    status: String(row.status),
    screenshot_file_id:
      row.screenshot_file_id != null ? String(row.screenshot_file_id) : null,
    sender_name: row.sender_name != null ? String(row.sender_name) : null,
    is_first_payment: row.is_first_payment === 1 || row.is_first_payment === true,
    cardlink_bill_id: row.cardlink_bill_id != null ? String(row.cardlink_bill_id) : null,
    payment_url: row.payment_url != null ? String(row.payment_url) : null,
  };
}

async function invalidateSubCaches(env: StorageEnv, userId: string): Promise<void> {
  try {
    await kvClearSubscriptionPayloadCache(env, userId);
    await kvClearSubscriptionStatusCache(env, userId);
  } catch (error) {
    console.error("invalidateSubCaches:", error);
  }
}

export async function getUserByTelegramId(
  env: StorageEnv,
  telegramId: number
): Promise<DbUser | null> {
  const row = await d1First(env.DB, "SELECT * FROM users WHERE telegram_id = ? LIMIT 1", telegramId);
  return row ? mapUserRow(row) : null;
}

export async function getUserById(
  env: StorageEnv,
  userId: string
): Promise<DbUser | null> {
  const row = await d1First(env.DB, "SELECT * FROM users WHERE id = ? LIMIT 1", userId);
  return row ? mapUserRow(row) : null;
}

export async function upsertTelegramUser(
  env: StorageEnv,
  tg: TelegramUser,
  refPartnerId?: number | null
): Promise<DbUser> {
  const existing = await getUserByTelegramId(env, tg.id);
  const ts = nowIso();
  if (existing) {
    await d1Patch(
      env.DB,
      "users",
      {
        username: tg.username ?? null,
        display_name: displayName(tg),
        photo_url: tg.photo_url ?? existing.photo_url,
        updated_at: ts,
      },
      "id = ?",
      existing.id
    );
    return (await getUserByTelegramId(env, tg.id)) ?? existing;
  }

  const userId = newId();
  await d1Run(
    env.DB,
    `INSERT INTO users (id, telegram_id, username, display_name, photo_url, ref_by_partner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    userId,
    tg.id,
    tg.username ?? null,
    displayName(tg),
    tg.photo_url ?? null,
    refPartnerId ?? null,
    ts,
    ts
  );
  const subId = newId();
  await d1Run(
    env.DB,
    `INSERT INTO subscriptions (id, user_id, plan_type, status, extra_devices, updated_at)
     VALUES (?, ?, 'basic', 'none', 0, ?)`,
    subId,
    userId,
    ts
  );
  if (refPartnerId) {
    await incrementPartnerReferrals(env, refPartnerId);
  }
  const user = await getUserByTelegramId(env, tg.id);
  if (!user) throw new Error("upsertTelegramUser failed");
  return user;
}

export async function getSubscription(
  env: StorageEnv,
  userId: string
): Promise<DbSubscription | null> {
  const row = await d1First(
    env.DB,
    "SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1",
    userId
  );
  return row ? mapSubscriptionRow(row) : null;
}

export async function getSubscriptionBySubId(
  env: StorageEnv,
  subId: string
): Promise<DbSubscription | null> {
  const row = await d1First(
    env.DB,
    "SELECT * FROM subscriptions WHERE xray_sub_id = ? LIMIT 1",
    subId
  );
  return row ? mapSubscriptionRow(row) : null;
}

export async function patchSubscription(
  env: StorageEnv,
  userId: string,
  body: Record<string, unknown>
): Promise<void> {
  const existing = await getSubscription(env, userId);
  if (!existing) {
    await d1Run(
      env.DB,
      `INSERT INTO subscriptions (id, user_id, plan_type, status, extra_devices, updated_at)
       VALUES (?, ?, 'basic', 'none', 0, ?)`,
      newId(),
      userId,
      nowIso()
    );
  }
  const fields: Record<string, unknown> = { ...body, updated_at: nowIso() };
  if ("is_trial" in fields) fields.is_trial = toBoolInt(Boolean(fields.is_trial));
  await d1Patch(env.DB, "subscriptions", fields, "user_id = ?", userId);
  await invalidateSubCaches(env, userId);
  const sub = await getSubscription(env, userId);
  if (sub) {
    try {
      await kvSetSubscriptionStatusCache(env, userId, {
        status: sub.status,
        is_trial: Boolean(sub.is_trial),
        expires_at: sub.expires_at ?? null,
      });
    } catch (error) {
      console.error("kvSetSubscriptionStatusCache:", error);
    }
  }
}

export async function patchUser(
  env: StorageEnv,
  userId: string,
  body: Record<string, unknown>
): Promise<void> {
  const fields: Record<string, unknown> = { ...body, updated_at: nowIso() };
  if ("has_used_trial" in fields) fields.has_used_trial = toBoolInt(Boolean(fields.has_used_trial));
  if ("first_payment_done" in fields) {
    fields.first_payment_done = toBoolInt(Boolean(fields.first_payment_done));
  }
  if ("is_tester" in fields) fields.is_tester = toBoolInt(Boolean(fields.is_tester));
  await d1Patch(env.DB, "users", fields, "id = ?", userId);
}

export async function markTrialFirstConnectAt(
  env: StorageEnv,
  telegramId: number
): Promise<void> {
  await d1Run(
    env.DB,
    `UPDATE users SET trial_first_connect_at = ?, updated_at = ?
     WHERE telegram_id = ? AND trial_first_connect_at IS NULL`,
    nowIso(),
    nowIso(),
    telegramId
  );
}

export async function finalizeTrialButtonGrace(
  env: StorageEnv,
  telegramId: number
): Promise<DbUser | null> {
  const user = await getUserByTelegramId(env, telegramId);
  if (!user || user.has_used_trial || !user.trial_first_connect_at) {
    return user;
  }
  const elapsed = Date.now() - new Date(user.trial_first_connect_at).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 24 * 60 * 60 * 1000) {
    return user;
  }
  await d1Run(
    env.DB,
    `UPDATE users SET has_used_trial = 1, updated_at = ? WHERE telegram_id = ?`,
    nowIso(),
    telegramId
  );
  return getUserByTelegramId(env, telegramId);
}

export async function releaseTrialClaim(
  env: StorageEnv,
  telegramId: number
): Promise<void> {
  await d1Run(
    env.DB,
    `UPDATE users SET has_used_trial = 0, trial_first_connect_at = NULL, updated_at = ? WHERE telegram_id = ?`,
    nowIso(),
    telegramId
  );
}

export async function resetTesterTrial(
  env: StorageEnv,
  telegramId: number
): Promise<DbUser | null> {
  await d1Run(
    env.DB,
    `UPDATE users SET has_used_trial = 0, trial_first_connect_at = NULL, first_payment_done = 0, updated_at = ?
     WHERE telegram_id = ?`,
    nowIso(),
    telegramId
  );
  return getUserByTelegramId(env, telegramId);
}

export async function resetTesterSubscriptionState(
  env: StorageEnv,
  userId: string
): Promise<void> {
  await patchSubscription(env, userId, {
    status: "none",
    plan_type: "basic",
    plan_label: null,
    billing_months: null,
    starts_at: null,
    ends_at: null,
    is_trial: false,
    xray_uuid: null,
    xray_sub_id: null,
    subscription_url: null,
    client_email: null,
    expires_at: null,
    expiry_warned_at: null,
  });
}

export async function resetTesterTrialPlan(
  env: StorageEnv,
  userId: string
): Promise<void> {
  await patchSubscription(env, userId, {
    status: "none",
    plan_label: null,
    billing_months: null,
    starts_at: null,
    ends_at: null,
    is_trial: false,
    expires_at: null,
    expiry_warned_at: null,
    extra_devices: 0,
  });
}

export async function clearXuiInboundClients(
  env: StorageEnv,
  userId: string
): Promise<void> {
  await d1Run(env.DB, "DELETE FROM xui_client_inbounds WHERE user_id = ?", userId);
}

export async function saveXuiInboundClients(
  env: StorageEnv,
  userId: string,
  rows: Array<{ inboundId: number; clientUuid: string; clientEmail: string }>
): Promise<void> {
  const ts = nowIso();
  for (const row of rows) {
    await d1Run(
      env.DB,
      `INSERT INTO xui_client_inbounds (id, user_id, inbound_id, client_uuid, client_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, inbound_id) DO UPDATE SET
         client_uuid = excluded.client_uuid,
         client_email = excluded.client_email`,
      newId(),
      userId,
      row.inboundId,
      row.clientUuid,
      row.clientEmail,
      ts
    );
  }
}

export async function getXuiInboundClients(
  env: StorageEnv,
  userId: string
): Promise<Array<{ inbound_id: number; client_uuid: string; client_email: string }>> {
  const rows = await d1All<Record<string, unknown>>(
    env.DB,
    "SELECT inbound_id, client_uuid, client_email FROM xui_client_inbounds WHERE user_id = ?",
    userId
  );
  return rows.map((row) => ({
    inbound_id: Number(row.inbound_id),
    client_uuid: String(row.client_uuid),
    client_email: String(row.client_email),
  }));
}

export async function getSession(
  env: StorageEnv,
  telegramId: number,
  botKind: "client" | "partner"
): Promise<BotSessionRow | null> {
  return kvGetSession(env, telegramId, botKind);
}

export async function setSession(
  env: StorageEnv,
  telegramId: number,
  botKind: "client" | "partner",
  state: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await kvSetSession(env, telegramId, botKind, state, payload);
}

export async function clearSession(
  env: StorageEnv,
  telegramId: number,
  botKind: "client" | "partner"
): Promise<void> {
  await kvClearSession(env, telegramId, botKind);
}

/** Защита от спама кнопок callback. */
export async function checkCallbackRateLimit(
  env: StorageEnv,
  telegramId: number,
  action: string,
  windowMs = 1500
): Promise<boolean> {
  return kvCheckRateLimit(env, telegramId, action, windowMs);
}

export async function createTransaction(
  env: StorageEnv,
  body: Record<string, unknown>
): Promise<TransactionRow> {
  const id = String(body.id ?? newId());
  const ts = nowIso();
  await d1Run(
    env.DB,
    `INSERT INTO transactions (
      id, user_id, amount, billing_months, extra_devices, plan_type, platega_transaction_id,
      promo_code_id, payment_method, status, screenshot_file_id, sender_name, is_first_payment,
      cardlink_bill_id, payment_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    body.user_id,
    body.amount,
    body.billing_months,
    body.extra_devices ?? 0,
    body.plan_type ?? "basic",
    body.platega_transaction_id ?? null,
    body.promo_code_id ?? null,
    body.payment_method,
    body.status ?? "pending",
    body.screenshot_file_id ?? null,
    body.sender_name ?? null,
    toBoolInt(Boolean(body.is_first_payment)),
    body.cardlink_bill_id ?? null,
    body.payment_url ?? null,
    ts,
    ts
  );
  const row = await getTransaction(env, id);
  if (!row) throw new Error("createTransaction failed");
  return row;
}

export async function getTransaction(
  env: StorageEnv,
  id: string
): Promise<TransactionRow | null> {
  const row = await d1First(env.DB, "SELECT * FROM transactions WHERE id = ? LIMIT 1", id);
  return row ? mapTransactionRow(row) : null;
}

export async function getTransactionByPlategaId(
  env: StorageEnv,
  plategaId: string
): Promise<TransactionRow | null> {
  const row = await d1First(
    env.DB,
    "SELECT * FROM transactions WHERE platega_transaction_id = ? LIMIT 1",
    plategaId
  );
  return row ? mapTransactionRow(row) : null;
}

export async function listPendingPlategaTransactions(
  env: StorageEnv,
  limit = 25
): Promise<TransactionRow[]> {
  const rows = await d1All<Record<string, unknown>>(
    env.DB,
    `SELECT * FROM transactions
     WHERE status = 'pending'
       AND platega_transaction_id IS NOT NULL
       AND TRIM(platega_transaction_id) != ''
     ORDER BY created_at ASC
     LIMIT ?`,
    limit
  );
  return rows.map(mapTransactionRow);
}

export async function listPendingPlategaTransactionsForUser(
  env: StorageEnv,
  userId: string
): Promise<TransactionRow[]> {
  const rows = await d1All<Record<string, unknown>>(
    env.DB,
    `SELECT * FROM transactions
     WHERE user_id = ?
       AND status = 'pending'
       AND platega_transaction_id IS NOT NULL
       AND TRIM(platega_transaction_id) != ''
     ORDER BY created_at DESC
     LIMIT 5`,
    userId
  );
  return rows.map(mapTransactionRow);
}

export async function getTransactionByPayloadId(
  env: StorageEnv,
  payloadId: string
): Promise<TransactionRow | null> {
  return getTransaction(env, payloadId);
}

export async function patchTransaction(
  env: StorageEnv,
  id: string,
  body: Record<string, unknown>
): Promise<void> {
  const fields: Record<string, unknown> = { ...body, updated_at: nowIso() };
  if ("is_first_payment" in fields) {
    fields.is_first_payment = toBoolInt(Boolean(fields.is_first_payment));
  }
  await d1Patch(env.DB, "transactions", fields, "id = ?", id);
}

export async function getPartner(
  env: StorageEnv,
  telegramId: number
): Promise<PartnerRow | null> {
  const row = await d1First(env.DB, "SELECT * FROM partners WHERE id = ? LIMIT 1", telegramId);
  return row ? mapPartnerRow(row) : null;
}

export async function countPartnerPaidReferrals(
  env: StorageEnv,
  partnerId: number
): Promise<number> {
  const row = await d1First<{ count: number }>(
    env.DB,
    "SELECT COUNT(*) AS count FROM users WHERE ref_by_partner_id = ? AND first_payment_done = 1",
    partnerId
  );
  return Number(row?.count ?? 0);
}

export async function createPartner(
  env: StorageEnv,
  tg: TelegramUser,
  socialLinks: string[]
): Promise<PartnerRow> {
  const ts = nowIso();
  await d1Run(
    env.DB,
    `INSERT INTO partners (id, username, display_name, social_links, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    tg.id,
    tg.username ?? null,
    displayName(tg),
    JSON.stringify(socialLinks),
    ts,
    ts
  );
  const partner = await getPartner(env, tg.id);
  if (!partner) throw new Error("createPartner failed");
  return partner;
}

export async function incrementPartnerReferrals(
  env: StorageEnv,
  partnerId: number
): Promise<void> {
  await d1Run(
    env.DB,
    `UPDATE partners SET total_referrals = total_referrals + 1, updated_at = ? WHERE id = ?`,
    nowIso(),
    partnerId
  );
}

export async function addPartnerBalance(
  env: StorageEnv,
  partnerId: number,
  amount: number
): Promise<void> {
  await d1Run(
    env.DB,
    `UPDATE partners SET balance = balance + ?, updated_at = ? WHERE id = ?`,
    amount,
    nowIso(),
    partnerId
  );
}

export async function getDefaultRequisite(
  env: StorageEnv,
  partnerId: number
): Promise<{ method: string; details: string; sbp_bank_id?: string | null } | null> {
  const row = await d1First(
    env.DB,
    `SELECT method, details, sbp_bank_id FROM partner_requisites
     WHERE partner_id = ? AND is_default = 1 LIMIT 1`,
    partnerId
  );
  if (!row) return null;
  return {
    method: String(row.method),
    details: String(row.details),
    sbp_bank_id: row.sbp_bank_id != null ? String(row.sbp_bank_id) : null,
  };
}

export async function listRequisites(
  env: StorageEnv,
  partnerId: number
): Promise<
  Array<{ id: string; method: string; details: string; is_default: boolean; sbp_bank_id?: string | null }>
> {
  const rows = await d1All(
    env.DB,
    `SELECT id, method, details, is_default, sbp_bank_id FROM partner_requisites
     WHERE partner_id = ? ORDER BY created_at ASC`,
    partnerId
  );
  return rows.map((row) => ({
    id: String(row.id),
    method: String(row.method),
    details: String(row.details),
    is_default: row.is_default === 1,
    sbp_bank_id: row.sbp_bank_id != null ? String(row.sbp_bank_id) : null,
  }));
}

export async function addRequisite(
  env: StorageEnv,
  partnerId: number,
  method: "sbp" | "card",
  details: string,
  makeDefault: boolean,
  sbpBankId?: string | null
): Promise<void> {
  const existing = await listRequisites(env, partnerId);
  if (makeDefault) {
    await d1Run(
      env.DB,
      "UPDATE partner_requisites SET is_default = 0 WHERE partner_id = ?",
      partnerId
    );
  }
  await d1Run(
    env.DB,
    `INSERT INTO partner_requisites (id, partner_id, method, details, is_default, sbp_bank_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    partnerId,
    method,
    details,
    makeDefault || existing.length === 0 ? 1 : 0,
    method === "sbp" ? sbpBankId ?? null : null,
    nowIso()
  );
}

export async function setDefaultRequisite(
  env: StorageEnv,
  partnerId: number,
  requisiteId: string
): Promise<void> {
  await d1Run(
    env.DB,
    "UPDATE partner_requisites SET is_default = 0 WHERE partner_id = ?",
    partnerId
  );
  await d1Run(
    env.DB,
    "UPDATE partner_requisites SET is_default = 1 WHERE id = ? AND partner_id = ?",
    requisiteId,
    partnerId
  );
}

export async function createWithdrawal(
  env: StorageEnv,
  body: Record<string, unknown>
): Promise<{ id: string }> {
  const id = newId();
  const ts = nowIso();
  await d1Run(
    env.DB,
    `INSERT INTO withdrawals (id, partner_id, amount, method, details, status, sbp_bank_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    body.partner_id,
    body.amount,
    body.method,
    body.details,
    body.status ?? "pending",
    body.sbp_bank_id ?? null,
    ts,
    ts
  );
  return { id };
}

export async function getWithdrawal(
  env: StorageEnv,
  id: string
): Promise<Record<string, unknown> | null> {
  return d1First(env.DB, "SELECT * FROM withdrawals WHERE id = ? LIMIT 1", id);
}

export async function patchWithdrawal(
  env: StorageEnv,
  id: string,
  body: Record<string, unknown>
): Promise<void> {
  await d1Patch(env.DB, "withdrawals", { ...body, updated_at: nowIso() }, "id = ?", id);
}

export async function createPromoRequest(
  env: StorageEnv,
  partnerId: number,
  code: string
): Promise<{ id: string }> {
  const id = newId();
  await d1Run(
    env.DB,
    `INSERT INTO promo_requests (id, partner_id, requested_code, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`,
    id,
    partnerId,
    code,
    nowIso()
  );
  return { id };
}

export async function getPromoByCode(
  env: StorageEnv,
  code: string
): Promise<{ id: string; discount_percent: number } | null> {
  const row = await d1First(
    env.DB,
    `SELECT id, discount_percent FROM promo_codes WHERE code = ? AND is_active = 1 LIMIT 1`,
    code
  );
  if (!row) return null;
  return { id: String(row.id), discount_percent: Number(row.discount_percent) };
}

export interface VpnDeviceBinding {
  id: string;
  user_id: string;
  os: string;
  vpn_client: string;
  label: string;
  first_seen_at: string;
  last_seen_at: string;
}

export async function listVpnDeviceBindings(
  env: StorageEnv,
  userId: string
): Promise<VpnDeviceBinding[]> {
  const rows = await d1All(
    env.DB,
    "SELECT * FROM vpn_device_bindings WHERE user_id = ? ORDER BY last_seen_at DESC",
    userId
  );
  return rows.map((row) => ({
    id: String(row.id),
    user_id: String(row.user_id),
    os: String(row.os),
    vpn_client: String(row.vpn_client),
    label: String(row.label),
    first_seen_at: String(row.first_seen_at),
    last_seen_at: String(row.last_seen_at),
  }));
}

export async function upsertVpnDeviceBinding(
  env: StorageEnv,
  userId: string,
  os: string,
  vpnClient: string,
  label: string
): Promise<void> {
  const ts = nowIso();
  const existing = await d1First(
    env.DB,
    "SELECT id FROM vpn_device_bindings WHERE user_id = ? AND os = ? AND vpn_client = ? LIMIT 1",
    userId,
    os,
    vpnClient
  );
  if (existing) {
    await d1Run(
      env.DB,
      "UPDATE vpn_device_bindings SET label = ?, last_seen_at = ? WHERE id = ?",
      label,
      ts,
      existing.id
    );
    return;
  }
  await d1Run(
    env.DB,
    `INSERT INTO vpn_device_bindings (id, user_id, os, vpn_client, label, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    userId,
    os,
    vpnClient,
    label,
    ts,
    ts
  );
}

export async function clearVpnDeviceBindings(
  env: StorageEnv,
  userId: string
): Promise<void> {
  await d1Run(env.DB, "DELETE FROM vpn_device_bindings WHERE user_id = ?", userId);
}

export {
  kvGetSubscriptionPayloadCache,
  kvSetSubscriptionPayloadCache,
  kvClearSubscriptionPayloadCache,
} from "./kv-store";
