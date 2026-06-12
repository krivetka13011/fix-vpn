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

create index if not exists vpn_device_bindings_user_id_idx
  on vpn_device_bindings (user_id);
