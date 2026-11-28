import { redirect } from "next/navigation";
import { signOutAction } from "../../actions/auth";
import {
  authorizePublicPaidElectionAction,
  bootstrapPlatformOperatorAction,
  recordPlatformPaidVotingRequirementAction,
} from "../../actions/platform";
import { WorkspaceShell } from "../../components/workspace-shell";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

type Requirement = {
  key: string;
  title: string;
  description: string;
  status: "pending" | "approved" | "rejected";
  evidence?: string | null;
  evidenceReference?: string | null;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  validUntil?: string | null;
};

type PaidElection = {
  id: string;
  title: string;
  organization: string;
  countryCode: string;
  status: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  currency: string;
  pricePerCreditMinor: number | null;
  maxCreditsPerParticipant: number | null;
  authorized: boolean;
};

const errors: Record<string, string> = {
  bootstrap: "Your account could not be registered as the initial platform operator. Check that you are signed in with the designated Mandate owner account.",
  invalid: "The review form contains invalid information.",
  "invalid-date": "Enter a valid approval expiry date.",
  evidence: "Approval requires a meaningful evidence note (at least 40 characters) and a source reference.",
  forbidden: "This action requires an active Mandate platform-operator account.",
  save: "The review could not be saved. Check the details and try again.",
  scope: "Confirm that this election is within the approved use-case scope before authorizing it.",
  requirements: "The platform release checklist is not fully approved or an approval has expired.",
  jurisdiction: "This election's jurisdiction is not included in the current release scope.",
  configuration: "The election needs a valid KES price, participant cap, verified-contact setting and future schedule.",
  authorize: "This election could not be authorized. Verify its configuration and platform release status.",
};

export default async function PlatformPaidVotingPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");
  const { data, error } = await supabase.rpc("get_platform_paid_voting_status");
  if (error || !data) {
    return <WorkspaceShell section="Platform operations" items={[{label:"Dashboard",href:"/dashboard"}]} actions={<form action={signOutAction}><button className="quiet-button">Sign out</button></form>}>
      <main className="dashboard-shell"><section className="panel"><h1>Platform release review unavailable</h1><p className="form-error">The release status could not be loaded. Please refresh or contact platform support.</p></section></main>
    </WorkspaceShell>;
  }

  const status = data as {
    isOperator: boolean;
    canBootstrap: boolean;
    releaseReady: boolean;
    requirements: Requirement[];
    elections: PaidElection[];
    audit: { eventType: string; requirementKey?: string | null; electionId?: string | null; actor?: string | null; beforeState?: unknown; afterState: unknown; createdAt: string }[];
  };
  const message = typeof params.error === "string" ? errors[params.error] : undefined;
  const success = typeof params.bootstrapped === "string" ? "Your platform-operator access is active. Release requirements remain pending until reviewed with evidence."
    : typeof params.updated === "string" ? "The release review was saved and added to the audit history."
    : typeof params.authorized === "string" ? "Platform authorization was recorded for the selected election. The organization must still confirm its setup and open it within its scheduled window."
    : undefined;

  return (
    <WorkspaceShell section="Platform operations" context="Public paid-voting release" items={[
      {label:"Dashboard",href:"/dashboard"},
      {label:"Paid-voting release",href:"/platform/paid-voting"},
    ]} activeHref="/platform/paid-voting" actions={<form action={signOutAction}><button className="quiet-button">Sign out</button></form>}>
      <main className="dashboard-shell">
        <section className="dashboard-intro">
          <p className="kicker">MANDATE PLATFORM OPERATIONS</p>
          <h1>Public paid-voting release</h1>
          <p className="muted">Review the merchant, provider, legal, pricing, accounting and security controls before authorizing public paid elections.</p>
        </section>
        {message && <section className="panel"><p className="form-error" role="alert">{message}</p></section>}
        {success && <section className="panel"><p className="form-success" role="status">{success}</p></section>}
        {!status.isOperator && status.canBootstrap ? (
          <section className="panel form-stack">
            <p className="kicker">INITIAL OPERATOR SETUP</p>
            <h2>Register the designated Mandate owner</h2>
            <p className="muted">This one-time action is restricted to the pre-authorized, email-confirmed Mandate owner account. It does not approve any release requirement or enable paid voting by itself.</p>
            <form action={bootstrapPlatformOperatorAction}>
              <button className="primary-button">Activate my platform-operator access</button>
            </form>
          </section>
        ) : !status.isOperator ? (
          <section className="panel">
            <p className="kicker">RESTRICTED AREA</p>
            <h2>Platform-operator access required</h2>
            <p className="muted">This area is separate from organization ownership. Ask an existing platform operator to grant access.</p>
          </section>
        ) : (
          <>
            <section className="panel">
              <div className="panel-heading">
                <div><p className="kicker">GLOBAL RELEASE STATUS</p><h2>{status.releaseReady ? "Release requirements satisfied" : "Release is not yet ready"}</h2></div>
                <span className="status-pill">{status.requirements.filter((r) => r.status === "approved" && (!r.validUntil || new Date(r.validUntil).getTime() > Date.now())).length}/{status.requirements.length} approved</span>
              </div>
              <p className="muted">Every approval must include a written evidence note and source reference. Expired approvals stop new setup confirmations and election openings.</p>
            </section>
            {status.requirements.map((requirement) => (
              <section className="panel form-stack" key={requirement.key}>
                <div className="panel-heading">
                  <div><p className="kicker">RELEASE REQUIREMENT</p><h2>{requirement.title}</h2></div>
                  <span className={`status-pill ${requirement.status === "approved" ? "status-success" : requirement.status === "rejected" ? "status-danger" : ""}`}>{requirement.status}</span>
                </div>
                <p className="muted">{requirement.description}</p>
                {requirement.reviewedAt && <p className="form-hint">Reviewed {new Date(requirement.reviewedAt).toLocaleString("en-KE", {timeZone:"Africa/Nairobi"})} by {requirement.reviewedBy || "platform operator"}{requirement.validUntil ? ` · Valid until ${new Date(requirement.validUntil).toLocaleDateString("en-KE", {timeZone:"Africa/Nairobi"})}` : ""}</p>}
                {requirement.evidence && <p className="form-hint">Previous evidence: {requirement.evidence}</p>}
                {requirement.evidenceReference && <p className="form-hint">Source: <a href={requirement.evidenceReference} target="_blank" rel="noreferrer">{requirement.evidenceReference}</a></p>}
                <form action={recordPlatformPaidVotingRequirementAction} className="form-stack">
                  <input type="hidden" name="requirementKey" value={requirement.key} />
                  <label>Decision
                    <select name="status" defaultValue={requirement.status}>
                      <option value="pending">Pending</option>
                      <option value="approved">Approve with evidence</option>
                      <option value="rejected">Reject</option>
                    </select>
                  </label>
                  <label>Evidence / decision rationale
                    <textarea name="evidence" rows={3} maxLength={4000} defaultValue={requirement.evidence || ""} placeholder="Record what was verified, the scope reviewed and the outcome." />
                  </label>
                  <label>Evidence source reference
                    <input name="evidenceReference" maxLength={1000} defaultValue={requirement.evidenceReference || ""} placeholder="Provider email, contract, policy document or test report URL" />
                  </label>
                  <label>Approval expiry (optional)
                    <input name="validUntil" type="date" defaultValue={requirement.validUntil ? requirement.validUntil.slice(0,10) : ""} />
                  </label>
                  <button className="secondary-button">Save review and audit decision</button>
                </form>
              </section>
            ))}
            <section className="panel">
              <p className="kicker">ELECTION AUTHORIZATION</p>
              <h2>Authorize an individual election</h2>
              <p className="muted">Only Kenya-based public-paid drafts are currently in scope. This action records a platform decision; it does not confirm the organizer's setup or open voting.</p>
              {status.elections.length === 0 ? <p className="form-hint">There are no public-paid election drafts awaiting authorization.</p> : status.elections.map((election) => (
                <article className="contest-card" key={election.id}>
                  <div><h3>{election.title}</h3><p className="muted">{election.organization} · {election.countryCode} · {election.status}</p>
                    <p className="form-hint">{election.pricePerCreditMinor !== null ? `KSh ${(election.pricePerCreditMinor/100).toFixed(2)} per credit` : "Price not configured"} · cap {election.maxCreditsPerParticipant ?? "not configured"} · {new Date(election.startsAt).toLocaleString("en-KE", {timeZone:election.timezone || "Africa/Nairobi"})} – {new Date(election.endsAt).toLocaleString("en-KE", {timeZone:election.timezone || "Africa/Nairobi"})} ({election.timezone || "Africa/Nairobi"})</p>
                    <p className="form-hint">{election.authorized ? "Previously authorized; current global release gates are still rechecked at setup confirmation and opening." : "Platform authorization pending."}</p>
                  </div>
                  {!election.authorized && (
                    <form action={authorizePublicPaidElectionAction} className="form-stack">
                      <input type="hidden" name="electionId" value={election.id} />
                      <label className="ballot-confirmation"><input type="checkbox" name="scopeAcknowledged" value="true" required /> I confirm this is a private organizational election in Kenya and is within the reviewed merchant, legal and provider scope. It is not a statutory/public election or an unreviewed political-party/non-profit use case.</label>
                      <button className="primary-button" disabled={!status.releaseReady}>Authorize this election</button>
                    </form>
                  )}
                </article>
              ))}
            </section>
            <section className="panel">
              <p className="kicker">AUDIT HISTORY</p>
              <h2>Platform release decisions</h2>
              {status.audit.length === 0 ? <p className="form-hint">No platform release decisions have been recorded yet.</p> : (
                <ol className="readiness-list">
                  {status.audit.map((entry, index) => (
                    <li className="readiness-item" key={`${entry.createdAt}-${index}`}>
                      <span className="readiness-icon is-complete" aria-hidden="true">✓</span>
                      <div><strong>{entry.eventType.replaceAll("_", " ")}{entry.requirementKey ? ` · ${entry.requirementKey}` : ""}</strong>
                        <small>{entry.actor || "Platform operator"} · {new Date(entry.createdAt).toLocaleString("en-KE", {timeZone:"Africa/Nairobi"})}</small>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </main>
    </WorkspaceShell>
  );
}
