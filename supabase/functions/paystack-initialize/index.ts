import { adminClient, assertOrganizationManager, authenticate, corsHeaders, json, paystackRequest, paymentPurposeEnabled, paymentsModeEnabled } from "../_shared/paystack.ts";

type PaystackInitializeResponse = {
  status: boolean;
  data: { authorization_url: string; access_code: string; reference: string };
};

Deno.serve(async (request: Request) => {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" }, cors);

  try {
    if (!paymentsModeEnabled()) {
      return json(503, { error: "PAYMENTS_DISABLED", message: "Only Paystack test credentials can initialize development transactions. Live transactions remain disabled." }, cors);
    }

    const { user, caller } = await authenticate(request);
    const body = await request.json().catch(() => null) as { paymentIntentId?: string } | null;
    if (!body?.paymentIntentId || !/^[0-9a-f-]{36}$/i.test(body.paymentIntentId)) {
      return json(400, { error: "INVALID_PAYMENT_INTENT_ID" }, cors);
    }

    const admin = adminClient();
    const { data: intent, error } = await admin
      .from("payment_intents")
      .select("id,organization_id,election_id,purpose,provider,provider_reference,amount_minor,currency,status")
      .eq("id", body.paymentIntentId)
      .maybeSingle();
    if (error || !intent) return json(404, { error: "PAYMENT_INTENT_NOT_FOUND" }, cors);
    if (!intent.organization_id) return json(409, { error: "PAYMENT_INTENT_REQUIRES_ORGANIZATION" }, cors);
    if (intent.provider !== "paystack" || intent.currency !== "KES" || !Number.isSafeInteger(Number(intent.amount_minor)) || Number(intent.amount_minor) <= 0) {
      return json(409, { error: "PAYMENT_INTENT_INVALID" }, cors);
    }
    if (!paymentPurposeEnabled(intent.purpose)) {
      return json(503, { error: "PAYMENT_PURPOSE_DISABLED" }, cors);
    }
    if (intent.purpose === "public_vote_credits") {
      return json(409, { error: "PAID_VOTING_FEATURE_GATED" }, cors);
    }
    if (intent.status !== "initialized") return json(409, { error: "PAYMENT_INTENT_NOT_INITIALIZABLE" }, cors);

    await assertOrganizationManager(caller, intent.organization_id, user.id);
    if (!user.email) return json(400, { error: "ACCOUNT_EMAIL_REQUIRED" }, cors);

    const result = await paystackRequest<PaystackInitializeResponse>("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email: user.email,
        amount: String(intent.amount_minor),
        currency: intent.currency,
        reference: intent.provider_reference,
        metadata: {
          payment_intent_id: intent.id,
          organization_id: intent.organization_id,
          purpose: intent.purpose,
        },
      }),
    });

    const { error: updateError } = await admin
      .from("payment_intents")
      .update({ status: "pending" })
      .eq("id", intent.id)
      .eq("status", "initialized");
    if (updateError) return json(500, { error: "PAYMENT_INTENT_UPDATE_FAILED" }, cors);

    return json(200, {
      authorizationUrl: result.data.authorization_url,
      accessCode: result.data.access_code,
      reference: result.data.reference,
    }, cors);
  } catch (error) {
    const code = error instanceof Error ? error.message : "PAYMENT_INITIALIZATION_FAILED";
    const status = code === "AUTHENTICATION_REQUIRED" || code === "INVALID_SESSION" ? 401
      : code === "FORBIDDEN" ? 403
      : code === "PAYSTACK_SECRET_KEY_MISSING" || code === "SUPABASE_FUNCTION_CONFIG_MISSING" ? 503
      : 500;
    return json(status, { error: code }, cors);
  }
});
