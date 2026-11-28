const statusLabels: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  open: "Open for voting",
  paused: "Voting paused",
  closed: "Closed",
  tallying: "Reconciliation in progress",
  results_published: "Published results",
};

const votingModeLabels: Record<string, string> = {
  registered_single: "One person, one vote",
  registered_weighted: "Weighted voting",
  public_paid: "Public paid voting",
};

const resultVisibilityLabels: Record<string, string> = {
  private: "Election administrators only",
  members: "Organization members",
  public: "Public aggregate results",
};

const tiePolicyLabels: Record<string, string> = {
  declared_tie: "Declare a tie",
  runoff: "Runoff election",
  external_resolution: "External resolution",
};

const roleLabels: Record<string, string> = {
  owner: "Owner",
  admin: "Administrator",
  election_manager: "Election manager",
  returning_officer: "Returning officer",
  finance_manager: "Finance manager",
  viewer: "Viewer",
};

const auditActionLabels: Record<string, string> = {
  "election.created": "Election created",
  "election.setup_confirmed": "Election setup confirmed",
  "election.opened": "Voting opened",
  "election.paused": "Voting paused",
  "election.resumed": "Voting resumed",
  "election.closed": "Voting closed",
  "election.tallied": "Results reconciled",
  "election.results_published": "Results published",
  "election.results.exported": "Results report exported",
  "voter_import.staged": "Voter import validated",
  "voter_import.validated": "Voter import validated",
  "voter_import.committed": "Voter register updated",
  "voter_invitation.batch_dispatched": "Voter invitation batch processed",
};

function titleCase(value: string): string {
  const normalized = value.replace(/[._-]+/g, " ").trim().replace(/\s+/g, " ").toLowerCase();
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : "Unknown";
}

export function formatStatusLabel(value: string): string {
  return statusLabels[value] ?? titleCase(value || "Unknown status");
}

export function formatVotingMode(value: string): string {
  return votingModeLabels[value] ?? titleCase(value || "Unknown voting method");
}

export function formatAuditAction(value: string): string {
  return auditActionLabels[value] ?? titleCase(value || "Activity recorded");
}

export function formatResultVisibility(value: string): string {
  return resultVisibilityLabels[value] ?? titleCase(value || "Unknown visibility");
}

export function formatTiePolicy(value: string): string {
  return tiePolicyLabels[value] ?? titleCase(value || "Unknown tie policy");
}

export function formatRoleLabel(value: string): string {
  return roleLabels[value] ?? titleCase(value || "Member");
}

export function formatDateTime(value: string | number | Date | null | undefined, timezone = "Africa/Nairobi"): string {
  if (value === null || value === undefined || value === "") return "Not set";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Not set";
  try {
    return new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date);
  }
}

function safeDate(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const formatted = formatDateTime(value, "Africa/Nairobi");
  return formatted === "Not set" ? null : formatted;
}

export function formatAuditMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Array<{ label: string; value: string }> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];

  const details: Array<{ label: string; value: string }> = [];
  for (const key of ["configurationHash", "rulesHash", "snapshotHash"] as const) {
    const hash = metadata[key];
    if (typeof hash === "string" && /^[a-f0-9]{16,128}$/i.test(hash)) {
      details.push({ label: "Verification reference", value: `${hash.slice(0, 8)}…` });
      break;
    }
  }

  const votingMode = metadata.votingMode;
  if (typeof votingMode === "string" && votingModeLabels[votingMode]) {
    details.push({ label: "Voting method", value: formatVotingMode(votingMode) });
  }

  for (const [key, label] of [["startsAt", "Voting starts"], ["endsAt", "Voting ends"]] as const) {
    const formatted = safeDate(metadata[key]);
    if (formatted) details.push({ label, value: formatted });
  }

  const timezone = metadata.timezone;
  if (typeof timezone === "string" && /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(timezone)) {
    details.push({ label: "Time zone", value: timezone.replaceAll("_", " ") });
  }

  const visibility = metadata.resultVisibility;
  if (typeof visibility === "string" && resultVisibilityLabels[visibility]) {
    details.push({ label: "Results visibility", value: formatResultVisibility(visibility) });
  }

  for (const [key, label] of [
    ["totalRows", "Rows checked"], ["acceptedRows", "Accepted rows"], ["rejectedRows", "Rejected rows"],
    ["importedRows", "Voters added"], ["attempted", "Invitations attempted"], ["sent", "Invitations sent"],
    ["skippedNoEmail", "Skipped (no email)"], ["failed", "Failed invitations"],
    ["eligibleVoters", "Eligible voters"], ["participatingVoters", "Participating voters"],
    ["acceptedBallots", "Accepted ballots"], ["invalidatedBallots", "Invalidated ballots"],
  ] as const) {
    const count = metadata[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
      details.push({ label, value: count.toLocaleString("en-KE") });
    }
  }

  if (typeof metadata.requiresResolution === "boolean") {
    details.push({ label: "Tie needs resolution", value: metadata.requiresResolution ? "Yes" : "No" });
  }

  return details;
}
