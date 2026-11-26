"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export type InvitationActionState = { error?: string; message?: string; hasMore?: boolean };

export async function dispatchVoterInvitationsAction(
  _previousState: InvitationActionState,
  formData: FormData,
): Promise<InvitationActionState> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const electionId = String(formData.get("electionId") ?? "");
  if (![organizationId, electionId].every((value) => z.string().uuid().safeParse(value).success)) {
    return { error: "The election reference is invalid. Refresh and try again." };
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  const { data: election, error: electionError } = await supabase
    .from("elections")
    .select("id,organization_id,status")
    .eq("id", electionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (electionError || !election || election.status !== "draft") {
    return { error: "Only a draft election can send voter invitations." };
  }

  const { data, error } = await supabase.functions.invoke("send-voter-invitations", {
    body: { electionId },
  });

  if (error || data?.error) {
    if (data?.error === "INVITATION_DELIVERY_NOT_CONFIGURED") {
      return { error: "Invitation delivery is not configured yet. A verified sender domain and site URL are required; no invitations or tokens were issued." };
    }
    return { error: "The invitation batch could not be sent. No ballot choices or voter tokens were exposed." };
  }

  return {
    message: `${data.sent} invitations sent. ${data.skippedNoEmail} eligible voters have no email address and need another delivery channel. ${data.failed} sends failed.`,
    hasMore: Boolean(data.hasMore),
  };
}
