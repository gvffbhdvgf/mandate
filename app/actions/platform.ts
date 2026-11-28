"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "../../lib/supabase/server";

const requirementSchema = z.object({
  requirementKey: z.string().min(3).max(80),
  status: z.enum(["pending", "approved", "rejected"]),
  evidence: z.string().max(4000),
  evidenceReference: z.string().max(1000),
  validUntil: z.string().optional(),
});

export async function bootstrapPlatformOperatorAction() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");
  const { error } = await supabase.rpc("bootstrap_platform_operator");
  if (error) redirect("/platform/paid-voting?error=bootstrap");
  redirect("/platform/paid-voting?bootstrapped=1");
}

export async function recordPlatformPaidVotingRequirementAction(formData: FormData) {
  const parsed = requirementSchema.safeParse({
    requirementKey: String(formData.get("requirementKey") ?? ""),
    status: String(formData.get("status") ?? ""),
    evidence: String(formData.get("evidence") ?? ""),
    evidenceReference: String(formData.get("evidenceReference") ?? ""),
    validUntil: String(formData.get("validUntil") ?? ""),
  });
  if (!parsed.success) redirect("/platform/paid-voting?error=invalid");
  if (parsed.data.validUntil && !Number.isFinite(Date.parse(parsed.data.validUntil))) {
    redirect("/platform/paid-voting?error=invalid-date");
  }
  const validUntil = parsed.data.validUntil
    ? new Date(parsed.data.validUntil).toISOString()
    : null;
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");
  const { error } = await supabase.rpc("record_platform_paid_voting_requirement", {
    p_requirement_key: parsed.data.requirementKey,
    p_status: parsed.data.status,
    p_evidence: parsed.data.evidence,
    p_evidence_reference: parsed.data.evidenceReference,
    p_valid_until: validUntil,
  });
  if (error) {
    const code = error.message.includes("APPROVAL_EVIDENCE_REQUIRED") ? "evidence"
      : error.message.includes("PLATFORM_OPERATOR_REQUIRED") ? "forbidden" : "save";
    redirect(`/platform/paid-voting?error=${code}`);
  }
  redirect("/platform/paid-voting?updated=1");
}

export async function authorizePublicPaidElectionAction(formData: FormData) {
  const electionId = z.string().uuid().safeParse(String(formData.get("electionId") ?? ""));
  if (!electionId.success || formData.get("scopeAcknowledged") !== "true") {
    redirect("/platform/paid-voting?error=scope");
  }
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");
  const { error } = await supabase.rpc("authorize_public_paid_election", {
    p_election_id: electionId.data,
    p_scope_acknowledged: true,
  });
  if (error) {
    const code = error.message.includes("PAID_VOTING_RELEASE_REQUIREMENTS_PENDING") ? "requirements"
      : error.message.includes("JURISDICTION_NOT_RELEASED") ? "jurisdiction"
      : error.message.includes("PUBLIC_PAID_ELECTION_CONFIGURATION_INVALID") ? "configuration"
      : error.message.includes("PLATFORM_OPERATOR_REQUIRED") ? "forbidden" : "authorize";
    redirect(`/platform/paid-voting?error=${code}`);
  }
  redirect("/platform/paid-voting?authorized=1");
}
