"use client";

import { useActionState } from "react";
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
}: {
  organizationId: string;
  members: Member[];
  invitations: Invitation[];
  actorRole: string;
}) {
  const [state, action, pending] = useActionState(createOrganizationInvitationAction, {} as MemberActionState);
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
                  <form action={changeOrganizationMemberRoleAction} className="inline-member-form">
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="memberId" value={member.member_id} />
                    <select name="role" defaultValue={member.role} aria-label={`Role for ${member.email ?? member.user_id}`}>
                      {availableRoles.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                    </select>
                    <button className="secondary-button compact-button">Save role</button>
                  </form>
                  <form action={revokeOrganizationMemberAction}>
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="memberId" value={member.member_id} />
                    <button className="quiet-button danger-button">Revoke access</button>
                  </form>
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
            <form action={revokeOrganizationInvitationAction}>
              <input type="hidden" name="organizationId" value={organizationId} />
              <input type="hidden" name="invitationId" value={invitation.id} />
              <button className="quiet-button danger-button">Revoke invitation</button>
            </form>
          </article>
        ))}
      </div>
    </section>
  );
}
