import { adminClient, assertOrganizationFinanceManager, authenticate, corsHeaders, json, paystackRequest, paymentCallbackUrl, paymentPurposeEnabled, paymentsModeEnabled } from "../_shared/paystack.ts";

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
      return json(503, { error: "PAYMENTS_DISABLED", message: "A valid mode-specific Paystack configuration is required." }, cors);
    }

    const { user, caller } = await authenticate(request);
    const body = await request.json().catch(() => null) as { paymentIntentId?: string } | null;
    if (!body?.paymentIntentId || !/^[0-9a-f-]{36}$/i.test(body.paymentIntentId)) {
      return json(400, { error: "INVALID_PAYMENT_INTENT_ID" }, cors);
    }

    const admin = adminClient();
    const { data: intent, error } = await admin
      .from("payment_intents")
      .select("id,organization_id,election_id,participant_id,purpose,provider,provider_reference,amount_minor,currency,status,split_status,split_subaccount_profile_id,split_fee_type,split_fixed_fee_minor,split_percentage_basis_points,split_fee_bearer")
      .eq("id", body.paymentIntentId)
      .maybeSingle();
    if (error || !intent) return json(404, { error: "PAYMENT_INTENT_NOT_FOUND" }, cors);
    if (intent.provider !== "paystack" || intent.currency !== "KES" || !Number.isSafeInteger(Number(intent.amount_minor)) || Number(intent.amount_minor) <= 0) {
      return json(409, { error: "PAYMENT_INTENT_INVALID" }, cors);
    }
    if (!paymentPurposeEnabled(intent.purpose)) {
      return json(503, { error: "PAYMENT_PURPOSE_DISABLED" }, cors);
    }
    let splitInitialization: Record<string, string> = {};
    if (intent.purpose === "public_vote_credits") {
      // Fail closed unless an immutable approved split snapshot is attached.
      if (intent.split_status !== "pending" || !intent.split_subaccount_profile_id
        || !["fixed", "percentage"].includes(intent.split_fee_type)
        || !["mandate", "organizer"].includes(intent.split_fee_bearer)) {
        return json(503, { error: "PAYSTACK_SPLIT_NOT_CONFIGURED" }, cors);
      }
      const { data: subaccount, error: subaccountError } = await admin
        .from("organization_paystack_subaccounts")
        .select("provider_subaccount_code,currency,status,provider_percentage_charge_basis_points")
        .eq("id", intent.split_subaccount_profile_id)
        .maybeSingle();
      if (subaccountError || !subaccount || subaccount.status !== "verified"
        || subaccount.currency !== intent.currency || !subaccount.provider_subaccount_code) {
        return json(503, { error: "VERIFIED_ORGANIZER_SUBACCOUNT_REQUIRED" }, cors);
      }
      const feeBearer = intent.split_fee_bearer === "organizer" ? "subaccount" : "account";
      if (intent.split_fee_type === "fixed") {
        const fixedFee = Number(intent.split_fixed_fee_minor);
        if (!Number.isSafeInteger(fixedFee) || fixedFee <= 0 || fixedFee >= Number(intent.amount_minor)) {
          return json(409, { error: "PUBLIC_VOTE_SPLIT_FEE_INVALID" }, cors);
        }
        splitInitialization = {
          subaccount: subaccount.provider_subaccount_code,
          transaction_charge: String(fixedFee),
          bearer: feeBearer,
        };
      } else {
        // Percentage settlement is deliberately disabled until Paystack's exact
        // KES rounding behavior is covered by provider evidence and acceptance tests.
        return json(503, { error: "PERCENTAGE_SPLIT_ROUNDING_NOT_YET_APPROVED" }, cors);
      }
      const { data: releaseFlags, error: releaseFlagsError } = await admin
        .from("platform_payment_feature_flags")
        .select("public_vote_credits_enabled")
        .eq("singleton", true)
        .maybeSingle();
      if (releaseFlagsError || releaseFlags?.public_vote_credits_enabled !== true) {
        return json(503, { error: "PAYMENT_PURPOSE_DISABLED" }, cors);
      }
      if (intent.organization_id || !intent.election_id || !intent.participant_id) {
        return json(409, { error: "PUBLIC_PARTICIPANT_PAYMENT_SCOPE_INVALID" }, cors);
      }
      const { data: participant, error: participantError } = await admin
        .from("public_participants")
        .select("auth_user_id,verification_status")
        .eq("id", intent.participant_id)
        .eq("election_id", intent.election_id)
        .maybeSingle();
      if (participantError || !participant || participant.auth_user_id !== user.id
        || participant.verification_status !== "verified" || !user.email_confirmed_at) {
        return json(403, { error: "VERIFIED_PARTICIPANT_REQUIRED" }, cors);
      }
    } else {
      if (!intent.organization_id) return json(409, { error: "PAYMENT_INTENT_REQUIRES_ORGANIZATION" }, cors);
      await assertOrganizationFinanceManager(caller, intent.organization_id, user.id);
    }
    if (!user.email) return json(400, { error: "ACCOUNT_EMAIL_REQUIRED" }, cors);

    // A completed attempt is reusable even though the payment intent has moved to
    // pending. In-flight/unknown attempts are never automatically retried.
    const { data: priorAttempt, error: priorAttemptError } = await admin
      .from("payment_initialization_attempts")
      .select("status,authorization_url,access_code")
      .eq("payment_intent_id", intent.id)
      .maybeSingle();
    if (priorAttemptError) return json(500, { error: "PAYMENT_INITIALIZATION_STATE_UNAVAILABLE" }, cors);
    if (priorAttempt?.status === "initialized" && priorAttempt.authorization_url && priorAttempt.access_code) {
      return json(200, {
        authorizationUrl: priorAttempt.authorization_url,
        accessCode: priorAttempt.access_code,
        reference: intent.provider_reference,
        duplicate: true,
      }, cors);
    }
    if (priorAttempt) {
      return json(409, { error: "PAYMENT_INITIALIZATION_OUTCOME_UNKNOWN", message: "This reference may already have been submitted to Paystack. Reconcile it before retrying." }, cors);
    }
    if (intent.status !== "initialized") return json(409, { error: "PAYMENT_INTENT_NOT_INITIALIZABLE" }, cors);
    const callbackUrl = paymentCallbackUrl();

    // The unique payment_intent_id is the database-level serialization point.
    // If another request already claimed this intent, reuse a completed checkout
    // response or fail closed; never issue a second provider initialization.
    const { data: claimed, error: claimError } = await admin
      .from("payment_initialization_attempts")
      .insert({ payment_intent_id: intent.id, status: "initializing" })
      .select("status,authorization_url,access_code")
      .maybeSingle();

    let attempt = claimed;
    if (!claimError && !claimed) return json(500, { error: "PAYMENT_INITIALIZATION_CLAIM_FAILED" }, cors);
    if (claimError) {
      if (claimError.code !== "23505") {
        return json(500, { error: "PAYMENT_INITIALIZATION_CLAIM_FAILED" }, cors);
      }
      const { data: existing, error: existingError } = await admin
        .from("payment_initialization_attempts")
        .select("status,authorization_url,access_code")
        .eq("payment_intent_id", intent.id)
        .maybeSingle();
      if (existingError || !existing) return json(500, { error: "PAYMENT_INITIALIZATION_STATE_UNAVAILABLE" }, cors);
      attempt = existing;
    }

    if (attempt?.status === "initialized" && attempt.authorization_url && attempt.access_code) {
      return json(200, {
        authorizationUrl: attempt.authorization_url,
        accessCode: attempt.access_code,
        reference: intent.provider_reference,
        duplicate: true,
      }, cors);
    }
    if (attempt !== claimed) {
      return json(409, { error: "PAYMENT_INITIALIZATION_OUTCOME_UNKNOWN", message: "This reference may already have been submitted to Paystack. Reconcile it before retrying." }, cors);
    }

    let result: PaystackInitializeResponse;
    try {
      result = await paystackRequest<PaystackInitializeResponse>("/transaction/initialize", {
        method: "POST",
        body: JSON.stringify({
          email: user.email,
          amount: String(intent.amount_minor),
          currency: intent.currency,
          ...splitInitialization,
          reference: intent.provider_reference,
          ...(callbackUrl ? { callback_url: callbackUrl } : {}),
          metadata: {
            payment_intent_id: intent.id,
            organization_id: intent.organization_id,
            purpose: intent.purpose,
          },
        }),
      });
    } catch {
      // Network failures and provider errors can be ambiguous. Keep the claim;
      // an operator must verify the existing reference before any retry.
      await admin.from("payment_initialization_attempts")
        .update({ status: "unknown" })
        .eq("payment_intent_id", intent.id)
        .eq("status", "initializing");
      return json(502, { error: "PAYMENT_INITIALIZATION_OUTCOME_UNKNOWN", message: "Check the existing Paystack reference before attempting payment again." }, cors);
    }

    let authorizationUrl: URL;
    try {
      authorizationUrl = new URL(result.data.authorization_url);
    } catch {
      authorizationUrl = new URL("http://invalid.local");
    }
    if (result.data.reference !== intent.provider_reference
      || authorizationUrl.protocol !== "https:"
      || !result.data.access_code) {
      await admin.from("payment_initialization_attempts")
        .update({ status: "unknown" })
        .eq("payment_intent_id", intent.id)
        .eq("status", "initializing");
      return json(502, { error: "PAYMENT_INITIALIZATION_RESPONSE_INVALID" }, cors);
    }

    const { error: attemptUpdateError } = await admin
      .from("payment_initialization_attempts")
      .update({
        status: "initialized",
        authorization_url: result.data.authorization_url,
        access_code: result.data.access_code,
        completed_at: new Date().toISOString(),
      })
      .eq("payment_intent_id", intent.id)
      .eq("status", "initializing");
    if (attemptUpdateError) {
      await admin.from("payment_initialization_attempts")
        .update({ status: "unknown" })
        .eq("payment_intent_id", intent.id)
        .eq("status", "initializing");
      return json(502, { error: "PAYMENT_INITIALIZATION_PERSISTENCE_UNKNOWN" }, cors);
    }

    await admin.from("payment_intents")
      .update({ status: "pending" })
      .eq("id", intent.id)
      .eq("status", "initialized");

    return json(200, {
      authorizationUrl: result.data.authorization_url,
      accessCode: result.data.access_code,
      reference: result.data.reference,
      duplicate: false,
    }, cors);
  } catch (error) {
    const code = error instanceof Error ? error.message : "PAYMENT_INITIALIZATION_FAILED";
    const status = code === "AUTHENTICATION_REQUIRED" || code === "INVALID_SESSION" ? 401
      : code === "FORBIDDEN" ? 403
      : code === "PAYMENT_CALLBACK_URL_INVALID" || code === "PAYSTACK_MODE_CONFIG_INVALID" || code === "SUPABASE_FUNCTION_CONFIG_MISSING" ? 503
      : 500;
    return json(status, { error: code }, cors);
  }
});
