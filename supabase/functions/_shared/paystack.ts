import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";

export type PaymentPurpose = "platform_fee" | "organization_topup" | "public_vote_credits";

type PaystackModeConfig = { mode: "test" | "live"; secretKey: string; webhookSecret: string };

export const json = (status: number, body: Record<string, unknown>, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

export const corsHeaders = (request: Request) => {
  const origin = request.headers.get("Origin") ?? "";
  const configured = (Deno.env.get("MANDATE_ALLOWED_ORIGINS") ?? Deno.env.get("MANDATE_SITE_URL") ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const allowed = origin && (configured.includes(origin) || origin === "http://localhost:3000" || origin === "http://localhost:3001");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};

export const env = (name: string) => Deno.env.get(name)?.trim() ?? "";

export const adminClient = () => {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_FUNCTION_CONFIG_MISSING");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
};

export async function authenticate(request: Request): Promise<{ user: User; caller: SupabaseClient }> {
  const url = env("SUPABASE_URL");
  const anon = env("SUPABASE_ANON_KEY");
  const authorization = request.headers.get("Authorization");
  if (!url || !anon) throw new Error("SUPABASE_FUNCTION_CONFIG_MISSING");
  if (!authorization?.startsWith("Bearer ")) throw new Error("AUTHENTICATION_REQUIRED");
  const token = authorization.slice("Bearer ".length);
  const caller = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await caller.auth.getUser(token);
  if (error || !data.user) throw new Error("INVALID_SESSION");
  return { user: data.user, caller };
}

export async function assertOrganizationFinanceManager(caller: SupabaseClient, organizationId: string, userId: string) {
  const { data, error } = await caller
    .from("organization_members")
    .select("role,status")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data || data.status !== "active" || !["owner", "admin", "finance_manager"].includes(data.role)) {
    throw new Error("FORBIDDEN");
  }
}

function paystackModeConfig(): PaystackModeConfig | null {
  const mode = env("PAYSTACK_MODE");
  if (mode === "test") {
    const secretKey = env("PAYSTACK_TEST_SECRET_KEY");
    const webhookSecret = env("PAYSTACK_TEST_WEBHOOK_SECRET");
    if (!secretKey.startsWith("sk_test_") || !webhookSecret) return null;
    return { mode: "test", secretKey, webhookSecret };
  }
  if (mode === "live") {
    if (env("PAYSTACK_LIVE_TRANSACTIONS_ENABLED").toLowerCase() !== "true"
      || env("PAYSTACK_LIVE_SETTLEMENT_PIPELINE_ENABLED").toLowerCase() !== "true") return null;
    const secretKey = env("PAYSTACK_LIVE_SECRET_KEY");
    const webhookSecret = env("PAYSTACK_LIVE_WEBHOOK_SECRET");
    if (!secretKey.startsWith("sk_live_") || !webhookSecret) return null;
    return { mode: "live", secretKey, webhookSecret };
  }
  return null;
}

export const paymentsModeEnabled = () => paystackModeConfig() !== null;

export const paymentPurposeEnabled = (purpose: PaymentPurpose) => {
  const config = paystackModeConfig();
  if (!config) return false;
  const purposeKey = purpose.toUpperCase();
  return env(`PAYSTACK_${config.mode.toUpperCase()}_${purposeKey}_ENABLED`).toLowerCase() === "true";
};

export function paymentCallbackUrl(): string | undefined {
  const configured = env("MANDATE_PAYMENT_CALLBACK_URL");
  const siteUrl = env("MANDATE_SITE_URL");
  let candidate = configured;
  if (!candidate && siteUrl) {
    try {
      candidate = new URL("/payments/paystack/callback", siteUrl).toString();
    } catch {
      throw new Error("PAYMENT_CALLBACK_URL_INVALID");
    }
  }
  if (!candidate) return undefined;

  let callback: URL;
  try {
    callback = new URL(candidate);
  } catch {
    throw new Error("PAYMENT_CALLBACK_URL_INVALID");
  }

  const allowedOrigins = [siteUrl, ...env("MANDATE_ALLOWED_ORIGINS").split(",")]
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try { return new URL(value).origin; } catch { return ""; }
    })
    .filter(Boolean);

  if (callback.protocol !== "https:"
    || callback.username
    || callback.password
    || callback.pathname !== "/payments/paystack/callback"
    || callback.search
    || callback.hash
    || !allowedOrigins.includes(callback.origin)) {
    throw new Error("PAYMENT_CALLBACK_URL_INVALID");
  }
  return callback.toString();
}

export async function paystackRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = paystackModeConfig();
  if (!config) throw new Error("PAYSTACK_MODE_CONFIG_INVALID");
  const response = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.status) {
    throw new Error("PAYSTACK_REQUEST_FAILED");
  }
  return payload as T;
}

const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function verifyPaystackWebhookSignature(rawBody: string, signatureHeader: string | null) {
  const config = paystackModeConfig();
  if (!config || !signatureHeader) return false;

  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !/^\d{10}$/.test(timestamp) || signatures.length === 0) return false;

  const signedAt = Number(timestamp);
  if (!Number.isSafeInteger(signedAt) || Math.abs(Math.floor(Date.now() / 1000) - signedAt) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.webhookSecret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const digest = toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  return signatures.some((candidate) => {
    const colon = candidate.indexOf(":");
    const signature = colon >= 0 ? candidate.slice(colon + 1) : candidate;
    if (!/^[0-9a-f]{128}$/i.test(signature)) return false;
    let difference = digest.length ^ signature.length;
    for (let index = 0; index < Math.min(digest.length, signature.length); index++) {
      difference |= digest.charCodeAt(index) ^ signature.toLowerCase().charCodeAt(index);
    }
    return difference === 0;
  });
}
