"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  closeElectionAction,
  openElectionAction,
  pauseElectionAction,
  resumeElectionAction,
  publishResultsAction,
  tallyElectionAction,
  type LifecycleActionState,
} from "../../../../actions/lifecycle";

const initialState: LifecycleActionState = {};

type TallySummary = {
  status?: string;
  electionStatus?: string;
  eligibleVoters?: number;
  participatingVoters?: number;
  acceptedBallots?: number;
  invalidatedBallots?: number;
  requiresResolution?: boolean;
};

export function ElectionLifecycleControls({
  organizationId,
  electionId,
  status,
  votingMode,
  canOpen,
  canClose,
  canTally,
  canPublish,
  tallySummary,
}: {
  organizationId: string;
  electionId: string;
  status: string;
  votingMode: string;
  canOpen: boolean;
  canClose: boolean;
  canTally: boolean;
  canPublish: boolean;
  tallySummary: TallySummary | null;
}) {
  const router = useRouter();
  const [openState, openAction, openPending] = useActionState(openElectionAction, initialState);
  const [closeState, closeAction, closePending] = useActionState(closeElectionAction, initialState);
  const [pauseState, pauseAction, pausePending] = useActionState(pauseElectionAction, initialState);
  const [resumeState, resumeAction, resumePending] = useActionState(resumeElectionAction, initialState);
  const [tallyState, tallyAction, tallyPending] = useActionState(tallyElectionAction, initialState);
  const [publishState, publishAction, publishPending] = useActionState(publishResultsAction, initialState);

  useEffect(() => {
    if (openState.success || closeState.success || pauseState.success || resumeState.success || tallyState.success || publishState.success) router.refresh();
  }, [openState.success, closeState.success, pauseState.success, resumeState.success, tallyState.success, publishState.success, router]);

  const hiddenFields = (
    <>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="electionId" value={electionId} />
    </>
  );

  return (
    <section className="panel lifecycle-panel">
      <div className="panel-heading"><div><p className="kicker">ELECTION CONTROL</p><h2>Lifecycle and results</h2></div><span className="status-pill">{status.replaceAll("_", " ")}</span></div>

      {status === "draft" || status === "scheduled" ? (
        canOpen ? (
          <form action={openAction} className="form-stack lifecycle-form">
            {hiddenFields}
            <p className="muted">{votingMode === "public_paid"
              ? "Opening freezes the public price, participant cap, rules and candidate snapshot. Mandate merchant authorization and the public paid-voting release gates must be active; the database enforces these gates."
              : "Opening freezes the rules and candidate snapshot. The voter register must be complete and every eligible voter must have an invitation issued."}</p>
            {openState.error && <p className="form-error" role="alert">{openState.error}</p>}
            <label className="ballot-confirmation"><input type="checkbox" name="confirmRules" value="true" required /> I have reviewed the election rules, options and {votingMode === "public_paid" ? "public participant access and credit limits" : "eligible voter register and voter access"}.</label>
            <button className="primary-button" disabled={openPending}>{openPending ? "Checking opening requirements…" : "Open election"}</button>
          </form>
        ) : <p className="form-hint">An election manager or administrator must open this election.</p>
      ) : null}

      {status === "open" && canClose && (
        <form action={pauseAction} className="form-stack lifecycle-form">
          {hiddenFields}
          <label>Reason for pausing<textarea name="reason" minLength={10} maxLength={1000} required placeholder="Record why voting is being paused." /></label>
          {pauseState.error && <p className="form-error" role="alert">{pauseState.error}</p>}
          <button className="secondary-button" disabled={pausePending}>{pausePending ? "Pausing election…" : "Pause voting"}</button>
        </form>
      )}

      {status === "paused" && canClose && (
        <form action={resumeAction} className="form-stack lifecycle-form">
          {hiddenFields}
          <label>Reason for resuming<textarea name="reason" minLength={10} maxLength={1000} required placeholder="Record why voting is being resumed." /></label>
          {resumeState.error && <p className="form-error" role="alert">{resumeState.error}</p>}
          <button className="primary-button" disabled={resumePending}>{resumePending ? "Resuming election…" : "Resume voting"}</button>
        </form>
      )}

      {(status === "open" || status === "paused") && (
        canClose ? (
          <form action={closeAction} className="form-stack lifecycle-form">
            {hiddenFields}
            <label>Reason for closing<textarea name="reason" minLength={10} maxLength={1000} required placeholder="Record why the election is being closed." /></label>
            {closeState.error && <p className="form-error" role="alert">{closeState.error}</p>}
            <button className="danger-button" disabled={closePending}>{closePending ? "Closing election…" : "Close election"}</button>
          </form>
        ) : <p className="form-hint">A returning officer or election manager must close this election.</p>
      )}

      {status === "closed" && (
        canTally ? (
          <form action={tallyAction} className="form-stack lifecycle-form">
            {hiddenFields}
            <p className="muted">Reconciliation checks ballot records against the separate participation controls and frozen election snapshot. It publishes aggregate counts only.</p>
            {tallyState.error && <p className="form-error" role="alert">{tallyState.error}</p>}
            {tallyState.message && <p className="form-success" role="status">{tallyState.message}</p>}
            <button className="primary-button" disabled={tallyPending}>{tallyPending ? "Reconciling ballots…" : "Run tally and reconciliation"}</button>
          </form>
        ) : <p className="form-hint">A returning officer or election manager must run reconciliation.</p>
      )}

      {(status === "tallying" || tallyState.success) && (
        <div className="tally-summary">
          <p className="kicker">RECONCILIATION SUMMARY</p>
          {tallySummary ? (
            <div className="summary-grid">
              <div><span>{votingMode === "public_paid" ? "Verified participants" : "Eligible voters"}</span><strong>{tallySummary.eligibleVoters ?? 0}</strong></div>
              <div><span>{votingMode === "public_paid" ? "Participants who cast ballots" : "Participating voters"}</span><strong>{tallySummary.participatingVoters ?? 0}</strong></div>
              <div><span>Accepted ballots</span><strong>{tallySummary.acceptedBallots ?? 0}</strong></div>
              <div><span>Invalidated ballots</span><strong>{tallySummary.invalidatedBallots ?? 0}</strong></div>
            </div>
          ) : tallyState.counts ? (
            <div className="summary-grid">
              <div><span>{votingMode === "public_paid" ? "Verified participants" : "Eligible voters"}</span><strong>{tallyState.counts.eligibleVoters}</strong></div>
              <div><span>{votingMode === "public_paid" ? "Participants who cast ballots" : "Participating voters"}</span><strong>{tallyState.counts.participatingVoters}</strong></div>
              <div><span>Accepted ballots</span><strong>{tallyState.counts.acceptedBallots}</strong></div>
              <div><span>Invalidated ballots</span><strong>{tallyState.counts.invalidatedBallots}</strong></div>
            </div>
          ) : <p className="form-hint">Reconciliation summary is not available for this role.</p>}
          {(tallySummary?.requiresResolution ?? tallyState.requiresResolution) ? (
            <p className="form-hint">A tied contest requires the configured runoff or external resolution before publication.</p>
          ) : canPublish ? (
            <form action={publishAction} className="form-stack lifecycle-form">
              {hiddenFields}
              {publishState.error && <p className="form-error" role="alert">{publishState.error}</p>}
              {publishState.message && <p className="form-success" role="status">{publishState.message}</p>}
              <button className="primary-button" disabled={publishPending}>{publishPending ? "Publishing results…" : "Publish results"}</button>
            </form>
          ) : <p className="form-hint">An owner, administrator or returning officer must publish results.</p>}
        </div>
      )}

      {status === "results_published" && <p className="form-success" role="status">Results have been published according to the election visibility setting.</p>}
    </section>
  );
}
