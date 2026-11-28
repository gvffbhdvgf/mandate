import Link from "next/link";
import { ForgotPasswordForm } from "./forgot-password-form";

export default async function ForgotPasswordPage({ searchParams }: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const params = await searchParams;
  return (
    <main id="main-content" tabIndex={-1} className="auth-shell">
      <Link className="brand" href="/"><span className="brand-mark">M</span><span>mandate</span></Link>
      <section className="auth-card">
        <p className="kicker">ACCOUNT RECOVERY</p>
        <h1>Reset your password</h1>
        <p className="muted">Enter the email address used for your Mandate account. We’ll send a secure reset link if an account exists.</p>
        {params.notice === "expired" && <p className="form-error" role="alert">That reset link is missing, expired or already used. Request a new one below.</p>}
        <ForgotPasswordForm />
        <p className="auth-foot"><Link href="/login">Back to sign in</Link></p>
      </section>
    </main>
  );
}
