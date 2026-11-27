import Link from "next/link";
import { redirect } from "next/navigation";
import { UpdatePasswordForm } from "./update-password-form";
import { safeInternalPath } from "../../lib/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export default async function UpdatePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/forgot-password?notice=expired");

  const next = safeInternalPath(params.next);
  return (
    <main className="auth-shell">
      <Link className="brand" href="/"><span className="brand-mark">M</span><span>mandate</span></Link>
      <section className="auth-card">
        <p className="kicker">ACCOUNT RECOVERY</p>
        <h1>Choose a new password</h1>
        <p className="muted">Use at least 10 characters. Your new password will replace the old one.</p>
        <UpdatePasswordForm next={next} />
      </section>
    </main>
  );
}
