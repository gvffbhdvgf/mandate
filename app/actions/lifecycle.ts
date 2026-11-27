"use server";

import { z } from "zod";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export type LifecycleActionState = {
  error?: string;
  message?: string;
  success?: boolean;
  tallyId?: string;
  requiresResolution?: boolean;
  counts?: {
    eligibleVoters: number;
    participatingVoters: number;
    acceptedBallots: number;
    invalidatedBallots: number;
  };
};

const uuid = z.string().uuid();

async function authorizedElection(formData: FormData) {
  const electionId = String(formData.get("electionId") ?? "");
  if (!uuid.safeParse(electionId).success) return { error: "Invalid election reference." as const };
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { error: "Your session has expired. Sign in again." as const };
  return { supabase, electionId };
}

export async function openElectionAction(_previous: LifecycleActionState, formData: FormData): Promise<LifecycleActionState> {
  if (formData.get("confirmRules") !== "true") return { error: "Confirm that you reviewed the election rules and voter register." };
  const auth = await authorizedElection(formData);
  if ("error" in auth) return { error: auth.error };
  const { error } = await auth.supabase.rpc("open_election", {
    p_election_id: auth.electionId,
    p_confirm_rules_snapshot: true,
  });
  if (error) {
    if (error.message.includes("VOTER_ACCESS_NOT_ISSUED")) return { error: "Every eligible voter must receive a secure invitation before this election can open." };
    if (error.message.includes("ELIGIBLE_VOTERS_REQUIRED")) return { error: "Import and commit the eligible voter register before opening." };
    if (error.message.includes("ELECTION_NOT_STARTED")) return { error: "The scheduled start time has not arrived. Refresh the page after the scheduled start time." };
    if (error.message.includes("ELECTION_WINDOW_EXPIRED")) return { error: "The scheduled end time has passed. Update the draft schedule before opening." };
    if (error.message.includes("ELECTION_SETUP_CHANGED_RECONFIRM") || error.message.includes("ELECTION_SETUP_NOT_CONFIRMED")) {
      return { error: "The election settings changed after review. Review the current setup and record approval again before opening." };
    }
    return { error: "The election could not be opened. Check the rules, options and voter access checklist." };
  }
  return { success: true, message: "Election opened. The frozen ballot snapshot is now active." };
}

export async function pauseElectionAction(_previous: LifecycleActionState, formData: FormData): Promise<LifecycleActionState> {
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length < 10 || reason.length > 1000) return { error: "Enter a pause reason between 10 and 1,000 characters." };
  const auth = await authorizedElection(formData);
  if ("error" in auth) return { error: auth.error };
  const { error } = await auth.supabase.rpc("pause_election", { p_election_id: auth.electionId, p_reason: reason });
  if (error) return { error: "The election could not be paused. It may no longer be open." };
  return { success: true, message: "Election paused. Ballot submissions are temporarily disabled." };
}

export async function resumeElectionAction(_previous: LifecycleActionState, formData: FormData): Promise<LifecycleActionState> {
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length < 10 || reason.length > 1000) return { error: "Enter a resumption reason between 10 and 1,000 characters." };
  const auth = await authorizedElection(formData);
  if ("error" in auth) return { error: auth.error };
  const { error } = await auth.supabase.rpc("resume_election", { p_election_id: auth.electionId, p_reason: reason });
  if (error) return { error: "The election could not be resumed. It may have reached its scheduled end." };
  return { success: true, message: "Election resumed. Ballot submissions are active again." };
}

export async function closeElectionAction(_previous: LifecycleActionState, formData: FormData): Promise<LifecycleActionState> {
  if (formData.get("confirmClose") !== "true") return { error: "Confirm that you want to close voting for this election." };
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length < 10 || reason.length > 1000) return { error: "Enter a closure reason between 10 and 1,000 characters." };
  const auth = await authorizedElection(formData);
  if ("error" in auth) return { error: auth.error };
  const { error } = await auth.supabase.rpc("close_election", {
    p_election_id: auth.electionId,
    p_reason: reason,
  });
  if (error) return { error: "The election could not be closed. It may already be closed or cancelled." };
  return { success: true, message: "Election closed. You can now run tally reconciliation." };
}

export async function tallyElectionAction(_previous: LifecycleActionState, formData: FormData): Promise<LifecycleActionState> {
  const auth = await authorizedElection(formData);
  if ("error" in auth) return { error: auth.error };
  const { data, error } = await auth.supabase.rpc("tally_and_reconcile", { p_election_id: auth.electionId });
  if (error || !data) return { error: "Tally reconciliation failed. Ballot controls and ballot records must reconcile before results can be prepared." };
  return {
    success: true,
    message: data.requiresResolution
      ? "Tally reconciled. A tie requires the configured runoff or external resolution before publication."
      : "Tally reconciled successfully. Results are ready for authorized publication.",
    tallyId: data.tallyId,
    requiresResolution: Boolean(data.requiresResolution),
    counts: {
      eligibleVoters: Number(data.eligibleVoters ?? 0),
      participatingVoters: Number(data.participatingVoters ?? 0),
      acceptedBallots: Number(data.acceptedBallots ?? 0),
      invalidatedBallots: Number(data.invalidatedBallots ?? 0),
    },
  };
}

export async function publishResultsAction(_previous: LifecycleActionState, formData: FormData): Promise<LifecycleActionState> {
  if (formData.get("confirmPublish") !== "true") return { error: "Confirm that the reconciled results are ready to publish." };
  const auth = await authorizedElection(formData);
  if ("error" in auth) return { error: auth.error };
  const { error } = await auth.supabase.rpc("publish_results", { p_election_id: auth.electionId });
  if (error) {
    if (error.message.includes("RESULT_RESOLUTION_REQUIRED")) return { error: "Resolve the tie using the election's approved runoff or external resolution process before publishing." };
    return { error: "Results could not be published. Verify the tally and publication permissions." };
  }
  return { success: true, message: "Results published. The public results endpoint now follows the election's visibility setting." };
}
