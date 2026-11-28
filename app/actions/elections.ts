"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "../../lib/supabase/server";

const draftSaveSchema = z.object({
  organizationId: z.string().uuid(),
  draftId: z.string().uuid().nullable(),
  payload: z.string().max(131072),
  currentStep: z.number().int().min(1).max(6),
});

export async function saveElectionSetupDraftAction(input: {
  organizationId: string; draftId: string | null; payload: string; currentStep: number;
}): Promise<{ draftId?: string; error?: string }> {
  const parsed = draftSaveSchema.safeParse(input);
  if (!parsed.success) return { error: "The draft could not be saved. Check the information and try again." };
  let payload: unknown;
  try { payload = JSON.parse(parsed.data.payload); } catch { return { error: "The draft data is not valid. Please try again." }; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "The draft data is not valid. Please try again." };
  }
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");
  const { data, error } = await supabase.rpc("save_election_setup_draft", {
    p_draft_id: parsed.data.draftId,
    p_organization_id: parsed.data.organizationId,
    p_payload: payload,
    p_current_step: parsed.data.currentStep,
  });
  if (error || !data) return { error: "We could not save this draft. Check your organization access and try again." };
  return { draftId: data as string };
}

export async function finalizeAndConfirmElectionSetupAction(input: {
  draftId: string; authorityConfirmed: boolean;
}): Promise<{ electionId?: string; error?: string }> {
  const parsed = z.object({ draftId: z.string().uuid(), authorityConfirmed: z.literal(true) }).safeParse(input);
  if (!parsed.success) return { error: "An authorized election authority must confirm the reviewed setup." };
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");
  const { data: electionId, error: finalizeError } = await supabase.rpc("finalize_election_setup_draft", {
    p_draft_id: parsed.data.draftId,
  });
  if (finalizeError || !electionId) {
    return { error: "The election could not be finalized. Review all required details and try again." };
  }
  const { error: confirmationError } = await supabase.rpc("confirm_election_setup", {
    p_election_id: electionId,
  });
  if (confirmationError) {
    const message = confirmationError.message ?? "";
    if (message.includes("PAID_VOTING_FEATURE_GATED")) {
      return {
        electionId: electionId as string,
        error: "Your public election draft is saved, but the public vote-credit feature is currently disabled. Contact the organization administrator.",
      };
    }
    return { electionId: electionId as string, error: "The draft was finalized, but authority confirmation did not complete. Review the election setup and retry confirmation." };
  }
  return { electionId: electionId as string };
}


export async function confirmElectionSetupAction(input: {
  electionId: string; authorityConfirmed: boolean;
}): Promise<{ error?: string }> {
  const parsed = z.object({
    electionId: z.string().uuid(), authorityConfirmed: z.literal(true),
  }).safeParse(input);
  if (!parsed.success) return { error: "Confirm that you are authorized to approve this election setup." };
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");
  const { error } = await supabase.rpc("confirm_election_setup", {
    p_election_id: parsed.data.electionId,
  });
  if (error?.message.includes("PAID_VOTING_FEATURE_GATED")) {
    return { error: "Public vote credits are currently disabled for the platform. The election has not been opened." };
  }
  if (error?.message.includes("PUBLIC_PAID_ELECTION_CONFIGURATION_INVALID")) {
    return { error: "Complete the public election currency, price, participant limit, contact verification and voting dates before confirming." };
  }
  if (error?.message.includes("JURISDICTION_NOT_RELEASED")) {
    return { error: "Public paid elections are currently supported for Kenya-based private organizational elections only." };
  }
  if (error) return { error: "The election setup could not be confirmed. Check the current rules, options and your organization role." };
  return {};
}
