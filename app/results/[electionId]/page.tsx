import Link from "next/link";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = {
  title: "Published election results | Mandate",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function PublicResultsPage({ params }: { params: Promise<{ electionId: string }> }) {
  const { electionId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(electionId)) notFound();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_published_results", { p_election_id: electionId });
  if (error || !data) notFound();

  return (
    <main className="ballot-shell">
      <header className="ballot-header">
        <Link className="brand" href="/"><span className="brand-mark">M</span><span>mandate</span></Link>
        <span className="eyebrow">PUBLISHED RESULTS</span>
      </header>
      <section className="ballot-panel">
        <p className="kicker">OFFICIAL RESULTS</p>
        <h1>{data.election.title}</h1>
        <p className="muted">Published {new Date(data.election.publishedAt).toLocaleString("en-KE", { timeZone: data.election.timezone })}</p>
        <div className="summary-grid">
          <div><span>Eligible voters</span><strong>{data.tally.eligibleVoters}</strong></div>
          <div><span>Participating voters</span><strong>{data.tally.participatingVoters}</strong></div>
          <div><span>Accepted ballots</span><strong>{data.tally.acceptedBallots}</strong></div>
          <div><span>Turnout</span><strong>{(data.tally.turnoutBasisPoints / 100).toFixed(1)}%</strong></div>
        </div>
      </section>
      {data.contests.map((contest: any) => (
        <section className="ballot-contest" key={contest.id}>
          <h2>{contest.title}</h2>
          {contest.options.map((option: any) => (
            <div className="result-option" key={option.id}>
              <div className="result-option-label"><span>{option.name}</span><strong>{option.voteUnits} votes · {(option.shareBasisPoints / 100).toFixed(1)}%</strong></div>
              <div className="result-bar"><span style={{ width: `${option.shareBasisPoints / 100}%` }} /></div>
              {option.isWinner && <span className="winner-label">Winner</span>}
              {option.isTied && <span className="muted">Tied</span>}
            </div>
          ))}
        </section>
      ))}
      <footer className="ballot-footer">Mandate · Organizational elections, made clear.</footer>
    </main>
  );
}
