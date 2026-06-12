alter table users
  add column if not exists is_tester boolean not null default false;

create index if not exists idx_users_is_tester on users(is_tester) where is_tester = true;
