"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export type PlatformFeeCheckoutState = {
  error?: string;
  message?: string;
  authorizationUrl?: string;
};

export async function startPlatformFeeCheckoutAction(
  _previousState: PlatformFeeCheckoutState,
  formData: FormData,
): Promise<PlatformFeeCheckoutState> {
  const parsed = z.object({
    organizationId: z.string().uuid(),
    electionId: z.string().uuid(),
    eligibleVoterCount: z.coerce.number().int().min(1).max(25000),
    amountMinor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    policyVersion: z.coerce.number().int().positive(),
  }).safeParse({
    organizationId: formData.get("organizationId"),
    electionId: formData.get("electionId"),
    eligibleVoterCount: formData.get("eligibleVoterCount"),
    amountMinor: formData.get("amountMinor"),
    policyVersion: formData.get("policyVersion"),
  });
  if (!parsed.success) return { error: "The platform-fee quote is invalid. Refresh the election and try again." };

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  const { data: membership, error: membershipError } = await supabase
    .from("organization_members")
    .select("role,status")
    .eq("organization_id", parsed.data.organizationId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError || !membership || membership.status !== "active"
    || !["owner", "admin", "finance_manager"].includes(membership.role)) {
    return { error: "An active organization owner, administrator or finance manager must pay this fee." };
  }

  const { data: intent, error: intentError } = await supabase.rpc("create_platform_fee_payment_intent", {
    p_election_id: parsed.data.electionId,
    p_expected_voter_count: parsed.data.eligibleVoterCount,
    p_expected_amount_minor: parsed.data.amountMinor,
    p_expected_policy_version: parsed.data.policyVersion,
  });
  if (intentError || !intent || typeof intent !== "object") {
    const message = intentError?.message ?? "";
    if (message.includes("PLATFORM_FEE_QUOTE_CHANGED")) {
      return { error: "The eligible voter register or pricing policy changed. Refresh to review the updated fee before paying." };
    }
    if (message.includes("FORBIDDEN")) return { error: "You do not have financial authority for this organization." };
    if (message.includes("ELIGIBLE_VOTERS_REQUIRED")) return { error: "Commit the eligible voter register before generating the platform-fee invoice." };
    return { error: "Mandate could not create the platform-fee invoice. No payment was started." };
  }

  const invoice = intent as Record<string, unknown>;
  if (invoice.status === "paid") return { message: "This election's platform service fee has already been verified as paid." };
  if (invoice.status === "exception") {
    return { error: "This payment is under reconciliation. Do not pay again until the exception is reviewed." };
  }

  const { data: checkout, error: checkoutError } = await supabase.functions.invoke("paystack-initialize", {
    body: { paymentIntentId: invoice.paymentIntentId },
  });
  let responseData: Record<string, unknown> | null = checkout;
  if (checkoutError && "context" in checkoutError && checkoutError.context instanceof Response) {
    try { responseData = await checkoutError.context.clone().json(); } catch { responseData = null; }
  }
  if (checkoutError || !responseData?.authorizationUrl || typeof responseData.authorizationUrl !== "string") {
    if (responseData?.error === "PAYMENT_PURPOSE_DISABLED" || responseData?.error === "PAYMENTS_DISABLED") {
      return { error: "Platform-fee checkout is not enabled in the current Paystack environment. The invoice is saved; no charge was made." };
    }
    if (responseData?.error === "PAYMENT_INITIALIZATION_OUTCOME_UNKNOWN") {
      return { error: "Paystack's initialization outcome is uncertain. Do not retry or pay again; reconcile this reference first." };
    }
    return { error: "Paystack checkout could not be started. The invoice is retained; check its status before retrying." };
  }

  let authorizationUrl: URL;
  try { authorizationUrl = new URL(responseData.authorizationUrl); } catch {
    return { error: "Paystack returned an invalid checkout address. No redirect was made." };
  }
  if (authorizationUrl.protocol !== "https:" || !authorizationUrl.hostname.endsWith(".paystack.com")) {
    return { error: "Paystack returned an untrusted checkout address. No redirect was made." };
  }
  return { authorizationUrl: authorizationUrl.toString() };
}
