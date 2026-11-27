"use client";

import { useActionState } from "react";
import { commitVoterImportAction, type VoterImportActionState } from "../../../../actions/voters";

const initialState: VoterImportActionState = {};

export function CommitImportForm({ organizationId, electionId, batchId }: { organizationId: string; electionId: string; batchId: string }) {
  const [state, action, pending] = useActionState(commitVoterImportAction, initialState);

  return (
    <form action={action} className="form-stack commit-import-form">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="electionId" value={electionId} />
      <input type="hidden" name="batchId" value={batchId} />
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <p className="form-hint">Review the accepted and rejected row counts above. This step adds the accepted voters to the election register.</p>
      <label className="ballot-confirmation"><input type="checkbox" name="confirmImport" value="true" required /> I have reviewed this import and want to add these voters.</label>
      <p className="form-hint" role="status" aria-live="polite">{pending ? "Adding the validated voters to the register…" : "The voter register is updated only after the server confirms this step."}</p>
      <button className="primary-button" disabled={pending}>{pending ? "Adding voters…" : "Confirm and add voters"}</button>
    </form>
  );
}
