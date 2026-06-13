alter table subscriptions
  add column if not exists panel_ip_clear_requested_at timestamptz;
