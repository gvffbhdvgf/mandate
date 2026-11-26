"use client";

import { useActionState } from "react";
import { commitVoterImportAction, type VoterImportActionState } from "../../../../../actions/voters";

const initialState: VoterImportActionState = {};

export function CommitImportForm({ organizationId, electionId, batchId }: { organizationId: string; electionId: string; batchId: string }) {
  const [state, action, pending] = useActionState(commitVoterImportAction, initialState);

  return (
    <form action={action} className="form-stack commit-import-form">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="electionId" value={electionId} />
      <input type="hidden" name="batchId" value={batchId} />
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <p className="form-hint">Review the count above. Committing adds these voters to the election register.</p>
      <button className="primary-button" disabled={pending}>{pending ? "Committing…" : "Commit voter register"}</button>
    </form>
  );
}
