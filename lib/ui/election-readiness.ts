export type OpeningCheck = { label: string; complete: boolean; detail: string };

export function buildElectionOpeningChecks(input: {
  setupConfirmed: boolean;
  eligibleVoterCount: number;
  invitedVoterCount: number;
  activeOptionCounts: number[];
  startsAt: string | null;
  endsAt: string | null;
  timezone: string;
  now?: number;
}): OpeningCheck[] {
  const now = input.now ?? Date.now();
  const start = input.startsAt ? new Date(input.startsAt).getTime() : Number.NaN;
  const end = input.endsAt ? new Date(input.endsAt).getTime() : Number.NaN;
  const validSchedule = Number.isFinite(start) && Number.isFinite(end) && start < end;
  const startReached = Number.isFinite(start) && start <= now;
  const windowOpen = Number.isFinite(end) && end > now;
  const allInvited = input.eligibleVoterCount > 0 && input.invitedVoterCount === input.eligibleVoterCount;
  const contestsReady = input.activeOptionCounts.length > 0 && input.activeOptionCounts.every((count) => count >= 2);
  const formatDate = (timestamp: number) => {
    try {
      return new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeStyle: "short", timeZone: input.timezone }).format(timestamp);
    } catch {
      return new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(timestamp);
    }
  };

  return [
    {
      label: "Election rules approved",
      complete: input.setupConfirmed,
      detail: input.setupConfirmed
        ? "An authorized officer has recorded approval. Mandate verifies the exact configuration again when opening."
        : "Review the rules and record an authorized approval.",
    },
    {
      label: "Eligible voter register added",
      complete: input.eligibleVoterCount > 0,
      detail: input.eligibleVoterCount > 0
        ? `${input.eligibleVoterCount.toLocaleString("en-KE")} eligible voters are on the register.`
        : "Import the eligible voters before opening the election.",
    },
    {
      label: "Voter invitations issued",
      complete: allInvited,
      detail: allInvited
        ? `All ${input.eligibleVoterCount.toLocaleString("en-KE")} eligible voters have an invitation record.`
        : `${input.invitedVoterCount.toLocaleString("en-KE")} of ${input.eligibleVoterCount.toLocaleString("en-KE")} eligible voters have invitations. Email is the current delivery channel; add email addresses for phone-only voters before sending the remaining invitations.`,
    },
    {
      label: "Contests and options configured",
      complete: contestsReady,
      detail: contestsReady
        ? `${input.activeOptionCounts.length} contest${input.activeOptionCounts.length === 1 ? "" : "s"} have at least two active options each.`
        : "Add at least one contest and two active options to each contest.",
    },
    {
      label: "Voting dates scheduled",
      complete: validSchedule,
      detail: validSchedule ? "The voting window has a valid start and end time." : "Set a valid start time and an end time later than the start.",
    },
    {
      label: "Scheduled start time reached",
      complete: startReached,
      detail: startReached
        ? "The scheduled start time has arrived."
        : Number.isFinite(start) ? `Voting is scheduled to start ${formatDate(start)}. Refresh this page after that time.` : "Set a valid voting start time.",
    },
    {
      label: "Voting window has not expired",
      complete: windowOpen,
      detail: windowOpen
        ? "The scheduled end time is still in the future."
        : Number.isFinite(end) ? "The scheduled end time has passed. Update the draft schedule before opening." : "Set a valid voting end time.",
    },
  ];
}
