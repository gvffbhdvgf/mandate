"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "../../lib/supabase/server";

const uuidSchema = z.string().uuid();

async function invokeDisbursement(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  body: Record<string, unknown>,
): Promise<{ data: Record<string, unknown> | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke("paystack-disbursements", { body });
  if (!error) return { data: data as Record<string, unknown> | null, error: null };
  let responseData: Record<string, unknown> | null = null;
  if ("context" in error && error.context instanceof Response) {
    try { responseData = await error.context.clone().json(); } catch { responseData = null; }
  }
  const code = typeof responseData?.error === "string" ? responseData.error
    : typeof responseData?.providerCode === "string" ? responseData.providerCode
    : "DISBURSEMENT_ACTION_FAILED";
  return { data: responseData, error: code };
}

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");
  return { supabase, user };
}

function financePath(organizationId: string, status: "success" | "error", code: string) {
  return `/organizations/${organizationId}/finance?${status}=${encodeURIComponent(code)}`;
}

export async function createPayoutRecipientAction(formData: FormData) {
  const parsed = z.object({
    organizationId: uuidSchema,
    type: z.enum(["mobile_money", "mobile_money_business", "kepss"]),
    name: z.string().trim().min(2).max(160),
    accountNumber: z.string().trim().min(6).max(40),
    bankCode: z.string().trim().min(2).max(32),
    destinationConfirmed: z.literal("true"),
  }).safeParse({
    organizationId: formData.get("organizationId"),
    type: formData.get("type"),
    name: formData.get("name"),
    accountNumber: formData.get("accountNumber"),
    bankCode: formData.get("bankCode"),
    destinationConfirmed: formData.get("destinationConfirmed"),
  });
  if (!parsed.success) {
    const organizationId = String(formData.get("organizationId") ?? "");
    if (uuidSchema.safeParse(organizationId).success) redirect(financePath(organizationId, "error", "RECIPIENT_DETAILS_INVALID"));
    redirect("/dashboard");
  }

  const { supabase } = await requireUser();
  const result = await invokeDisbursement(supabase, {
    action: "create_recipient",
    organizationId: parsed.data.organizationId,
    type: parsed.data.type,
    name: parsed.data.name,
    accountNumber: parsed.data.accountNumber,
    bankCode: parsed.data.bankCode,
    destinationConfirmed: true,
  });
  revalidatePath(`/organizations/${parsed.data.organizationId}/finance`);
  if (result.error) redirect(financePath(parsed.data.organizationId, "error", result.error));
  redirect(financePath(parsed.data.organizationId, "success", "RECIPIENT_CREATED"));
}

export async function requestOrganizationPayoutAction(formData: FormData) {
  const parsed = z.object({
    organizationId: uuidSchema,
    recipientId: uuidSchema,
    amountKes: z.coerce.number().positive().max(1_000_000_000),
  }).safeParse({
    organizationId: formData.get("organizationId"),
    recipientId: formData.get("recipientId"),
    amountKes: formData.get("amountKes"),
  });
  if (!parsed.success) {
    const organizationId = String(formData.get("organizationId") ?? "");
    if (uuidSchema.safeParse(organizationId).success) redirect(financePath(organizationId, "error", "PAYOUT_REQUEST_INVALID"));
    redirect("/dashboard");
  }
  const amountMinor = Math.round(parsed.data.amountKes * 100);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    redirect(financePath(parsed.data.organizationId, "error", "PAYOUT_REQUEST_INVALID"));
  }

  const { supabase } = await requireUser();
  const result = await invokeDisbursement(supabase, {
    action: "request_payout",
    organizationId: parsed.data.organizationId,
    recipientId: parsed.data.recipientId,
    amountMinor,
  });
  revalidatePath(`/organizations/${parsed.data.organizationId}/finance`);
  if (result.error) redirect(financePath(parsed.data.organizationId, "error", result.error));
  redirect(financePath(parsed.data.organizationId, "success", "PAYOUT_REQUESTED"));
}

async function runPayoutAction(formData: FormData, action: "approve_payout" | "initiate_payout" | "verify_payout" | "finalize_otp" | "resend_otp") {
  const parsed = z.object({
    organizationId: uuidSchema,
    payoutRequestId: uuidSchema,
    otp: z.string().regex(/^\d{4,8}$/).optional(),
  }).safeParse({
    organizationId: formData.get("organizationId"),
    payoutRequestId: formData.get("payoutRequestId"),
    otp: formData.get("otp") || undefined,
  });
  if (!parsed.success) {
    const organizationId = String(formData.get("organizationId") ?? "");
    if (uuidSchema.safeParse(organizationId).success) redirect(financePath(organizationId, "error", "PAYOUT_ACTION_INVALID"));
    redirect("/dashboard");
  }
  if (action === "finalize_otp" && !parsed.data.otp) {
    redirect(financePath(parsed.data.organizationId, "error", "TRANSFER_OTP_INVALID"));
  }
  const { supabase } = await requireUser();
  const result = await invokeDisbursement(supabase, {
    action,
    organizationId: parsed.data.organizationId,
    payoutRequestId: parsed.data.payoutRequestId,
    ...(action === "finalize_otp" ? { otp: parsed.data.otp } : {}),
  });
  revalidatePath(`/organizations/${parsed.data.organizationId}/finance`);
  if (result.error) redirect(financePath(parsed.data.organizationId, "error", result.error));
  const notice = action === "approve_payout" ? "PAYOUT_APPROVED"
    : action === "initiate_payout" ? "TRANSFER_SUBMITTED"
    : action === "finalize_otp" ? "TRANSFER_OTP_SUBMITTED"
    : action === "resend_otp" ? "TRANSFER_OTP_RESENT"
    : "TRANSFER_STATUS_CHECKED";
  redirect(financePath(parsed.data.organizationId, "success", notice));
}

export async function approveOrganizationPayoutAction(formData: FormData) {
  return runPayoutAction(formData, "approve_payout");
}
export async function initiateOrganizationPayoutAction(formData: FormData) {
  return runPayoutAction(formData, "initiate_payout");
}
export async function verifyOrganizationPayoutAction(formData: FormData) {
  return runPayoutAction(formData, "verify_payout");
}
export async function finalizeOrganizationPayoutOtpAction(formData: FormData) {
  return runPayoutAction(formData, "finalize_otp");
}
export async function resendOrganizationPayoutOtpAction(formData: FormData) {
  return runPayoutAction(formData, "resend_otp");
}
