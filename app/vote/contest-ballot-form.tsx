"use client";

import { useActionState } from "react";
import { castRegisteredBallotAction, type BallotActionState } from "../actions/ballot";

type Contest = {
  id: string;
  title: string;
  required: boolean;
  alreadyVoted: boolean;
  options: Array<{ id: string; displayName: string }>;
};

const initialState: BallotActionState = {};

export function ContestBallotForm({ token, contest, voteUnits }: {
  token: string;
  contest: Contest;
  voteUnits: number;
}) {
  const [state, action, pending] = useActionState(castRegisteredBallotAction, initialState);
  const completed = contest.alreadyVoted || Boolean(state.receiptCode);

  return (
    <section className="ballot-contest">
      <div className="ballot-contest-heading">
        <div><p className="kicker">CONTEST</p><h2>{contest.title}</h2></div>
        {completed && <span className="status-pill">Recorded</span>}
      </div>
      {completed ? (
        <div className="ballot-success">
          <strong>Your ballot has been recorded.</strong>
          {state.receiptCode && <p>Receipt code: <code>{state.receiptCode}</code></p>}
        </div>
      ) : (
        <form action={action} className="ballot-options">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="contestId" value={contest.id} />
          {contest.options.map((option) => (
            <label className="ballot-option" key={option.id}>
              <input type="radio" name="optionId" value={option.id} required />
              <span>{option.displayName}</span>
            </label>
          ))}
          <p className="form-hint">{voteUnits > 1 ? `Your registered voting weight: ${voteUnits}.` : "One vote in this contest."} Your selection is private and cannot be changed after submission.</p>
          {state.error && <p className="form-error" role="alert">{state.error}</p>}
          <label className="ballot-confirmation"><input type="checkbox" name="confirmation" value="true" required /> I confirm this is my final selection.</label>
          <button className="primary-button" disabled={pending}>{pending ? "Recording ballot…" : "Submit ballot"}</button>
        </form>
      )}
    </section>
  );
}
