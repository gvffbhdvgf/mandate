import Link from "next/link";
import { ForgotPasswordForm } from "./forgot-password-form";
import { safeInternalPath } from "../../lib/navigation";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; notice?: string }>;
}) {
  const params = await searchParams;
  const next = safeInternalPath(params.next);
  return (
    <main className="auth-shell">
      <Link className="brand" href="/"><span className="brand-mark">M</span><span>mandate</span></Link>
      <section className="auth-card">
        <p className="kicker">ACCOUNT RECOVERY</p>
        <h1>Reset your password</h1>
        <p className="muted">Enter the email address associated with your account. If an account exists, we’ll send a secure reset link.</p>
        {params.notice === "expired" && <p className="form-hint" role="status">That reset link may have expired. Request a new one below.</p>}
        <ForgotPasswordForm next={next} />
        <p className="auth-foot"><Link href={`/login?next=${encodeURIComponent(next)}`}>Back to sign in</Link></p>
      </section>
    </main>
  );
}
