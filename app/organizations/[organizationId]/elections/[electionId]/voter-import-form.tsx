"use client";

import { useActionState } from "react";
import { stageVoterImportAction, type VoterImportActionState } from "../../../../actions/voters";

const initialState: VoterImportActionState = {};

export function VoterImportForm({ organizationId, electionId }: { organizationId: string; electionId: string }) {
  const [state, action, pending] = useActionState(stageVoterImportAction, initialState);

  return (
    <form action={action} className="form-stack import-form">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="electionId" value={electionId} />
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <label>Voter register CSV<input name="file" type="file" accept=".csv,text/csv" required /></label>
      <p className="form-hint">Private upload · up to 10 MB and 25,000 voters. Each voter needs a unique reference, name, and at least one contact address.</p>
      <button className="primary-button" disabled={pending}>{pending ? "Validating register…" : "Upload and validate CSV"}</button>
    </form>
  );
}
