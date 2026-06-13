create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  username text,
  display_name text not null,
  photo_url text,
  has_used_trial boolean not null default false,
  ref_by_partner_id bigint,
  first_payment_done boolean not null default false,
  is_tester boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  plan_type text not null check (plan_type in ('basic', 'personal')),
  status text not null default 'none' check (status in ('none', 'active', 'expired')),
  plan_label text,
  billing_months int,
  starts_at date,
  ends_at date,
  vpn_key text,
  xray_uuid text,
  xray_sub_id text,
  subscription_url text,
  subscription_payload_cache text,
  client_email text,
  is_trial boolean not null default false,
  extra_devices int not null default 0,
  panel_ip_clear_requested_at timestamptz,
  last_device_reset timestamptz,
  pending_xray_sub_id text,
  panel_sub_rotate_requested_at timestamptz,
  purchased_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists addon_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  addon_type text not null,
  label text not null,
  quantity int not null default 1,
  price_rub int not null default 0,
  purchased_at timestamptz not null default now()
);

create table if not exists partners (
  id bigint primary key,
  username text,
  display_name text not null,
  social_links jsonb not null default '[]'::jsonb,
  balance numeric(12, 2) not null default 0,
  total_referrals int not null default 0,
  commission_percent int not null default 50,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists partner_requisites (
  id uuid primary key default gen_random_uuid(),
  partner_id bigint not null references partners(id) on delete cascade,
  method text not null check (method in ('sbp', 'card')),
  details text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  discount_percent int not null check (discount_percent between 1 and 100),
  partner_id bigint references partners(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  amount numeric(12, 2) not null,
  billing_months int not null,
  promo_code_id uuid references promo_codes(id) on delete set null,
  payment_method text not null check (payment_method in ('sbp', 'card', 'crypto_usdt')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  screenshot_file_id text,
  sender_name text,
  manager_note text,
  is_first_payment boolean not null default false,
  partner_commission_amount numeric(12, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists withdrawals (
  id uuid primary key default gen_random_uuid(),
  partner_id bigint not null references partners(id) on delete cascade,
  amount numeric(12, 2) not null,
  method text not null check (method in ('sbp', 'card')),
  details text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  manager_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists promo_requests (
  id uuid primary key default gen_random_uuid(),
  partner_id bigint not null references partners(id) on delete cascade,
  requested_code text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create table if not exists xui_client_inbounds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  inbound_id int not null,
  client_uuid text not null,
  client_email text not null,
  created_at timestamptz not null default now(),
  unique (user_id, inbound_id)
);

create table if not exists bot_sessions (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  bot_kind text not null check (bot_kind in ('client', 'partner')),
  state text not null default 'idle',
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (telegram_id, bot_kind)
);

create table if not exists vpn_device_bindings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  os text not null,
  vpn_client text not null,
  label text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, os, vpn_client)
);

create index if not exists idx_users_telegram_id on users(telegram_id);
create index if not exists idx_users_ref_partner on users(ref_by_partner_id);
create index if not exists idx_addon_purchases_user_id on addon_purchases(user_id);
create index if not exists idx_transactions_user_id on transactions(user_id);
create index if not exists idx_transactions_status on transactions(status);
create index if not exists idx_withdrawals_partner_id on withdrawals(partner_id);
create index if not exists idx_partner_requisites_partner_id on partner_requisites(partner_id);
create index if not exists idx_xui_client_inbounds_user_id on xui_client_inbounds(user_id);
create index if not exists vpn_device_bindings_user_id_idx on vpn_device_bindings(user_id);

alter table users enable row level security;
alter table subscriptions enable row level security;
alter table addon_purchases enable row level security;
alter table partners enable row level security;
alter table partner_requisites enable row level security;
alter table promo_codes enable row level security;
alter table transactions enable row level security;
alter table withdrawals enable row level security;
alter table promo_requests enable row level security;
alter table xui_client_inbounds enable row level security;
alter table bot_sessions enable row level security;
alter table vpn_device_bindings enable row level security;
