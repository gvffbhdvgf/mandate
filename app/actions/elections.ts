"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export type ElectionActionState = { error?: string };

const electionSchema = z.object({
  organizationId: z.string().uuid(),
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(5000).optional(),
  votingMode: z.enum(["registered_single", "registered_weighted"]),
  startsAt: z.string().min(16),
  endsAt: z.string().min(16),
  contestTitle: z.string().trim().min(2).max(160),
  optionA: z.string().trim().min(1).max(160),
  optionB: z.string().trim().min(1).max(160),
});

function nairobiDate(value: string): Date {
  return new Date(`${value}:00+03:00`);
}

export async function createElectionSetupAction(
  _previousState: ElectionActionState,
  formData: FormData,
): Promise<ElectionActionState> {
  const parsed = electionSchema.safeParse({
    organizationId: formData.get("organizationId"),
    title: formData.get("title"),
    description: formData.get("description") ?? "",
    votingMode: formData.get("votingMode"),
    startsAt: formData.get("startsAt"),
    endsAt: formData.get("endsAt"),
    contestTitle: formData.get("contestTitle"),
    optionA: formData.get("optionA"),
    optionB: formData.get("optionB"),
  });
  if (!parsed.success) return { error: "Review the election details and complete all required fields." };
  const startsAt = nairobiDate(parsed.data.startsAt);
  const endsAt = nairobiDate(parsed.data.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    return { error: "Enter valid election start and end dates." };
  }
  if (startsAt <= new Date() || endsAt <= startsAt) {
    return { error: "The start must be in the future and the end must be after the start." };
  }
  if (parsed.data.optionA.toLowerCase() === parsed.data.optionB.toLowerCase()) {
    return { error: "Add two different candidates or options." };
  }
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");
  const { data: electionId, error } = await supabase.rpc("create_election_setup", {
    p_organization_id: parsed.data.organizationId,
    p_election: {
      title: parsed.data.title, description: parsed.data.description || null,
      voting_mode: parsed.data.votingMode, starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(), timezone: "Africa/Nairobi", result_visibility: "private",
    },
    p_contests: [{
      title: parsed.data.contestTitle, is_required: true, tie_policy: "declared_tie",
      options: [{ display_name: parsed.data.optionA }, { display_name: parsed.data.optionB }],
    }],
  });
  if (error || !electionId) return { error: "We could not create the election. Check the details and try again." };
  redirect(`/organizations/${parsed.data.organizationId}/elections/${electionId}`);
}

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
    return { electionId: electionId as string, error: "The draft was finalized, but authority confirmation did not complete. Open the election and retry confirmation." };
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
  if (error) return { error: "The election setup could not be confirmed. Check the rules and your organization role." };
  return {};
}
