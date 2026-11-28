import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("organization disbursements use the existing payable ledger and dual approval", async () => {
  const migration = await read("../supabase/migrations/20261128110000_0051_paystack_organization_disbursements.sql");
  assert.match(migration, /organization_payout_recipients/);
  assert.match(migration, /recipient_code text not null unique/);
  assert.match(migration, /masked_account text not null/);
  assert.doesNotMatch(migration, /account_number text|phone_number text|bank_account_number text/i);
  assert.match(migration, /encrypted_destination_reference drop not null/);
  assert.match(migration, /PAYOUT_DUAL_CONTROL_REQUIRED/);
  assert.match(migration, /INSUFFICIENT_RECONCILED_ORGANIZATION_FUNDS/);
  assert.match(migration, /status in \('requested','under_review','approved','processing'\)/);
  assert.match(migration, /organization_payable/);
  assert.match(migration, /payout_requests_recipient_required/);
});

test("transfer settlement is webhook/API verified and idempotently posted", async () => {
  const migration = await read("../supabase/migrations/20261128110000_0051_paystack_organization_disbursements.sql");
  assert.match(migration, /paystack_transfer_events/);
  assert.match(migration, /signature_verified is distinct from true and v_event\.verification_source <> 'api_verify'/);
  assert.match(migration, /paystack-transfer-settlement:/);
  assert.match(migration, /paystack-transfer-reversal:/);
  assert.match(migration, /p_provider_fee_minor is null/);
  assert.match(migration, /revoke all on function mandate_private\.apply_paystack_transfer_status[\s\S]*?from public,anon,authenticated/);
});

test("disbursement endpoint never stores raw beneficiary account details", async () => {
  const endpoint = await read("../supabase/functions/paystack-disbursements/index.ts");
  assert.match(endpoint, /\/transferrecipient/);
  assert.match(endpoint, /masked_account:/);
  assert.doesNotMatch(endpoint, /account_number:\s*accountNumber\s*[,}][\s\S]{0,100}\.insert\(/);
  assert.match(endpoint, /claim_organization_payout/);
  assert.match(endpoint, /TRANSFER_OUTCOME_UNKNOWN/);
  assert.match(endpoint, /retryWithSameRequest:\s*true/);
  assert.match(endpoint, /\/transfer\/verify\//);
  assert.match(endpoint, /finalize_transfer/);
  assert.match(endpoint, /resend_otp/);
  assert.match(endpoint, /TRANSFER_OTP_INVALID/);
});

test("Paystack webhook reconciles transfer events through verified provider facts", async () => {
  const webhook = await read("../supabase/functions/paystack-webhook/index.ts");
  assert.match(webhook, /transfer\.success/);
  assert.match(webhook, /transfer\.failed/);
  assert.match(webhook, /transfer\.reversed/);
  assert.match(webhook, /\/transfer\/verify\//);
  assert.match(webhook, /apply_paystack_transfer_status/);
  assert.match(webhook, /verification_source:\s*"webhook"/);
});

test("disbursement function requires a user JWT", async () => {
  const config = await read("../supabase/config.toml");
  assert.match(config, /\[functions\.paystack-disbursements\][\s\S]*?verify_jwt = true/);
});
