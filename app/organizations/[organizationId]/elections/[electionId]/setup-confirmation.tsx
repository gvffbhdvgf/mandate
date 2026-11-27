"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ActionToast } from "../../../../components/action-toast";
import { confirmElectionSetupAction } from "../../../../actions/elections";

export function SetupConfirmation({
  electionId, confirmed,
}: { electionId: string; confirmed: boolean }) {
  const router = useRouter();
  const [authorityConfirmed, setAuthorityConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <section className="panel form-stack">
      <p className="kicker">{confirmed ? "AUTHORITY REVIEW RECORDED" : "AUTHORITY REVIEW REQUIRED"}</p>
      <h2>{confirmed ? "Reconfirm election setup if it has changed" : "Review and confirm election setup"}</h2>
      <p className="muted">{confirmed
        ? "A confirmation is recorded. If you have changed the draft configuration since that review, confirm again; the database checks the exact configuration hash when opening."
        : "Opening this election is blocked until an authorized organization officer confirms the rules and contest configuration."}</p>
      <ActionToast message={notice} />
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
          else {
            setNotice("Election setup approval recorded. The opening checklist has been refreshed.");
            router.refresh();
          }
        })}>
        {pending ? "Recording confirmation…" : confirmed ? "Reconfirm current setup" : "Confirm election setup"}
      </button>
    </section>
  );
}
