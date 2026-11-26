"use client";

import { useState, useTransition } from "react";
import {
  finalizeAndConfirmElectionSetupAction,
  saveElectionSetupDraftAction,
} from "../../actions/elections";

type OptionDraft = { display_name: string; profile: string };
type ContestDraft = {
  title: string; description: string; is_required: boolean;
  tie_policy: "runoff" | "declared_tie" | "external_resolution";
  options: OptionDraft[];
};
type WizardPayload = {
  election: {
    title: string; description: string; voting_mode: "registered_single" | "registered_weighted";
    starts_at: string; ends_at: string; timezone: string;
    result_visibility: "private" | "members" | "public";
  };
  contests: ContestDraft[];
};
type SavedDraft = { id: string; title: string; current_step: number; payload: unknown; updated_at: string };

const emptyPayload = (): WizardPayload => ({
  election: {
    title: "", description: "", voting_mode: "registered_single",
    starts_at: "", ends_at: "", timezone: "Africa/Nairobi", result_visibility: "private",
  },
  contests: [{
    title: "", description: "", is_required: true, tie_policy: "declared_tie",
    options: [{ display_name: "", profile: "" }, { display_name: "", profile: "" }],
  }],
});

function localNairobiValue(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

function isoFromNairobiLocal(value: string): string {
  return value ? new Date(`${value}:00+03:00`).toISOString() : "";
}

function resumePayload(value: unknown): WizardPayload {
  if (!value || typeof value !== "object") return emptyPayload();
  const candidate = value as Partial<WizardPayload>;
  const base = emptyPayload();
  return {
    election: { ...base.election, ...(candidate.election ?? {}) },
    contests: Array.isArray(candidate.contests) && candidate.contests.length
      ? candidate.contests.map((contest) => ({
          ...base.contests[0], ...contest,
          options: Array.isArray(contest.options) && contest.options.length
            ? contest.options.map((option) => ({ ...option }))
            : base.contests[0].options,
        }))
      : base.contests,
  };
}

export function CreateElectionForm({
  organizationId, drafts = [],
}: { organizationId: string; drafts?: SavedDraft[] }) {
  const [payload, setPayload] = useState<WizardPayload>(emptyPayload);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [step, setStep] = useState(1);
  const [authorityConfirmed, setAuthorityConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();

  const save = async (nextStep = step): Promise<string | null> => {
    setError("");
    const result = await saveElectionSetupDraftAction({
      organizationId, draftId, payload: JSON.stringify(payload), currentStep: nextStep,
    });
    if (result.error || !result.draftId) {
      setError(result.error ?? "Draft save failed.");
      return null;
    }
    setDraftId(result.draftId);
    setNotice("Draft saved securely. You can return to it from this organization workspace.");
    return result.draftId;
  };

  const updateElection = (field: keyof WizardPayload["election"], value: string) => {
    setPayload((current) => ({ ...current, election: { ...current.election, [field]: value } }));
  };

  const updateContest = (index: number, field: keyof ContestDraft, value: unknown) => {
    setPayload((current) => ({
      ...current,
      contests: current.contests.map((contest, i) => i === index ? { ...contest, [field]: value } : contest),
    }));
  };

  const updateOption = (contestIndex: number, optionIndex: number, field: keyof OptionDraft, value: string) => {
    setPayload((current) => ({
      ...current,
      contests: current.contests.map((contest, ci) => ci !== contestIndex ? contest : ({
        ...contest,
        options: contest.options.map((option, oi) => oi === optionIndex ? { ...option, [field]: value } : option),
      })),
    }));
  };

  const moveNext = () => startTransition(async () => {
    if (await save(step + 1)) setStep((current) => Math.min(6, current + 1));
  });

  const saveProgress = () => startTransition(async () => { await save(); });

  const finish = () => startTransition(async () => {
    if (!authorityConfirmed) {
      setError("Confirm that you have authority to approve this election setup.");
      return;
    }
    const savedDraftId = await save(6);
    if (!savedDraftId) return;
    const result = await finalizeAndConfirmElectionSetupAction({
      draftId: savedDraftId, authorityConfirmed,
    });
    if (result.error) {
      if (result.electionId) window.location.assign(`/organizations/${organizationId}/elections/${result.electionId}`);
      else setError(result.error);
      return;
    }
    if (result.electionId) window.location.assign(`/organizations/${organizationId}/elections/${result.electionId}`);
  });

  const startNew = () => {
    setPayload(emptyPayload()); setDraftId(null); setStep(1);
    setAuthorityConfirmed(false); setError(""); setNotice("");
  };

  const resume = (draft: SavedDraft) => {
    setPayload(resumePayload(draft.payload)); setDraftId(draft.id);
    setStep(Math.min(6, Math.max(1, draft.current_step)));
    setAuthorityConfirmed(false); setError(""); setNotice("Resumed saved election setup.");
  };

  const election = payload.election;

  return (
    <div className="form-stack election-form">
      {drafts.length > 0 && (
        <section className="form-section">
          <div className="form-section-title">Continue a saved setup</div>
          <div className="organization-list">
            {drafts.map((draft) => (
              <button type="button" className="organization-item" key={draft.id}
                onClick={() => resume(draft)} disabled={pending}>
                <span><strong>{draft.title}</strong><small>Step {draft.current_step} of 6 · Saved {new Date(draft.updated_at).toLocaleString("en-KE")}</small></span>
                <span className="status-pill">Resume</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="form-section-title">Guided election setup · Step {step} of 6</div>
      <div className="form-hint" aria-live="polite">
        {["Identity","Voting mode","Participation rules","Contests and options","Schedule and results","Review and authority"][step - 1]}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="form-hint" role="status">{notice}</p>}

      {step === 1 && <>
        <label>Election name
          <input value={election.title} onChange={(event) => updateElection("title", event.target.value)}
            placeholder="e.g. Annual leadership election" minLength={2} maxLength={160} required />
        </label>
        <label>Description (optional)
          <textarea value={election.description} onChange={(event) => updateElection("description", event.target.value)}
            rows={3} maxLength={5000} placeholder="Purpose and scope of this election" />
        </label>
      </>}

      {step === 2 && <>
        <label>Voting method
          <select value={election.voting_mode} onChange={(event) => updateElection("voting_mode", event.target.value)}>
            <option value="registered_single">One person, one vote</option>
            <option value="registered_weighted">Weighted voting (registered voters)</option>
          </select>
        </label>
        <p className="form-hint">Public paid voting is not available. Only registered-voter elections can be configured.</p>
      </>}

      {step === 3 && <>
        <div className="panel">
          <h3>Participation requirements</h3>
          <p className="muted">This election uses a registered voter roll. Before it can open, the organization must import eligible voters and issue each eligible voter their private access invitation.</p>
          <ul>
            <li>Only eligible, registered voters can participate.</li>
            <li>Contact verification remains required by the current election policy.</li>
            <li>One-vote elections enforce a weight of exactly one per voter.</li>
            <li>Weighted voting is limited to the organization-managed voter register.</li>
          </ul>
        </div>
        <p className="form-hint">These are enforced participation controls, not optional display settings.</p>
      </>}

      {step === 4 && <>
        {payload.contests.map((contest, contestIndex) => (
          <section className="panel form-stack" key={contestIndex}>
            <div className="panel-heading"><h3>Contest {contestIndex + 1}</h3>
              {payload.contests.length > 1 && <button type="button" className="quiet-button"
                onClick={() => setPayload((current) => ({ ...current, contests: current.contests.filter((_, i) => i !== contestIndex) }))}>Remove</button>}
            </div>
            <label>Contest name
              <input value={contest.title} onChange={(event) => updateContest(contestIndex, "title", event.target.value)}
                placeholder="e.g. Chairperson" minLength={2} maxLength={160} />
            </label>
            <label>Description (optional)
              <textarea value={contest.description} onChange={(event) => updateContest(contestIndex, "description", event.target.value)} rows={2} maxLength={5000} />
            </label>
            <label className="checkbox-row"><input type="checkbox" checked={contest.is_required}
              onChange={(event) => updateContest(contestIndex, "is_required", event.target.checked)} /> Voters must make a selection in this contest</label>
            <label>Tie policy
              <select value={contest.tie_policy} onChange={(event) => updateContest(contestIndex, "tie_policy", event.target.value)}>
                <option value="declared_tie">Declare a tie</option>
                <option value="runoff">Runoff election</option>
                <option value="external_resolution">External resolution</option>
              </select>
            </label>
            <div className="form-section-title">Candidates / options</div>
            {contest.options.map((option, optionIndex) => (
              <div className="form-stack" key={optionIndex}>
                <label>Option {optionIndex + 1}
                  <input value={option.display_name} onChange={(event) => updateOption(contestIndex, optionIndex, "display_name", event.target.value)}
                    placeholder="Candidate or option name" maxLength={160} />
                </label>
                <label>Profile (optional)
                  <textarea value={option.profile} onChange={(event) => updateOption(contestIndex, optionIndex, "profile", event.target.value)} rows={2} maxLength={5000} />
                </label>
                {contest.options.length > 2 && <button type="button" className="quiet-button"
                  onClick={() => updateContest(contestIndex, "options", contest.options.filter((_, i) => i !== optionIndex))}>Remove option</button>}
              </div>
            ))}
            <button type="button" className="secondary-button"
              onClick={() => updateContest(contestIndex, "options", [...contest.options, { display_name: "", profile: "" }])}
              disabled={contest.options.length >= 50}>Add option</button>
          </section>
        ))}
        <button type="button" className="secondary-button" onClick={() => setPayload((current) => ({
          ...current, contests: [...current.contests, {
            title: "", description: "", is_required: true, tie_policy: "declared_tie",
            options: [{ display_name: "", profile: "" }, { display_name: "", profile: "" }],
          }],
        }))} disabled={payload.contests.length >= 10}>Add contest</button>
        <p className="form-hint">Each election supports 1–10 contests and 2–50 options per contest.</p>
      </>}

      {step === 5 && <>
        <div className="form-two-column">
          <label>Voting starts (Africa/Nairobi)
            <input type="datetime-local" value={localNairobiValue(election.starts_at)}
              onChange={(event) => updateElection("starts_at", isoFromNairobiLocal(event.target.value))} />
          </label>
          <label>Voting ends (Africa/Nairobi)
            <input type="datetime-local" value={localNairobiValue(election.ends_at)}
              onChange={(event) => updateElection("ends_at", isoFromNairobiLocal(event.target.value))} />
          </label>
        </div>
        <label>Results visibility
          <select value={election.result_visibility} onChange={(event) => updateElection("result_visibility", event.target.value)}>
            <option value="private">Private to election administrators</option>
            <option value="members">Organization members</option>
            <option value="public">Public aggregate results</option>
          </select>
        </label>
        <p className="form-hint">The election timezone is Africa/Nairobi. Start and end times are stored as timezone-aware timestamps.</p>
      </>}

      {step === 6 && <>
        <section className="panel form-stack">
          <h3>{election.title || "Untitled election"}</h3>
          <p className="muted">{election.voting_mode.replaceAll("_", " ")} · {election.result_visibility} results · Africa/Nairobi</p>
          <p>{election.description || "No description supplied."}</p>
          <p>Starts: {election.starts_at ? new Date(election.starts_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" }) : "Not set"}</p>
          <p>Ends: {election.ends_at ? new Date(election.ends_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" }) : "Not set"}</p>
          {payload.contests.map((contest, index) => (
            <div key={index}><strong>{index + 1}. {contest.title || "Untitled contest"}</strong>
              <p className="muted">{contest.is_required ? "Required" : "Optional"} · {contest.tie_policy.replaceAll("_", " ")}</p>
              <ul>{contest.options.map((option, oi) => <li key={oi}>{option.display_name || "Unnamed option"}{option.profile ? ` — ${option.profile}` : ""}</li>)}</ul>
            </div>
          ))}
        </section>
        <label className="checkbox-row">
          <input type="checkbox" checked={authorityConfirmed} onChange={(event) => setAuthorityConfirmed(event.target.checked)} />
          I confirm that I am authorized to approve these election rules, contests, options, and schedule on behalf of this organization.
        </label>
        <p className="form-hint">This confirmation is recorded server-side against a cryptographic hash of the reviewed configuration. Any later configuration change invalidates the confirmation and requires re-approval.</p>
      </>}

      <div className="form-two-column">
        {step > 1 && <button type="button" className="quiet-button" onClick={() => setStep((current) => current - 1)} disabled={pending}>Back</button>}
        {step < 6 ? (
          <button type="button" className="primary-button" onClick={moveNext} disabled={pending}>
            {pending ? "Saving…" : step === 5 ? "Review setup" : "Save and continue"}
          </button>
        ) : (
          <button type="button" className="primary-button" onClick={finish} disabled={pending || !authorityConfirmed}>
            {pending ? "Confirming setup…" : "Confirm authority and create election"}
          </button>
        )}
      </div>
      <button type="button" className="quiet-button" onClick={saveProgress} disabled={pending}>Save progress</button>
      {draftId && <button type="button" className="quiet-button" onClick={startNew} disabled={pending}>Start a separate election</button>}
    </div>
  );
}
