alter table partner_requisites
  add column if not exists sbp_bank_id text;

alter table withdrawals
  add column if not exists sbp_bank_id text;
