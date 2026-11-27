import Link from "next/link";
import { LoginForm } from "./login-form";
import { safeInternalPath } from "../../lib/navigation";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; notice?: string }> }) {
  const params = await searchParams;
  const next = safeInternalPath(params.next);
  return (
    <main id="main-content" className="auth-shell">
      <Link className="brand" href="/"><span className="brand-mark">M</span><span>mandate</span></Link>
      <section className="auth-card">
        <p className="kicker">WELCOME BACK</p>
        <h1>Sign in to Mandate</h1>
        <p className="muted">Manage your organization’s elections with clarity and confidence.</p>
        <LoginForm next={next} notice={params.notice} />
        <p className="auth-foot">New to Mandate? <Link href={`/signup?next=${encodeURIComponent(next)}`}>Create an account</Link></p>
      </section>
    </main>
  );
}
