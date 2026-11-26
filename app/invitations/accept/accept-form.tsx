import { acceptOrganizationInvitationAction } from "../../actions/organization-members";

export function AcceptInvitationForm({ token }: { token: string }) {
  return (
    <form action={acceptOrganizationInvitationAction} className="form-stack">
      <input type="hidden" name="token" value={token} />
      <button className="primary-button">Accept invitation</button>
    </form>
  );
}
