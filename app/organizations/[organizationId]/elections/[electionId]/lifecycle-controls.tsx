"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatStatusLabel } from "../../../../../lib/ui/presentation";
import { ActionToast } from "../../../../components/action-toast";
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
  openingChecks,
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
  openingChecks: Array<{ label: string; complete: boolean; detail: string }>;
}) {
  const router = useRouter();
  const [openState, openAction, openPending] = useActionState(openElectionAction, initialState);
  const [closeState, closeAction, closePending] = useActionState(closeElectionAction, initialState);
  const [pauseState, pauseAction, pausePending] = useActionState(pauseElectionAction, initialState);
  const [resumeState, resumeAction, resumePending] = useActionState(resumeElectionAction, initialState);
  const [tallyState, tallyAction, tallyPending] = useActionState(tallyElectionAction, initialState);
  const [publishState, publishAction, publishPending] = useActionState(publishResultsAction, initialState);
  const [toastMessage, setToastMessage] = useState("");
  const previousActionStates = useRef({ open: openState, close: closeState, pause: pauseState, resume: resumeState, tally: tallyState, publish: publishState });

  useEffect(() => {
    const currentStates = { open: openState, close: closeState, pause: pauseState, resume: resumeState, tally: tallyState, publish: publishState };
    let latestMessage = "";
    for (const key of Object.keys(currentStates) as Array<keyof typeof currentStates>) {
      const current = currentStates[key];
      if (previousActionStates.current[key] !== current) {
        previousActionStates.current[key] = current;
        if (current.message) latestMessage = current.message;
      }
    }
    if (latestMessage) setToastMessage(latestMessage);
  }, [openState, closeState, pauseState, resumeState, tallyState, publishState]);

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
    <section className="panel lifecycle-panel" id="lifecycle">
      <div className="panel-heading"><div><p className="kicker">ELECTION CONTROL</p><h2>Lifecycle and results</h2></div><span className={`status-pill status-${status}`}>{formatStatusLabel(status)}</span></div>
      <ActionToast message={toastMessage} />

      {votingMode === "public_paid" ? (
        <p className="form-hint">Public paid voting is feature-gated pending legal, provider and operational approval. This election cannot be opened in this mode yet.</p>
      ) : status === "draft" || status === "scheduled" ? (
        canOpen ? (
          <>
          <div className="opening-readiness">
            <h3>Before you open voting</h3>
            <p className="muted">Complete each requirement. Mandate checks them again when you open the election.</p>
            <ul className="readiness-list">
              {openingChecks.map((check) => (
                <li className={`readiness-item${check.complete ? " is-complete" : ""}`} key={check.label}>
                  <span className="readiness-icon" aria-hidden="true">{check.complete ? "✓" : "–"}</span>
                  <span><strong>{check.label}</strong><small>{check.detail}</small></span>
                </li>
              ))}
            </ul>
          </div>
          <form action={openAction} className="form-stack lifecycle-form">
            {hiddenFields}
            <p className="muted">Opening freezes the rules and candidate snapshot. The voter register must be complete and every eligible voter must have an invitation issued.</p>
            {openState.error && <p className="form-error" role="alert">{openState.error}</p>}
            <label className="ballot-confirmation"><input type="checkbox" name="confirmRules" value="true" required /> I have reviewed the election rules, options and eligible voter register.</label>
            <button className="primary-button" disabled={openPending || !openingChecks.every((check) => check.complete)}>{openPending ? "Checking opening requirements…" : openingChecks.every((check) => check.complete) ? "Open election" : "Complete the checklist to open"}</button>
          </form>
          </>
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
            <label className="ballot-confirmation"><input type="checkbox" name="confirmClose" value="true" required /> I understand that closing voting stops further ballot submissions.</label>
            <button className="danger-button" disabled={closePending}>{closePending ? "Closing election…" : "Confirm and close voting"}</button>
          </form>
        ) : <p className="form-hint">A returning officer or election manager must close this election.</p>
      )}

      {status === "closed" && (
        canTally ? (
          <form action={tallyAction} className="form-stack lifecycle-form">
            {hiddenFields}
            <p className="muted">Reconciliation checks ballot records against the separate participation controls and frozen election snapshot. It publishes aggregate counts only.</p>
            {tallyState.error && <p className="form-error" role="alert">{tallyState.error}</p>}
            <button className="primary-button" disabled={tallyPending}>{tallyPending ? "Reconciling ballots…" : "Run tally and reconciliation"}</button>
          </form>
        ) : <p className="form-hint">A returning officer or election manager must run reconciliation.</p>
      )}

      {(status === "tallying" || tallyState.success) && (
        <div className="tally-summary">
          <p className="kicker">RECONCILIATION SUMMARY</p>
          {tallySummary ? (
            <div className="summary-grid">
              <div><span>Eligible voters</span><strong>{tallySummary.eligibleVoters ?? 0}</strong></div>
              <div><span>Participating voters</span><strong>{tallySummary.participatingVoters ?? 0}</strong></div>
              <div><span>Accepted ballots</span><strong>{tallySummary.acceptedBallots ?? 0}</strong></div>
              <div><span>Invalidated ballots</span><strong>{tallySummary.invalidatedBallots ?? 0}</strong></div>
            </div>
          ) : tallyState.counts ? (
            <div className="summary-grid">
              <div><span>Eligible voters</span><strong>{tallyState.counts.eligibleVoters}</strong></div>
              <div><span>Participating voters</span><strong>{tallyState.counts.participatingVoters}</strong></div>
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
              <label className="ballot-confirmation"><input type="checkbox" name="confirmPublish" value="true" required /> I have reviewed the reconciled counts and authorize publication of these results.</label>
              <button className="primary-button" disabled={publishPending}>{publishPending ? "Publishing results…" : "Confirm and publish results"}</button>
            </form>
          ) : <p className="form-hint">An owner, administrator or returning officer must publish results.</p>}
        </div>
      )}

      {status === "results_published" && <p className="form-success" role="status">Results have been published according to the election visibility setting.</p>}
    </section>
  );
}
