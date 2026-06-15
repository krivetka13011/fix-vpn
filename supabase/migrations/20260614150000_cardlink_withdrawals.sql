alter table withdrawals
  add column if not exists cardlink_payout_id text,
  add column if not exists payout_source text check (payout_source in ('manual', 'cardlink'));

alter table withdrawals drop constraint if exists withdrawals_status_check;
alter table withdrawals add constraint withdrawals_status_check
  check (status in ('pending', 'processing', 'approved', 'rejected'));
