import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { AcceptInvitationForm } from "./accept-form";

const errors: Record<string, string> = {
  "email-mismatch": "Sign in using the exact email address this invitation was sent to.",
  expired: "This invitation has expired. Ask an organization administrator to send a new one.",
  unavailable: "This invitation has already been used or revoked. Ask an administrator for a new invitation.",
  failed: "We could not accept this invitation. Please try again or contact the organization administrator.",
};

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const params = await searchParams;
  const token = params.token ?? "";
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) redirect("/login");
  const next = `/invitations/accept?token=${encodeURIComponent(token)}`;
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
        {user ? (
          <>
            <p className="form-hint">Signed in as <strong>{user.email}</strong>. Accepting will add this account to the organization with the assigned role.</p>
            <AcceptInvitationForm token={token} />
          </>
        ) : (
          <div className="form-stack">
            <Link className="primary-button link-button" href={`/login?next=${encodeURIComponent(next)}`}>Sign in to accept</Link>
            <Link className="secondary-button" href={`/signup?next=${encodeURIComponent(next)}`}>Create an account</Link>
          </div>
        )}
      </section>
    </main>
  );
}
