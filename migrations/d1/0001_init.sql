-- FIX VPN: Cloudflare D1 (SQLite) — постоянные данные и финансы

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  display_name TEXT NOT NULL,
  photo_url TEXT,
  has_used_trial INTEGER NOT NULL DEFAULT 0,
  trial_first_connect_at TEXT,
  ref_by_partner_id INTEGER,
  first_payment_done INTEGER NOT NULL DEFAULT 0,
  is_tester INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan_type TEXT NOT NULL CHECK (plan_type IN ('basic', 'personal')),
  status TEXT NOT NULL DEFAULT 'none' CHECK (status IN ('none', 'active', 'expired')),
  plan_label TEXT,
  billing_months INTEGER,
  starts_at TEXT,
  ends_at TEXT,
  vpn_key TEXT,
  xray_uuid TEXT,
  xray_sub_id TEXT,
  subscription_url TEXT,
  client_email TEXT,
  is_trial INTEGER NOT NULL DEFAULT 0,
  extra_devices INTEGER NOT NULL DEFAULT 0,
  panel_ip_clear_requested_at TEXT,
  last_device_reset TEXT,
  pending_xray_sub_id TEXT,
  panel_sub_rotate_requested_at TEXT,
  purchased_at TEXT,
  expires_at TEXT,
  expiry_warned_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_xray_sub_id ON subscriptions(xray_sub_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status_expires ON subscriptions(status, expires_at);

CREATE TABLE IF NOT EXISTS addon_purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addon_type TEXT NOT NULL,
  label TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  price_rub INTEGER NOT NULL DEFAULT 0,
  purchased_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY,
  username TEXT,
  display_name TEXT NOT NULL,
  social_links TEXT NOT NULL DEFAULT '[]',
  balance REAL NOT NULL DEFAULT 0,
  total_referrals INTEGER NOT NULL DEFAULT 0,
  commission_percent INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS partner_requisites (
  id TEXT PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('sbp', 'card')),
  details TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  sbp_bank_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
  partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  billing_months INTEGER NOT NULL,
  extra_devices INTEGER NOT NULL DEFAULT 0,
  plan_type TEXT NOT NULL DEFAULT 'basic' CHECK (plan_type IN ('basic', 'personal')),
  platega_transaction_id TEXT,
  promo_code_id TEXT REFERENCES promo_codes(id) ON DELETE SET NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('sbp', 'card', 'crypto_usdt')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  screenshot_file_id TEXT,
  sender_name TEXT,
  manager_note TEXT,
  is_first_payment INTEGER NOT NULL DEFAULT 0,
  partner_commission_amount REAL,
  cardlink_bill_id TEXT,
  payment_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_platega ON transactions(platega_transaction_id);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('sbp', 'card')),
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'approved', 'rejected')),
  manager_note TEXT,
  cardlink_payout_id TEXT,
  payout_source TEXT CHECK (payout_source IN ('manual', 'cardlink')),
  sbp_bank_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promo_requests (
  id TEXT PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  requested_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Привязка клиента к inbound панели (постоянные данные)
CREATE TABLE IF NOT EXISTS xui_client_inbounds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inbound_id INTEGER NOT NULL,
  client_uuid TEXT NOT NULL,
  client_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, inbound_id)
);

-- Учёт устройств пользователя (лимиты)
CREATE TABLE IF NOT EXISTS vpn_device_bindings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  os TEXT NOT NULL,
  vpn_client TEXT NOT NULL,
  label TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, os, vpn_client)
);

CREATE INDEX IF NOT EXISTS idx_vpn_device_bindings_user_id ON vpn_device_bindings(user_id);
CREATE INDEX IF NOT EXISTS idx_users_ref_partner ON users(ref_by_partner_id);
