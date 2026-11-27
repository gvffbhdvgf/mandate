"use client";

import { useActionState } from "react";
import { stageManualVoterAction, type VoterImportActionState } from "../../../../actions/voters";

const initialState: VoterImportActionState = {};

export function ManualVoterForm({ organizationId, electionId, votingMode }: {
  organizationId: string;
  electionId: string;
  votingMode: string;
}) {
  const [state, action, pending] = useActionState(stageManualVoterAction, initialState);

  return (
    <form action={action} className="form-stack">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="electionId" value={electionId} />
      <div className="form-section-title">Add one voter manually</div>
      <label>Voter reference<input name="voterRef" maxLength={200} required /></label>
      <label>Full name<input name="name" maxLength={200} autoComplete="name" required /></label>
      <label>Email address (optional)<input name="email" type="email" maxLength={254} autoComplete="email" /></label>
      <label>Phone number (optional)<input name="phone" type="tel" placeholder="+254712345678" maxLength={16} autoComplete="tel" /></label>
      {votingMode === "registered_weighted" ? (
        <label>Voting weight<input name="weight" type="number" min={1} max={1000000} step={1} defaultValue={1} required /></label>
      ) : (
        <input type="hidden" name="weight" value="1" />
      )}
      <p className="form-hint">Provide at least one contact address. The voter will be validated and reviewed before being added, using the same secure register process as CSV imports.</p>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <button className="secondary-button" disabled={pending}>{pending ? "Validating voter…" : "Validate manual entry"}</button>
    </form>
  );
}
