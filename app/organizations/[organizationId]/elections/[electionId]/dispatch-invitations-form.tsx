"use client";

import { useActionState } from "react";
import { dispatchVoterInvitationsAction, type InvitationActionState } from "../../../../actions/invitations";

const initialState: InvitationActionState = {};

export function DispatchInvitationsForm({ organizationId, electionId }: { organizationId: string; electionId: string }) {
  const [state, action, pending] = useActionState(dispatchVoterInvitationsAction, initialState);

  return (
    <form action={action} className="form-stack invitation-form">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="electionId" value={electionId} />
      <label className="ballot-confirmation"><input type="checkbox" name="confirmInvitations" value="true" required /> I have checked the voter contact details and confirm that invitations should be sent.</label>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      {state.message && <p className="form-success" role="status">{state.message}</p>}
      {state.hasMore && <p className="form-hint">There are more email invitations waiting. Run the next batch when ready.</p>}
      <button className="primary-button" disabled={pending}>{pending ? "Sending invitations…" : state.hasMore ? "Send next 50 invitations" : "Send voter invitations"}</button>
    </form>
  );
}
