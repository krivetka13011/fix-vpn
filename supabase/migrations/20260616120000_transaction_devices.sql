alter table transactions
  add column if not exists extra_devices int not null default 0;
