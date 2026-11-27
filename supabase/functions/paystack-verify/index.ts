import { adminClient, assertOrganizationFinanceManager, authenticate, corsHeaders, json, paystackRequest, paymentsModeEnabled } from "../_shared/paystack.ts";

type PaystackVerifyResponse = {
  status: boolean;
  data: {
    id: number | string;
    status: string;
    reference: string;
    amount: number;
    currency: string;
  };
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
    const body = await request.json().catch(() => null) as { reference?: string } | null;
    if (!body?.reference || !/^[A-Za-z0-9.=-]{8,100}$/.test(body.reference)) {
      return json(400, { error: "INVALID_PAYMENT_REFERENCE" }, cors);
    }

    const admin = adminClient();
    const { data: intent, error } = await admin
      .from("payment_intents")
      .select("id,organization_id,election_id,participant_id,purpose,provider_reference,amount_minor,currency,status,provider_transaction_id")
      .eq("provider_reference", body.reference)
      .maybeSingle();
    if (error || !intent) return json(404, { error: "PAYMENT_INTENT_NOT_FOUND" }, cors);
    if (!paymentsModeEnabled()) return json(503, { error: "PAYMENT_PROVIDER_CONFIGURATION_UNAVAILABLE" }, cors);
    if (intent.purpose === "public_vote_credits") {
      if (intent.organization_id || !intent.election_id || !intent.participant_id || !user.email_confirmed_at) {
        return json(403, { error: "VERIFIED_PARTICIPANT_REQUIRED" }, cors);
      }
      const { data: participant, error: participantError } = await admin
        .from("public_participants")
        .select("auth_user_id,verification_status")
        .eq("id", intent.participant_id)
        .eq("election_id", intent.election_id)
        .maybeSingle();
      if (participantError || !participant || participant.auth_user_id !== user.id
        || participant.verification_status !== "verified") {
        return json(403, { error: "VERIFIED_PARTICIPANT_REQUIRED" }, cors);
      }
    } else {
      if (!intent.organization_id) return json(409, { error: "PAYMENT_INTENT_REQUIRES_ORGANIZATION" }, cors);
      await assertOrganizationFinanceManager(caller, intent.organization_id, user.id);
    }

    let returnPath = "/dashboard";
    if (intent.purpose === "public_vote_credits" && intent.election_id) {
      const { data: election, error: electionError } = await admin
        .from("elections")
        .select("public_slug")
        .eq("id", intent.election_id)
        .maybeSingle();
      if (electionError || !election?.public_slug
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(election.public_slug)) {
        return json(409, { error: "PUBLIC_ELECTION_RETURN_PATH_UNAVAILABLE" }, cors);
      }
      returnPath = `/public-vote/${election.public_slug}`;
    }

    const result = await paystackRequest<PaystackVerifyResponse>(`/transaction/verify/${encodeURIComponent(body.reference)}`);
    const payment = result.data;
    const providerAmountMinor = Number(payment.amount);
    if (!Number.isSafeInteger(providerAmountMinor) || providerAmountMinor <= 0) {
      return json(409, { error: "PAYMENT_AMOUNT_INVALID" }, cors);
    }
    const amountMatches = providerAmountMinor === Number(intent.amount_minor);
    const currencyMatches = payment.currency === intent.currency;
    const referenceMatches = payment.reference === intent.provider_reference;
    const isSuccess = payment.status === "success" && amountMatches && currencyMatches && referenceMatches;

    // Terminal states are immutable through this user-facing verification path.
    // A repeat of the same successful provider transaction is safe and idempotent.
    if (intent.status === "success") {
      const sameSuccessfulTransaction = isSuccess
        && String(payment.id) === String(intent.provider_transaction_id);
      if (sameSuccessfulTransaction) {
        const { data: refreshed, error: refreshError } = await admin
          .from("payment_intents")
          .update({
            provider_status: payment.status,
            provider_amount_minor: providerAmountMinor,
            provider_currency: payment.currency,
            verified_at: new Date().toISOString(),
          })
          .eq("id", intent.id)
          .eq("status", "success")
          .eq("provider_transaction_id", String(payment.id))
          .select("id")
          .maybeSingle();
        if (refreshError) return json(500, { error: "PAYMENT_VERIFICATION_PERSIST_FAILED" }, cors);
        if (!refreshed) return json(409, { error: "PAYMENT_STATE_TERMINAL" }, cors);
        return json(200, { status: "success", reference: payment.reference, verified: true, duplicate: true, returnPath }, cors);
      }
      return json(409, { error: "PAYMENT_STATE_TERMINAL", status: intent.status }, cors);
    }
    if (!["initialized", "pending"].includes(intent.status)) {
      return json(409, { error: "PAYMENT_STATE_TERMINAL", status: intent.status }, cors);
    }

    const nextStatus = payment.status === "success" && !isSuccess ? "exception"
      : payment.status === "success" ? "success"
      : payment.status === "failed" ? "failed"
      : payment.status === "abandoned" ? "abandoned"
      : payment.status === "reversed" || payment.status === "reversal pending" ? "exception"
      : "pending";

    // Compare-and-set prevents a late manual verification response from
    // overwriting a webhook's success/refund/reversal or another concurrent update.
    const { data: updated, error: updateError } = await admin
      .from("payment_intents")
      .update({
        status: nextStatus,
        provider_transaction_id: String(payment.id),
        provider_status: payment.status,
        provider_amount_minor: providerAmountMinor,
        provider_currency: payment.currency,
        verified_at: new Date().toISOString(),
      })
      .eq("id", intent.id)
      .in("status", ["initialized", "pending"])
      .select("id")
      .maybeSingle();
    if (updateError) return json(500, { error: "PAYMENT_VERIFICATION_PERSIST_FAILED" }, cors);
    if (!updated) {
      const { data: current, error: currentError } = await admin
        .from("payment_intents")
        .select("status,provider_transaction_id")
        .eq("id", intent.id)
        .maybeSingle();
      if (currentError || !current) return json(500, { error: "PAYMENT_STATE_RECHECK_FAILED" }, cors);
      if (current.status === "success" && isSuccess
        && String(current.provider_transaction_id) === String(payment.id)) {
        return json(200, { status: "success", reference: payment.reference, verified: true, duplicate: true, returnPath }, cors);
      }
      return json(409, { error: "PAYMENT_STATE_CHANGED", status: current.status }, cors);
    }

    if (payment.status === "success" && !isSuccess) {
      return json(409, { error: "PAYMENT_MISMATCH", status: nextStatus }, cors);
    }
    return json(200, { status: nextStatus, reference: payment.reference, verified: isSuccess, returnPath }, cors);
  } catch (error) {
    const code = error instanceof Error ? error.message : "PAYMENT_VERIFICATION_FAILED";
    const status = code === "AUTHENTICATION_REQUIRED" || code === "INVALID_SESSION" ? 401
      : code === "FORBIDDEN" ? 403
      : code === "PAYSTACK_MODE_CONFIG_INVALID" || code === "SUPABASE_FUNCTION_CONFIG_MISSING" ? 503
      : 500;
    return json(status, { error: code }, cors);
  }
});
