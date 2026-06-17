alter table transactions
  add column if not exists plan_type text not null default 'basic'
    check (plan_type in ('basic', 'personal'));

alter table transactions
  add column if not exists platega_transaction_id text;
