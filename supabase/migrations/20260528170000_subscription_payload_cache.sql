alter table subscriptions
  add column if not exists subscription_payload_cache text;
