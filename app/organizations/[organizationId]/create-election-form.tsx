"use client";

import { useActionState } from "react";
import { createElectionSetupAction, type ElectionActionState } from "../../actions/elections";

const initialState: ElectionActionState = {};

export function CreateElectionForm({ organizationId }: { organizationId: string }) {
  const [state, action, pending] = useActionState(createElectionSetupAction, initialState);

  return (
    <form action={action} className="form-stack election-form">
      <input type="hidden" name="organizationId" value={organizationId} />
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <div className="form-section-title">Election details</div>
      <label>Election name<input name="title" placeholder="e.g. Annual leadership election" minLength={2} maxLength={160} required /></label>
      <label>Description (optional)<textarea name="description" rows={3} maxLength={5000} placeholder="What is this election for?" /></label>
      <label>Voting method
        <select name="votingMode" defaultValue="registered_single">
          <option value="registered_single">One person, one vote</option>
          <option value="registered_weighted">Weighted voting (registered voters)</option>
        </select>
      </label>
      <div className="form-two-column">
        <label>Voting starts (EAT)<input name="startsAt" type="datetime-local" required /></label>
        <label>Voting ends (EAT)<input name="endsAt" type="datetime-local" required /></label>
      </div>
      <div className="form-section-title">First contest</div>
      <label>Contest name<input name="contestTitle" placeholder="e.g. Chairperson" minLength={2} maxLength={160} required /></label>
      <div className="form-two-column">
        <label>First candidate / option<input name="optionA" placeholder="Candidate A" maxLength={160} required /></label>
        <label>Second candidate / option<input name="optionB" placeholder="Candidate B" maxLength={160} required /></label>
      </div>
      <p className="form-hint">This creates a draft election with one contest and two options. You can add more contests before opening it. The election cannot open until its eligible voter register is ready.</p>
      <button className="primary-button" disabled={pending}>{pending ? "Creating draft…" : "Create election draft"}</button>
    </form>
  );
}
