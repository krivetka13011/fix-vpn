create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  username text,
  display_name text not null,
  photo_url text,
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
  extra_devices int not null default 0,
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

create index if not exists idx_users_telegram_id on users(telegram_id);
create index if not exists idx_addon_purchases_user_id on addon_purchases(user_id);

alter table users enable row level security;
alter table subscriptions enable row level security;
alter table addon_purchases enable row level security;
