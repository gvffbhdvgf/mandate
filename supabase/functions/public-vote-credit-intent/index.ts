import { adminClient, authenticate, corsHeaders, json, paymentPurposeEnabled } from "../_shared/paystack.ts";

Deno.serve(async (request: Request) => {
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" }, cors);

  try {
    if (!paymentPurposeEnabled("public_vote_credits")) {
      return json(503, { error: "PAYMENT_PURPOSE_DISABLED" }, cors);
    }

    const { user } = await authenticate(request);
    if (!user.email || !user.email_confirmed_at) {
      return json(403, { error: "VERIFIED_EMAIL_REQUIRED" }, cors);
    }

    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
    if (!/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey)) {
      return json(400, { error: "IDEMPOTENCY_KEY_REQUIRED" }, cors);
    }

    let body: { slug?: string; quantity?: number };
    try {
      body = await request.json();
    } catch {
      return json(400, { error: "INVALID_REQUEST_BODY" }, cors);
    }

    const slug = body.slug?.trim().toLowerCase() ?? "";
    const quantity = body.quantity;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80
      || !Number.isSafeInteger(quantity) || !quantity || quantity < 1 || quantity > 100000) {
      return json(400, { error: "INVALID_PUBLIC_VOTE_CREDIT_REQUEST" }, cors);
    }

    const providerReference = `mandate_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = adminClient();
    const { data: releaseFlags, error: releaseFlagsError } = await admin
      .from("platform_payment_feature_flags")
      .select("public_vote_credits_enabled")
      .eq("singleton", true)
      .maybeSingle();
    if (releaseFlagsError || releaseFlags?.public_vote_credits_enabled !== true) {
      return json(503, { error: "PAYMENT_PURPOSE_DISABLED" }, cors);
    }

    const { data, error } = await admin.rpc("create_public_vote_credit_payment_intent", {
      p_auth_user_id: user.id,
      p_election_slug: slug,
      p_quantity: quantity,
      p_idempotency_key: idempotencyKey,
      p_provider_reference: providerReference,
    });

    if (error || !data) {
      const message = error?.message ?? "";
      const code = message.includes("PARTICIPANT_CREDIT_CAP_EXCEEDED") ? "PARTICIPANT_CREDIT_CAP_EXCEEDED"
        : message.includes("VERIFIED_PARTICIPANT_REQUIRED") ? "VERIFIED_PARTICIPANT_REQUIRED"
        : message.includes("PUBLIC_PAID_ELECTION_NOT_READY") ? "PUBLIC_PAID_ELECTION_NOT_READY"
        : message.includes("IDEMPOTENCY_CONFLICT") ? "IDEMPOTENCY_CONFLICT"
        : message.includes("PUBLIC_ELECTION_NOT_FOUND") ? "PUBLIC_ELECTION_NOT_FOUND"
        : "PUBLIC_VOTE_CREDIT_INTENT_FAILED";
      const status = code === "PUBLIC_ELECTION_NOT_FOUND" ? 404
        : code === "VERIFIED_PARTICIPANT_REQUIRED" ? 403
        : code === "PARTICIPANT_CREDIT_CAP_EXCEEDED" || code === "IDEMPOTENCY_CONFLICT" ? 409
        : code === "PUBLIC_PAID_ELECTION_NOT_READY" ? 409
        : 500;
      return json(status, { error: code }, cors);
    }

    return json(200, {
      paymentIntentId: data.paymentIntentId,
      reference: data.reference,
      amountMinor: data.amountMinor,
      credits: data.credits,
      duplicate: data.duplicate === true,
    }, cors);
  } catch (error) {
    const code = error instanceof Error ? error.message : "PUBLIC_VOTE_CREDIT_INTENT_FAILED";
    const status = code === "AUTHENTICATION_REQUIRED" || code === "INVALID_SESSION" ? 401
      : code === "SUPABASE_FUNCTION_CONFIG_MISSING" ? 503
      : 500;
    return json(status, { error: code }, cors);
  }
});
