"use server";

import { createSupabaseServerClient } from "../../lib/supabase/server";

export type BallotActionState = { error?: string; receiptCode?: string };

export async function loadRegisteredBallotAction(token: string) {
  if (!token || token.length < 32 || token.length > 128) {
    return { error: "This ballot link is invalid. Open the invitation link again." };
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_registered_ballot_context", {
    p_access_token: token,
  });
  if (error || !data) {
    if (error?.message.includes("ELECTION_NOT_OPEN")) return { error: "Voting is not open or the election has ended." };
    return { error: "This ballot link is invalid, has already been revoked, or is not available." };
  }
  return { context: data };
}

export async function castRegisteredBallotAction(
  _previousState: BallotActionState,
  formData: FormData,
): Promise<BallotActionState> {
  const token = String(formData.get("token") ?? "");
  const contestId = String(formData.get("contestId") ?? "");
  const optionId = String(formData.get("optionId") ?? "");
  const confirmation = formData.get("confirmation") === "true";

  if (token.length < 32 || token.length > 128 || !/^[0-9a-f-]{36}$/i.test(contestId)
    || !/^[0-9a-f-]{36}$/i.test(optionId) || !confirmation) {
    return { error: "Select an option and confirm your choice." };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("cast_registered_ballot", {
    p_access_token: token,
    p_contest_id: contestId,
    p_option_id: optionId,
    p_confirmation: true,
  });

  if (error || !data) {
    if (error?.message.includes("BALLOT_ALREADY_CAST")) return { error: "A ballot has already been recorded for this contest." };
    if (error?.message.includes("ELECTION_NOT_OPEN")) return { error: "Voting is not open or the election has ended." };
    if (error?.message.includes("VOTER_NOT_ELIGIBLE")) return { error: "This access link is no longer eligible to vote." };
    return { error: "Your ballot could not be recorded. Please try again." };
  }

  return { receiptCode: data.receiptCode };
}
