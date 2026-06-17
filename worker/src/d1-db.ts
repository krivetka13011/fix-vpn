import type { DbSubscription, DbUser } from "./types";

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function d1First<T extends Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  const row = await db
    .prepare(sql)
    .bind(...params)
    .first<T>();
  return row ?? null;
}

export async function d1All<T extends Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const result = await db.prepare(sql).bind(...params).all<T>();
  return result.results ?? [];
}

export async function d1Run(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<void> {
  await db.prepare(sql).bind(...params).run();
}

export function asBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

export function toBoolInt(value: boolean | undefined | null): number {
  return value ? 1 : 0;
}

export function mapUserRow(row: Record<string, unknown>): DbUser {
  return {
    id: String(row.id),
    telegram_id: Number(row.telegram_id),
    username: row.username != null ? String(row.username) : null,
    display_name: String(row.display_name),
    photo_url: row.photo_url != null ? String(row.photo_url) : null,
    has_used_trial: asBool(row.has_used_trial),
    trial_first_connect_at:
      row.trial_first_connect_at != null ? String(row.trial_first_connect_at) : null,
    ref_by_partner_id:
      row.ref_by_partner_id != null ? Number(row.ref_by_partner_id) : null,
    first_payment_done: asBool(row.first_payment_done),
    is_tester: asBool(row.is_tester),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function mapSubscriptionRow(row: Record<string, unknown>): DbSubscription {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    plan_type: row.plan_type as DbSubscription["plan_type"],
    status: row.status as DbSubscription["status"],
    plan_label: row.plan_label != null ? String(row.plan_label) : null,
    billing_months:
      row.billing_months != null ? Number(row.billing_months) : null,
    starts_at: row.starts_at != null ? String(row.starts_at) : null,
    ends_at: row.ends_at != null ? String(row.ends_at) : null,
    vpn_key: row.vpn_key != null ? String(row.vpn_key) : null,
    xray_uuid: row.xray_uuid != null ? String(row.xray_uuid) : null,
    xray_sub_id: row.xray_sub_id != null ? String(row.xray_sub_id) : null,
    subscription_url:
      row.subscription_url != null ? String(row.subscription_url) : null,
    client_email: row.client_email != null ? String(row.client_email) : null,
    is_trial: asBool(row.is_trial),
    extra_devices: Number(row.extra_devices ?? 0),
    purchased_at: row.purchased_at != null ? String(row.purchased_at) : null,
    panel_ip_clear_requested_at:
      row.panel_ip_clear_requested_at != null
        ? String(row.panel_ip_clear_requested_at)
        : null,
    last_device_reset:
      row.last_device_reset != null ? String(row.last_device_reset) : null,
    pending_xray_sub_id:
      row.pending_xray_sub_id != null ? String(row.pending_xray_sub_id) : null,
    panel_sub_rotate_requested_at:
      row.panel_sub_rotate_requested_at != null
        ? String(row.panel_sub_rotate_requested_at)
        : null,
    expires_at: row.expires_at != null ? String(row.expires_at) : null,
    expiry_warned_at:
      row.expiry_warned_at != null ? String(row.expiry_warned_at) : null,
    updated_at: String(row.updated_at),
  };
}

/** Dynamic UPDATE: SET col = ? ... WHERE clause with bound params. */
export async function d1Patch(
  db: D1Database,
  table: string,
  fields: Record<string, unknown>,
  whereSql: string,
  ...whereParams: unknown[]
): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((key) => `${key} = ?`).join(", ");
  const values = keys.map((key) => fields[key]);
  await d1Run(db, `UPDATE ${table} SET ${sets} WHERE ${whereSql}`, ...values, ...whereParams);
}
