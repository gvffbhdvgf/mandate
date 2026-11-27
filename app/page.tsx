import Link from "next/link";

export default function HomePage() {
  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Mandate home">
          <span className="brand-mark">M</span><span>mandate</span>
        </Link>
        <nav className="nav-actions"><Link href="/login">Sign in</Link><Link className="nav-cta" href="/signup">Get started</Link></nav>
      </header>
      <section className="hero">
        <p className="kicker">CLEAR PROCESS. CONFIDENT DECISIONS.</p>
        <h1>Organizational elections,<br /><em>made clear.</em></h1>
        <p className="intro">A guided, accountable way to plan and run elections for the organizations that bring people together.</p>
        <div className="hero-actions"><Link className="primary-button link-button" href="/signup">Create your workspace</Link><Link className="secondary-button" href="/login">I already have an account</Link></div>
      </section>
      <footer>Mandate · Built for transparent organizational decision-making</footer>
    </main>
  );
}
