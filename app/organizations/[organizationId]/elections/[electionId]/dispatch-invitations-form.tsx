"use client";

import { useActionState } from "react";
import { dispatchVoterInvitationsAction, type InvitationActionState } from "../../../../actions/invitations";
import { ActionToast } from "../../../../components/action-toast";

const initialState: InvitationActionState = {};

export function DispatchInvitationsForm({ organizationId, electionId }: { organizationId: string; electionId: string }) {
  const [state, action, pending] = useActionState(dispatchVoterInvitationsAction, initialState);

  return (
    <form action={action} className="form-stack invitation-form">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="electionId" value={electionId} />
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <ActionToast message={state.message} tone={state.tone} />
      <p className="form-hint">Email is the currently supported invitation channel. Voters without an email address will be skipped and will still block election opening until an invitation is issued.</p>
      {state.hasMore && <p className="form-hint">There are more email invitations waiting. Run the next batch when ready.</p>}
      <label className="ballot-confirmation"><input type="checkbox" name="confirmInvitations" value="true" required /> I have checked the voter register and want to send secure invitation emails.</label>
      <p className="form-hint" role="status" aria-live="polite">{pending ? "Sending secure invitations…" : "Invitation emails cannot be recalled after they are sent."}</p>
      <button className="primary-button" disabled={pending}>{pending ? "Sending invitations…" : state.hasMore ? "Confirm and send next batch" : "Confirm and send invitations"}</button>
    </form>
  );
}
