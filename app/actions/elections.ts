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
      title: parsed.data.title,
      description: parsed.data.description || null,
      voting_mode: parsed.data.votingMode,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      timezone: "Africa/Nairobi",
      result_visibility: "private",
    },
    p_contests: [{
      title: parsed.data.contestTitle,
      is_required: true,
      tie_policy: "declared_tie",
      options: [
        { display_name: parsed.data.optionA },
        { display_name: parsed.data.optionB },
      ],
    }],
  });

  if (error || !electionId) {
    if (error?.message.includes("FORBIDDEN")) return { error: "You do not have permission to create elections in this organization." };
    if (error?.message.includes("PAID_VOTING_FEATURE_GATED")) return { error: "Paid public voting is not enabled." };
    return { error: "We could not create the election. Check the details and try again." };
  }

  redirect(`/organizations/${parsed.data.organizationId}/elections/${electionId}`);
}
