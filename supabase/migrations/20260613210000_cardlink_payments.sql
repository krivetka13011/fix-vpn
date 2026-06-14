alter table transactions
  add column if not exists cardlink_bill_id text,
  add column if not exists payment_url text;
