ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS pending_xray_sub_id text,
  ADD COLUMN IF NOT EXISTS panel_sub_rotate_requested_at timestamptz;
