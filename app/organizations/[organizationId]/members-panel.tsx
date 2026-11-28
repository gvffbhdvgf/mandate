"use client";

import { useActionState, useState } from "react";
import type { ReactNode } from "react";
import {
  changeOrganizationMemberRoleAction,
  createOrganizationInvitationAction,
  revokeOrganizationInvitationAction,
  revokeOrganizationMemberAction,
  type MemberActionState,
} from "../../actions/organization-members";

type Member = {
  member_id: string;
  user_id: string;
  display_name: string | null;
  email: string | null;
  role: string;
  status: string;
  created_at: string;
  accepted_at: string | null;
};
type Invitation = { id: string; email: string; role: string; expires_at: string; created_at: string };

type MemberFormAction = (formData: FormData) => void | Promise<void>;

function PendingMemberForm({
  action,
  className,
  buttonClassName,
  buttonLabel,
  pendingLabel,
  children,
}: {
  action: MemberFormAction;
  className?: string;
  buttonClassName: string;
  buttonLabel: string;
  pendingLabel: string;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  return (
    <form action={action} className={className} onSubmit={() => setPending(true)}>
      {children}
      <button type="submit" className={buttonClassName} disabled={pending}>
        {pending ? pendingLabel : buttonLabel}
      </button>
    </form>
  );
}

const roles = [
  ["admin", "Admin"],
  ["election_manager", "Election manager"],
  ["returning_officer", "Returning officer"],
  ["finance_manager", "Finance manager"],
  ["viewer", "Viewer"],
] as const;

export function OrganizationMembersPanel({
  organizationId,
  members,
  invitations,
  actorRole,
  memberNotice,
  memberError,
}: {
  organizationId: string;
  members: Member[];
  invitations: Invitation[];
  actorRole: string;
  memberNotice?: string;
  memberError?: string;
}) {
  const [state, action, pending] = useActionState(createOrganizationInvitationAction, {} as MemberActionState);
  const notices: Record<string, string> = {
    "role-updated": "Member role updated. Their new permissions are now active.",
    "member-revoked": "Member access revoked. They can no longer access this organization.",
    "invitation-revoked": "Invitation revoked. The pending invitation link can no longer be used.",
  };
  const errors: Record<string, string> = {
    "confirm-member": "Confirm that you want to revoke this member’s access.",
    "confirm-invitation": "Confirm that you want to revoke this invitation.",
    "role-update-failed": "The member role could not be updated. Refresh and try again.",
    "revoke-member-failed": "Member access could not be revoked. Refresh and try again.",
    "revoke-invitation-failed": "The invitation could not be revoked. Refresh and try again.",
  };
  const availableRoles = actorRole === "owner"
    ? roles
    : roles.filter(([value]) => !["admin", "finance_manager"].includes(value));

  return (
    <section className="panel members-panel">
      <div className="panel-heading">
        <div><p className="kicker">ACCESS & PERMISSIONS</p><h2>Organization members</h2></div>
        <span className="count">{members.length}</span>
      </div>
      <p className="muted">Invite colleagues by email and assign only the access they need. Invitations expire after seven days and can be revoked at any time.</p>
      {memberNotice && notices[memberNotice] && <p className="form-success" role="status">{notices[memberNotice]}</p>}
      {memberError && errors[memberError] && <p className="form-error" role="alert">{errors[memberError]}</p>}

      <div className="member-invite-box">
        <h3>Invite a member</h3>
        <form action={action} className="member-invite-form">
          <input type="hidden" name="organizationId" value={organizationId} />
          <label>Email address<input name="email" type="email" autoComplete="email" placeholder="colleague@example.com" required /></label>
          <label>Organization role
            <select name="role" defaultValue="election_manager">
              {availableRoles.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </label>
          <button className="primary-button" disabled={pending}>{pending ? "Sending…" : "Send invitation"}</button>
        </form>
        {state.error && <p className="form-error" role="alert">{state.error}</p>}
        {state.message && <p className="form-hint" role="status">{state.message}</p>}
      </div>

      <div className="member-list">
        <h3>Current members</h3>
        {members.map((member) => (
          <article className="member-row" key={member.member_id}>
            <div className="member-identity">
              <strong>{member.display_name || member.email || "Organization member"}</strong>
              <span className="muted">{member.email || member.user_id}</span>
              <span className="status-pill">{member.status}</span>
            </div>
            <div className="member-controls">
              {member.role === "owner" ? <span className="role-label">Owner</span> : (
                <>
                  <PendingMemberForm action={changeOrganizationMemberRoleAction} className="inline-member-form"
                    buttonClassName="secondary-button compact-button" buttonLabel="Save role" pendingLabel="Saving role…">
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="memberId" value={member.member_id} />
                    <select name="role" defaultValue={member.role} aria-label={`Role for ${member.email ?? member.user_id}`}>
                      {availableRoles.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                    </select>
                  </PendingMemberForm>
                  <PendingMemberForm action={revokeOrganizationMemberAction} buttonClassName="quiet-button danger-button"
                    buttonLabel="Revoke access" pendingLabel="Revoking access…">
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="memberId" value={member.member_id} />
                    <label className="form-hint"><input type="checkbox" name="confirmRevokeMember" value="true" required /> Confirm revoke access</label>
                  </PendingMemberForm>
                </>
              )}
              <span className="role-label">{member.role.replaceAll("_", " ")}</span>
            </div>
          </article>
        ))}
      </div>

      <div className="member-list pending-invitations">
        <h3>Pending invitations</h3>
        {invitations.length === 0 ? <p className="muted">No pending invitations.</p> : invitations.map((invitation) => (
          <article className="member-row" key={invitation.id}>
            <div className="member-identity">
              <strong>{invitation.email}</strong>
              <span className="muted">Expires {new Date(invitation.expires_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}</span>
              <span className="role-label">{invitation.role.replaceAll("_", " ")}</span>
            </div>
            <PendingMemberForm action={revokeOrganizationInvitationAction} buttonClassName="quiet-button danger-button"
              buttonLabel="Revoke invitation" pendingLabel="Revoking invitation…">
              <input type="hidden" name="organizationId" value={organizationId} />
              <input type="hidden" name="invitationId" value={invitation.id} />
              <label className="form-hint"><input type="checkbox" name="confirmRevokeInvitation" value="true" required /> Confirm revoke invitation</label>
            </PendingMemberForm>
          </article>
        ))}
      </div>
    </section>
  );
}
