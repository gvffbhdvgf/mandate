import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { ResetPasswordForm } from "./reset-password-form";

export default async function ResetPasswordPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/forgot-password?notice=expired");

  return (
    <main id="main-content" tabIndex={-1} className="auth-shell">
      <Link className="brand" href="/"><span className="brand-mark">M</span><span>mandate</span></Link>
      <section className="auth-card">
        <p className="kicker">ACCOUNT RECOVERY</p>
        <h1>Choose a new password</h1>
        <p className="muted">Use at least 10 characters. You’ll be signed in after your password is updated.</p>
        <ResetPasswordForm />
      </section>
    </main>
  );
}
