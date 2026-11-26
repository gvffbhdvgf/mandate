export default function HomePage() {
  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Mandate home">
          <span className="brand-mark">M</span>
          <span>mandate</span>
        </a>
        <span className="eyebrow">ORGANIZATIONAL ELECTIONS</span>
      </header>
      <section className="hero">
        <p className="kicker">CLEAR PROCESS. CONFIDENT DECISIONS.</p>
        <h1>Organizational elections,<br /><em>made clear.</em></h1>
        <p className="intro">
          A guided, accountable way to plan and run elections for the
          organizations that bring people together.
        </p>
        <div className="status">M0 foundation · Runtime validation</div>
      </section>
      <footer>Mandate · Built for transparent organizational decision-making</footer>
    </main>
  );
}
