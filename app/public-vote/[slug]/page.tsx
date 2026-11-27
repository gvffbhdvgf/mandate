import Link from "next/link";
import { getPublicElectionDetails } from "../../actions/public-vote";
import { ParticipantVerificationForm } from "./participant-verification-form";

export const dynamic = "force-dynamic";

export default async function PublicVotePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const election = await getPublicElectionDetails(slug);

  return (
    <main className="auth-shell">
      <Link className="brand" href="/"><span className="brand-mark">M</span><span>mandate</span></Link>
      <section className="auth-card">
        <p className="kicker">PUBLIC PARTICIPANT ACCESS</p>
        {election ? (
          <>
            <h1>{election.title}</h1>
            {election.description && <p className="muted">{election.description}</p>}
            <p className="muted">Verify your email before purchasing voting credits. Your email is kept separate from your ballot choices.</p>
            {election.currency === "KES" && election.pricePerCreditMinor > 0 && (
              <p className="form-hint">Price per credit: KSh {(election.pricePerCreditMinor / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Maximum credits per participant: {election.maxCreditsPerParticipant}.</p>
            )}
            {election.status === "open" && election.contactVerificationRequired ? (
              <ParticipantVerificationForm slug={slug} />
            ) : (
              <p className="form-hint" role="status">This election is not currently accepting public participant verification.</p>
            )}
          </>
        ) : (
          <>
            <h1>Election unavailable</h1>
            <p className="muted">This public election link is invalid or not available.</p>
          </>
        )}
      </section>
      <p className="auth-foot">Mandate · Organizational elections, made clear.</p>
    </main>
  );
}
