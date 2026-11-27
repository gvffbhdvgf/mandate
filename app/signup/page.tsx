import Link from "next/link";
import { SignupForm } from "./signup-form";
import { safeInternalPath } from "../../lib/navigation";

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const next = safeInternalPath(params.next);
  return (
    <main id="main-content" tabIndex={-1} className="auth-shell">
      <Link className="brand" href="/"><span className="brand-mark">M</span><span>mandate</span></Link>
      <section className="auth-card">
        <p className="kicker">GET STARTED</p>
        <h1>Create your account</h1>
        <p className="muted">Start organizing clear, accountable elections for your organization.</p>
        <SignupForm next={next} />
        <p className="auth-foot">Already have an account? <Link href={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link></p>
      </section>
    </main>
  );
}
