import Link from "next/link";

export default function HomePage() {
  return (
    <main className="shell" id="main-content" tabIndex={-1}>
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Mandate home">
          <span className="brand-mark">M</span><span>mandate</span>
        </Link>
        <nav className="nav-actions"><Link href="/login">Sign in</Link><Link className="nav-cta" href="/signup">Get started</Link></nav>
      </header>
      <section className="hero hero-grid">
        <div className="hero-copy">
          <p className="kicker">CLEAR PROCESS. CONFIDENT DECISIONS.</p>
          <h1>Organizational elections,<br /><em>made clear.</em></h1>
          <p className="intro">A guided, accountable way to plan and run elections for the organizations that bring people together.</p>
          <div className="hero-actions"><Link className="primary-button link-button" href="/signup">Create your workspace</Link><Link className="secondary-button" href="/login">I already have an account</Link></div>
        </div>
        <aside className="hero-guide" aria-label="How an election works on Mandate">
          <div className="hero-guide-heading"><span>THE ELECTION JOURNEY</span><span>01 — 04</span></div>
          <ol className="hero-steps">
            <li><span>01</span><div><strong>Set the rules</strong><p>Define the election, voting method and schedule.</p></div></li>
            <li><span>02</span><div><strong>Prepare the register</strong><p>Add eligible voters and issue secure invitations.</p></div></li>
            <li><span>03</span><div><strong>Run the vote</strong><p>Give every eligible voter a clear, private ballot.</p></div></li>
            <li><span>04</span><div><strong>Reconcile and report</strong><p>Review the count and publish aggregate results.</p></div></li>
          </ol>
          <p className="hero-guide-note">Each stage has clear checks, recorded decisions and visible next steps.</p>
        </aside>
      </section>
      <section className="home-principles" aria-label="Mandate principles">
        <div><span>01</span><strong>Clear by design</strong><p>Plain language and guided steps at every stage.</p></div>
        <div><span>02</span><strong>Accountable by default</strong><p>Important actions are recorded and reviewable.</p></div>
        <div><span>03</span><strong>Private where it matters</strong><p>Voter identity is kept separate from ballot choices.</p></div>
      </section>
      <footer>Mandate · Built for transparent organizational decision-making</footer>
    </main>
  );
}
