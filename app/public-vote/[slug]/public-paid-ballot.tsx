"use client";

import { useState, useTransition } from "react";
import { castPublicPaidBallot } from "../../actions/public-vote";

type BallotContext = {
  election: { title: string; slug: string; endsAt: string; timezone: string };
  creditsRemaining: number;
  contests: Array<{
    id: string;
    title: string;
    required: boolean;
    ballotsCast: number;
    options: Array<{ id: string; displayName: string }>;
  }>;
};

export function PublicPaidBallot({
  slug,
  initialContext,
}: {
  slug: string;
  initialContext: BallotContext;
}) {
  const [context, setContext] = useState(initialContext);
  return (
    <section className="form-stack">
      <div className="form-hint" role="status">
        <strong>{context.creditsRemaining}</strong> voting credit{context.creditsRemaining === 1 ? "" : "s"} available
      </div>
      {context.contests.map((contest) => (
        <PaidContest
          key={contest.id}
          slug={slug}
          contest={contest}
          maxCredits={context.creditsRemaining}
          onContextChange={setContext}
        />
      ))}
    </section>
  );
}

function PaidContest({
  slug,
  contest,
  maxCredits,
  onContextChange,
}: {
  slug: string;
  contest: BallotContext["contests"][number];
  maxCredits: number;
  onContextChange: (context: BallotContext) => void;
}) {
  const [optionId, setOptionId] = useState("");
  const [credits, setCredits] = useState(1);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [receipt, setReceipt] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!optionId || credits < 1 || credits > maxCredits) {
      setError("Select an option and a valid number of credits.");
      return;
    }
    const key = idempotencyKey || crypto.randomUUID();
    setIdempotencyKey(key);
    startTransition(async () => {
      const result = await castPublicPaidBallot(slug, contest.id, optionId, credits, key);
      if (result.error) {
        setError(result.error);
      } else {
        setReceipt(result.receiptCode ?? "");
        setIdempotencyKey("");
        if (result.context) onContextChange(result.context as BallotContext);
      }
    });
  }

  return (
    <article className="auth-card">
      <p className="kicker">BALLOT CONTEST</p>
      <h2>{contest.title}</h2>
      <p className="muted">Previously cast: {contest.ballotsCast}</p>
      <form className="form-stack" onSubmit={submit}>
        <fieldset className="form-stack">
          <legend>Select one option</legend>
          {maxCredits < 1 ? (
        <p className="form-hint">No voting credits remain. Purchase additional credits if the election is still accepting payments.</p>
      ) : (
        <form className="form-stack" onSubmit={submit}>
          <fieldset className="form-stack">
            <legend>Select one option</legend>
            {contest.options.map((option) => (
            <label key={option.id}>
              <input
                type="radio"
                name={`option-${contest.id}`}
                value={option.id}
                checked={optionId === option.id}
                onChange={() => {
                  setOptionId(option.id);
                  setIdempotencyKey("");
                  setReceipt("");
                }}
              />
              {option.displayName}
            </label>
            ))}
          </fieldset>
          <label>Credits to use
            <input
              type="number"
              min={1}
              max={maxCredits}
              step={1}
              value={credits}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isSafeInteger(next) && next >= 1 && next <= Math.max(1, maxCredits)) {
                  setCredits(next);
                  setIdempotencyKey("");
                  setReceipt("");
                }
              }}
              required
            />
          </label>
          <button className="primary-button" disabled={pending || !optionId || maxCredits < 1}>
            {pending ? "Recording ballot…" : "Confirm and cast ballot"}
          </button>
        </form>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {receipt && <p className="form-hint" role="status">Ballot accepted. Receipt: {receipt}</p>}
    </article>
  );
}
