alter table subscriptions
  add column if not exists last_device_reset timestamptz;
