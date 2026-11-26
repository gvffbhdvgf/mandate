"use client";

import { useEffect, useState } from "react";
import { loadRegisteredBallotAction } from "../actions/ballot";
import { ContestBallotForm } from "./contest-ballot-form";

type BallotContext = {
  election: { id: string; title: string; endsAt: string; timezone: string; votingMode: string };
  voteUnits: number;
  contests: Array<{
    id: string;
    title: string;
    required: boolean;
    tiePolicy: string;
    alreadyVoted: boolean;
    options: Array<{ id: string; displayName: string }>;
  }>;
};

export default function VoterBallotPage() {
  const [token, setToken] = useState("");
  const [context, setContext] = useState<BallotContext | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const accessToken = window.location.hash.slice(1);
    window.history.replaceState(null, "", window.location.pathname);
    if (!accessToken) {
      setError("Open the secure invitation link from your email to access your ballot.");
      setLoading(false);
      return;
    }

    setToken(accessToken);
    loadRegisteredBallotAction(accessToken).then((result) => {
      if (result.error) setError(result.error);
      else setContext(result.context as BallotContext);
      setLoading(false);
    }).catch(() => {
      setError("We could not load your ballot. Open the invitation link again.");
      setLoading(false);
    });
  }, []);

  return (
    <main className="ballot-shell">
      <header className="ballot-header">
        <span className="brand"><span className="brand-mark">M</span><span>mandate</span></span>
        <span className="eyebrow">PRIVATE VOTING</span>
      </header>
      {loading ? (
        <section className="ballot-panel"><p className="kicker">SECURE BALLOT</p><h1>Preparing your ballot…</h1><p className="muted">Your access link is being verified.</p></section>
      ) : error ? (
        <section className="ballot-panel"><p className="kicker">BALLOT UNAVAILABLE</p><h1>We could not open this ballot.</h1><p className="muted">{error}</p></section>
      ) : context ? (
        <>
          <section className="ballot-panel">
            <p className="kicker">YOUR SECURE BALLOT</p>
            <h1>{context.election.title}</h1>
            <p className="muted">Your access link is valid. Make your selection in each required contest. Your identity is kept separate from your ballot choices.</p>
            <div className="ballot-meta">
              <span>{context.election.votingMode.replaceAll("_", " ")}</span>
              <span>Closes {new Date(context.election.endsAt).toLocaleString("en-KE", { timeZone: context.election.timezone })}</span>
            </div>
          </section>
          {context.contests.map((contest) => (
            <ContestBallotForm key={contest.id} token={token} contest={contest} voteUnits={context.voteUnits} />
          ))}
          <p className="ballot-privacy">Mandate records your submission receipt separately from your identity. Keep this invitation link private.</p>
        </>
      ) : null}
      <footer className="ballot-footer">Mandate · Organizational elections, made clear.</footer>
    </main>
  );
}
