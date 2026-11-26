import { acceptOrganizationInvitationAction } from "../../actions/organization-members";

export function AcceptInvitationForm() {
  return (
    <form action={acceptOrganizationInvitationAction} className="form-stack">
      <button className="primary-button">Accept invitation</button>
    </form>
  );
}
