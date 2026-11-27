import { paymentPurposeEnabled, paymentsModeEnabled, verifyPaystackWebhookSignature } from "./paystack.ts";

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

async function signedHeader(body: string, timestamp: number, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return `t=${timestamp},v1=whk_test_key:${hex(digest)}`;
}

function clearPaystackEnv() {
  for (const key of [
    "PAYSTACK_MODE",
    "PAYSTACK_TEST_SECRET_KEY",
    "PAYSTACK_TEST_WEBHOOK_SECRET",
    "PAYSTACK_LIVE_SECRET_KEY",
    "PAYSTACK_LIVE_WEBHOOK_SECRET",
    "PAYSTACK_LIVE_TRANSACTIONS_ENABLED",
    "PAYSTACK_TEST_PLATFORM_FEE_ENABLED",
    "PAYSTACK_TEST_ORGANIZATION_TOPUP_ENABLED",
    "PAYSTACK_TEST_PUBLIC_VOTE_CREDITS_ENABLED",
    "PAYSTACK_LIVE_PLATFORM_FEE_ENABLED",
    "PAYSTACK_LIVE_ORGANIZATION_TOPUP_ENABLED",
    "PAYSTACK_LIVE_PUBLIC_VOTE_CREDITS_ENABLED",
    "PAYSTACK_SECRET_KEY",
    "PAYSTACK_WEBHOOK_SECRET",
  ]) Deno.env.delete(key);
}

Deno.test("Paystack mode config fails closed for missing, mixed or mismatched credentials", () => {
  clearPaystackEnv();
  if (paymentsModeEnabled()) throw new Error("Missing mode must be disabled");

  Deno.env.set("PAYSTACK_MODE", "test");
  Deno.env.set("PAYSTACK_TEST_SECRET_KEY", "sk_live_wrong_mode");
  Deno.env.set("PAYSTACK_TEST_WEBHOOK_SECRET", "test-webhook-secret");
  if (paymentsModeEnabled()) throw new Error("Live key in test mode must be disabled");

  Deno.env.set("PAYSTACK_TEST_SECRET_KEY", "sk_test_unit_test_key");
  if (!paymentsModeEnabled()) throw new Error("Valid test key and webhook secret should configure test mode");

  Deno.env.set("PAYSTACK_MODE", "live");
  Deno.env.set("PAYSTACK_LIVE_SECRET_KEY", "sk_live_unit_test_key");
  Deno.env.set("PAYSTACK_LIVE_WEBHOOK_SECRET", "live-webhook-secret");
  if (paymentsModeEnabled()) throw new Error("Live mode must remain disabled without explicit master switch");
  Deno.env.set("PAYSTACK_LIVE_TRANSACTIONS_ENABLED", "true");
  if (!paymentsModeEnabled()) throw new Error("Explicitly configured live mode should pass configuration validation");
  clearPaystackEnv();
});

Deno.test("Paystack payment purposes are independently disabled unless explicitly enabled", () => {
  clearPaystackEnv();
  Deno.env.set("PAYSTACK_MODE", "test");
  Deno.env.set("PAYSTACK_TEST_SECRET_KEY", "sk_test_unit_test_key");
  Deno.env.set("PAYSTACK_TEST_WEBHOOK_SECRET", "test-webhook-secret");
  for (const purpose of ["PLATFORM_FEE", "ORGANIZATION_TOPUP", "PUBLIC_VOTE_CREDITS"]) {
    if (paymentPurposeEnabled(purpose.toLowerCase() as "platform_fee" | "organization_topup" | "public_vote_credits")) {
      throw new Error(`${purpose} must default to disabled`);
    }
  }
  Deno.env.set("PAYSTACK_TEST_PLATFORM_FEE_ENABLED", "true");
  if (!paymentPurposeEnabled("platform_fee")) throw new Error("Platform fee flag should enable only platform_fee");
  if (paymentPurposeEnabled("organization_topup") || paymentPurposeEnabled("public_vote_credits")) {
    throw new Error("Enabling platform_fee must not enable another purpose");
  }
  clearPaystackEnv();
});

Deno.test("Paystack webhook signatures reject tampering, stale timestamps and missing headers", async () => {
  clearPaystackEnv();
  const secret = "whsec_unit_test_secret_never_used_in_production";
  Deno.env.set("PAYSTACK_MODE", "test");
  Deno.env.set("PAYSTACK_TEST_SECRET_KEY", "sk_test_unit_test_key");
  Deno.env.set("PAYSTACK_TEST_WEBHOOK_SECRET", secret);
  try {
    const body = JSON.stringify({ event: "charge.success", data: { reference: "mandate-test-123" } });
    const now = Math.floor(Date.now() / 1000);
    const validHeader = await signedHeader(body, now, secret);

    if (!await verifyPaystackWebhookSignature(body, validHeader)) {
      throw new Error("Expected a valid Paystack signature to be accepted");
    }
    if (await verifyPaystackWebhookSignature(body + " ", validHeader)) {
      throw new Error("Expected a modified raw body to be rejected");
    }
    const staleHeader = await signedHeader(body, now - 301, secret);
    if (await verifyPaystackWebhookSignature(body, staleHeader)) {
      throw new Error("Expected a stale timestamp to be rejected");
    }
    if (await verifyPaystackWebhookSignature(body, null)) {
      throw new Error("Expected a missing signature to be rejected");
    }
  } finally {
    clearPaystackEnv();
  }
});
