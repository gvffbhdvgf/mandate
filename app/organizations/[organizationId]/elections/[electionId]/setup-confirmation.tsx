"use client";

import { useState, useTransition } from "react";
import { confirmElectionSetupAction } from "../../../../actions/elections";

export function SetupConfirmation({
  electionId, confirmed,
}: { electionId: string; confirmed: boolean }) {
  const [authorityConfirmed, setAuthorityConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  if (confirmed) return (
    <section className="panel">
      <p className="kicker">AUTHORITY REVIEW</p>
      <h2>Setup confirmed</h2>
      <p className="form-hint">The reviewed election configuration has been cryptographically bound to the authority confirmation.</p>
    </section>
  );

  return (
    <section className="panel form-stack">
      <p className="kicker">AUTHORITY REVIEW REQUIRED</p>
      <h2>Review and confirm election setup</h2>
      <p className="muted">Opening this election is blocked until an authorized organization officer confirms the rules and contest configuration. If the configuration changes after confirmation, approval must be repeated.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <label className="checkbox-row">
        <input type="checkbox" checked={authorityConfirmed}
          onChange={(event) => setAuthorityConfirmed(event.target.checked)} />
        I confirm that I am authorized to approve this election configuration on behalf of the organization.
      </label>
      <button type="button" className="primary-button" disabled={!authorityConfirmed || pending}
        onClick={() => startTransition(async () => {
          setError("");
          const result = await confirmElectionSetupAction({ electionId, authorityConfirmed });
          if (result.error) setError(result.error);
          else window.location.reload();
        })}>
        {pending ? "Recording confirmation…" : "Confirm election setup"}
      </button>
    </section>
  );
}
