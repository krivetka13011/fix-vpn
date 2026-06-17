alter table subscriptions
  add column if not exists expires_at timestamptz,
  add column if not exists expiry_warned_at timestamptz;

create index if not exists idx_subscriptions_expires_at
  on subscriptions (expires_at)
  where status = 'active' and expires_at is not null;
