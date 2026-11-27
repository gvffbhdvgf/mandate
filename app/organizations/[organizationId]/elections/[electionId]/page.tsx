import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { signOutAction } from "../../../../actions/auth";
import { createSupabaseServerClient } from "../../../../../lib/supabase/server";
import { VoterImportForm } from "./voter-import-form";
import { CommitImportForm } from "./commit-import-form";
import { DispatchInvitationsForm } from "./dispatch-invitations-form";
import { ElectionLifecycleControls } from "./lifecycle-controls";
import { ElectionAuditTimeline } from "./audit-timeline";
import { SetupConfirmation } from "./setup-confirmation";
import { WorkspaceShell } from "../../../../components/workspace-shell";
import { formatDateTime, formatResultVisibility, formatStatusLabel, formatTiePolicy, formatVotingMode } from "../../../../../lib/ui/presentation";
import { buildElectionOpeningChecks } from "../../../../../lib/ui/election-readiness";
import { ActionToast } from "../../../../components/action-toast";

export default async function ElectionPage({ params, searchParams }: {
  params: Promise<{ organizationId: string; electionId: string }>;
  searchParams: Promise<{ batchId?: string; validated?: string; imported?: string }>;
}) {
  const { organizationId, electionId } = await params;
  const { batchId, validated, imported } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  const { data: membership } = await supabase
    .from("organization_members")
    .select("role,status")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();
  const role = membership?.status === "active" ? membership.role : "viewer";
  const canManageRegister = ["owner", "admin", "election_manager"].includes(role);
  const canViewRegister = ["owner", "admin", "election_manager", "returning_officer"].includes(role);
  const canOpen = ["owner", "admin", "election_manager"].includes(role);
  const canClose = ["owner", "admin", "election_manager", "returning_officer"].includes(role);
  const canTally = canClose;
  const canPublish = ["owner", "admin", "returning_officer"].includes(role);

  const { data: election, error } = await supabase
    .from("elections")
    .select("id,organization_id,title,description,status,voting_mode,starts_at,ends_at,timezone,result_visibility,setup_confirmed_at")
    .eq("id", electionId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !election) notFound();

  const { data: contests } = await supabase
    .from("contests")
    .select("id,title,description,is_required,display_order,tie_policy")
    .eq("election_id", electionId)
    .order("display_order");

  const [voterCountResult, invitedVoterCountResult] = canViewRegister
    ? await Promise.all([
        supabase.from("election_voters").select("id", { count: "exact", head: true })
          .eq("election_id", electionId).eq("eligibility_status", "eligible"),
        supabase.from("election_voters").select("id", { count: "exact", head: true })
          .eq("election_id", electionId).eq("eligibility_status", "eligible")
          .not("access_token_hash", "is", null).not("invited_at", "is", null),
      ])
    : [{ count: null, error: null }, { count: null, error: null }];
  const voterCount = voterCountResult.count;
  const invitedVoterCount = invitedVoterCountResult.count;
  if (voterCountResult.error || invitedVoterCountResult.error) throw new Error("Could not load the voter register readiness.");

  let importBatch = null;
  if (canViewRegister) {
    let importQuery = supabase.from("import_batches")
      .select("id,status,total_rows,accepted_rows,rejected_rows,created_at,original_filename")
      .eq("election_id", electionId);
    if (batchId && /^[0-9a-f-]{36}$/i.test(batchId)) importQuery = importQuery.eq("id", batchId);
    else importQuery = importQuery.order("created_at", { ascending: false }).limit(1);
    const { data } = await importQuery.maybeSingle();
    importBatch = data;
  }

  let auditTrail = null;
  if (canViewRegister) {
    const { data } = await supabase.rpc("get_election_audit_trail", { p_election_id: electionId, p_limit: 50 });
    auditTrail = data;
  }

  let tallySummary = null;
  if (election.status === "tallying") {
    const { data } = await supabase.rpc("get_tally_summary", { p_election_id: electionId });
    tallySummary = data;
  }
  let publishedResults = null;
  if (election.status === "results_published") {
    const { data } = await supabase.rpc("get_published_results", { p_election_id: electionId });
    publishedResults = data;
  }

  const contestRows = contests ?? [];
  const optionResults = await Promise.all(contestRows.map(async (contest) => {
    const { data } = await supabase.from("options")
      .select("id,display_name,profile,display_order,status")
      .eq("contest_id", contest.id)
      .order("display_order");
    return { contest, options: data ?? [] };
  }));

  const openingChecks = buildElectionOpeningChecks({
    setupConfirmed: Boolean(election.setup_confirmed_at),
    eligibleVoterCount: voterCount ?? 0,
    invitedVoterCount: invitedVoterCount ?? 0,
    activeOptionCounts: optionResults.map(({ options }) => options.filter((option) => option.status === "active").length),
    startsAt: election.starts_at,
    endsAt: election.ends_at,
    timezone: election.timezone,
  });
  const nextOpeningStep = openingChecks.find((check) => !check.complete);

  return (
    <WorkspaceShell
      section="Election workspace"
      context={election.title}
      items={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Organization", href: `/organizations/${organizationId}` },
        { label: "Overview", href: `/organizations/${organizationId}/elections/${electionId}` },
        ...(canViewRegister ? [{ label: "Voter register", href: `/organizations/${organizationId}/elections/${electionId}#voter-register` }] : []),
        { label: "Lifecycle", href: `/organizations/${organizationId}/elections/${electionId}#lifecycle` },
        { label: "Contests", href: `/organizations/${organizationId}/elections/${electionId}#contests` },
        ...(publishedResults ? [{ label: "Results", href: `/organizations/${organizationId}/elections/${electionId}#results` }] : []),
        ...(auditTrail?.events?.length ? [{ label: "Activity", href: `/organizations/${organizationId}/elections/${electionId}#activity` }] : []),
      ]}
      activeHref={`/organizations/${organizationId}/elections/${electionId}`}
      actions={<form action={signOutAction}><button className="quiet-button">Sign out</button></form>}
    >
    <main className="dashboard-shell">
      <ActionToast message={imported === "1" ? "Voter register updated successfully. The committed count is now reflected below." : validated === "1" ? "CSV validation complete. Review the accepted count and confirm before adding voters." : undefined} />
      <section className="dashboard-intro">
        <p className="kicker">ELECTION OVERVIEW</p>
        <h1>{election.title}</h1>
        <p className="muted">{election.description || "No description provided."}</p>
      </section>
      <section className="panel election-summary" id="election-overview">
        <div className="panel-heading">
          <div><p className="kicker">CURRENT STATE</p><h2>Election overview</h2></div>
          <div className="election-badges">
            <span className={`status-pill status-${election.status}`}>{formatStatusLabel(election.status)}</span>
            <span className="mode-pill">{formatVotingMode(election.voting_mode)}</span>
          </div>
        </div>
        <div className="summary-grid">
          <div><span>Starts</span><strong><time dateTime={election.starts_at}>{formatDateTime(election.starts_at, election.timezone)}</time></strong></div>
          <div><span>Ends</span><strong><time dateTime={election.ends_at}>{formatDateTime(election.ends_at, election.timezone)}</time></strong></div>
          <div><span>Timezone</span><strong>{election.timezone}</strong></div>
          <div><span>Results visibility</span><strong>{formatResultVisibility(election.result_visibility)}</strong></div>
        </div>
      </section>
      {canOpen && election.status === "draft" && (
        <SetupConfirmation electionId={electionId} confirmed={Boolean(election.setup_confirmed_at)} />
      )}
      {canViewRegister && (
        <section className="panel voter-register-panel" id="voter-register">
          <div className="panel-heading"><div><p className="kicker">ELIGIBLE VOTERS</p><h2>Voter register</h2></div><span className="count">{voterCount ?? 0}</span></div>
          <p className="muted">Upload a private CSV register, validate every row, then commit the eligible voters to this draft election.</p>
          <p className="form-hint">Imported voters are not yet invited. Election opening remains blocked until each eligible voter has a secure access token and invitation record.</p>
          {importBatch && (
            <div className="import-result">
              <div><strong>{importBatch.original_filename}</strong><p className="muted">{importBatch.total_rows.toLocaleString("en-KE")} rows · {importBatch.status === "validated" ? "Validation complete" : importBatch.status === "committed" ? "Added to register" : "Import needs attention"}</p></div>
              <div className="import-counts"><span>{importBatch.accepted_rows.toLocaleString("en-KE")} ready to add</span><span>{importBatch.rejected_rows.toLocaleString("en-KE")} rejected</span></div>
              {importBatch.status === "validated" && canManageRegister && (
                <CommitImportForm organizationId={organizationId} electionId={electionId} batchId={importBatch.id} />
              )}
              {importBatch.status === "committed" && <p className="form-hint">This import has been committed to the voter register.</p>}
            </div>
          )}
          {canManageRegister && election.status === "draft" && (
            <>
              <div className="template-card">
                <div>
                  <h3>Start with the voter register template</h3>
                  <p>Required: voter_ref and name. Add an email or E.164 phone number for each voter. Optional: weight (defaults to 1).</p>
                  <p>Email is currently the supported invitation channel. Phone-only voters can be registered, but cannot receive an invitation until another delivery channel is enabled.</p>
                  <p>CSV only · up to 10 MB · maximum 25,000 voters · voter references must be unique.</p>
                </div>
                <Link className="secondary-button" href="/voter-register-template.csv" download>Download CSV template</Link>
              </div>
              <VoterImportForm organizationId={organizationId} electionId={electionId} votingMode={election.voting_mode} />
              {(voterCount ?? 0) > 0 && (
                <div className="invitation-section">
                  <div className="form-section-title">Voter invitations</div>
                  <p className="form-hint">Invitations are sent privately to registered email addresses. Phone-only voters need a separate delivery channel. The raw access token is never shown in this workspace.</p>
                  <DispatchInvitationsForm organizationId={organizationId} electionId={electionId} />
                </div>
              )}
            </>
          )}
        </section>
      )}
      <ElectionLifecycleControls
        organizationId={organizationId}
        electionId={electionId}
        status={election.status}
        votingMode={election.voting_mode}
        canOpen={canOpen}
        canClose={canClose}
        canTally={canTally}
        canPublish={canPublish}
        tallySummary={tallySummary}
        openingChecks={openingChecks}
      />
      {publishedResults && (
        <section className="panel results-panel" id="results">
          <div className="panel-heading"><div><p className="kicker">PUBLISHED RESULTS</p><h2>Election results</h2></div><span className="status-pill status-published">Published</span></div>
          <div className="summary-grid">
            <div><span>Eligible voters</span><strong>{publishedResults.tally.eligibleVoters}</strong></div>
            <div><span>Participating voters</span><strong>{publishedResults.tally.participatingVoters}</strong></div>
            <div><span>Accepted ballots</span><strong>{publishedResults.tally.acceptedBallots}</strong></div>
            <div><span>Turnout</span><strong>{(publishedResults.tally.turnoutBasisPoints / 100).toFixed(1)}%</strong></div>
          </div>
          {publishedResults.contests.map((contest: any) => (
            <article className="result-contest" key={contest.id}>
              <h3>{contest.title}</h3>
              {contest.options.map((option: any) => (
                <div className="result-option" key={option.id}>
                  <div className="result-option-label"><span>{option.name}</span><strong>{option.voteUnits} votes · {(option.shareBasisPoints / 100).toFixed(1)}%</strong></div>
                  <div className="result-bar" role="progressbar" aria-label={`${option.name} share of votes`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={option.shareBasisPoints / 100}><span style={{ width: `${option.shareBasisPoints / 100}%` }} /></div>
                  {option.isWinner && <span className="winner-label">Winner</span>}
                  {option.isTied && <span className="muted">Tied</span>}
                </div>
              ))}
            </article>
          ))}
          {election.result_visibility === "public" && <p className="template-link"><Link href={`/results/${electionId}`}>Open public results page</Link></p>}
          {canPublish && election.status === "results_published" && (
            <p className="template-link">
              Download report: <Link href={"/organizations/" + organizationId + "/elections/" + electionId + "/report?format=csv"}>CSV</Link>
              {" · "}<Link href={"/organizations/" + organizationId + "/elections/" + electionId + "/report?format=pdf"}>PDF</Link>
            </p>
          )}
        </section>
      )}
      <section className="panel contest-panel" id="contests">
        <div className="panel-heading"><div><p className="kicker">BALLOT STRUCTURE</p><h2>Contests and options</h2></div><span className="count">{optionResults.length}</span></div>
        {optionResults.map(({ contest, options }) => (
          <article className="contest-card" key={contest.id}>
            <div><h3>{contest.title}</h3><p className="muted">{contest.is_required ? "Required" : "Optional"} · {formatTiePolicy(contest.tie_policy)}</p></div>
            <ul>{options.map((option) => (
              <li key={option.id}>
                <div className="contest-option-heading">
                  <strong>{option.display_name}</strong>
                  {option.status !== "active" && <span className={`status-pill status-${option.status}`}>{formatStatusLabel(option.status)}</span>}
                </div>
                {option.profile && <p className="muted">{option.profile}</p>}
              </li>
            ))}</ul>
          </article>
        ))}
        <div className="next-step-panel">
          <span className="kicker">NEXT STEP</span>
          {!canOpen ? <><strong>Coordinate with an election manager</strong><p>An authorized election manager or administrator must review readiness and open voting.</p></> : nextOpeningStep ? <><strong>{nextOpeningStep.label}</strong><p>{nextOpeningStep.detail}</p></> : <><strong>Opening requirements are complete</strong><p>An authorized election manager can now open voting. The server will verify every requirement again.</p></>}
        </div>
      </section>
      {auditTrail?.events && <ElectionAuditTimeline events={auditTrail.events} />}
    </main>
    </WorkspaceShell>
  );
}
