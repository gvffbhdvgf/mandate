import Link from "next/link";
import { cookies } from "next/headers";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { AcceptInvitationForm } from "./accept-form";
import { switchInvitationAccountAction } from "../../actions/organization-members";
import { InvitationTokenCapture } from "./invitation-token-capture";

const errors: Record<string, string> = {
  "email-mismatch": "Sign in using the exact email address this invitation was sent to.",
  expired: "This invitation has expired. Ask an organization administrator to send a new one.",
  unavailable: "This invitation has already been used or revoked. Ask an administrator for a new invitation.",
  failed: "We could not accept this invitation. Please try again or contact the organization administrator.",
};

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const cookieStore = await cookies();
  const token = cookieStore.get("mandate_invitation_token")?.value ?? "";
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <main className="auth-shell">
      <Link className="brand" href="/"><span className="brand-mark">M</span><span>mandate</span></Link>
      <section className="auth-card">
        <p className="kicker">ORGANIZATION INVITATION</p>
        <h1>Join your organization</h1>
        <p className="muted">You’ve been invited to join an organization on Mandate. Sign in with the invited email address to accept.</p>
        {params.error && <p className="form-error" role="alert">{errors[params.error] ?? errors.failed}</p>}
        {!token ? (
          <InvitationTokenCapture />
        ) : user ? (
          <>
            <p className="form-hint">Signed in as <strong>{user.email}</strong>. Accepting will add this account to the organization with the assigned role.</p>
            <AcceptInvitationForm />
            {params.error === "email-mismatch" && (
              <form action={switchInvitationAccountAction}>
                <button className="secondary-button">Sign out and use the invited email</button>
              </form>
            )}
          </>
        ) : (
          <div className="form-stack">
            <Link className="primary-button link-button" href="/login?next=%2Finvitations%2Faccept">Sign in to accept</Link>
            <Link className="secondary-button" href="/signup?next=%2Finvitations%2Faccept">Create an account</Link>
          </div>
        )}
      </section>
    </main>
  );
}
