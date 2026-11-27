import { verifyPaystackWebhookSignature } from "./paystack.ts";

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

Deno.test("Paystack webhook signatures reject tampering, stale timestamps and missing headers", async () => {
  const secret = "whsec_unit_test_secret_never_used_in_production";
  Deno.env.set("PAYSTACK_WEBHOOK_SECRET", secret);
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
    Deno.env.delete("PAYSTACK_WEBHOOK_SECRET");
  }
});
