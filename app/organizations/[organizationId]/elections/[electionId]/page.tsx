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
import { PlatformFeeCheckout } from "./platform-fee-checkout";

export default async function ElectionPage({ params, searchParams }: {
  params: Promise<{ organizationId: string; electionId: string }>;
  searchParams: Promise<{ batchId?: string }>;
}) {
  const { organizationId, electionId } = await params;
  const { batchId } = await searchParams;
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
  const canManagePayments = ["owner", "admin", "finance_manager"].includes(role);
  const canViewAudit = canViewRegister || canManagePayments;
  const canOpen = ["owner", "admin", "election_manager"].includes(role);
  const canClose = ["owner", "admin", "election_manager", "returning_officer"].includes(role);
  const canTally = canClose;
  const canPublish = ["owner", "admin", "returning_officer"].includes(role);

  const { data: election, error } = await supabase
    .from("elections")
    .select("id,organization_id,title,description,status,voting_mode,public_slug,currency,price_per_credit_minor,max_credits_per_participant,paid_voting_authorized_at,starts_at,ends_at,timezone,result_visibility,setup_confirmed_at,platform_fee_status,platform_fee_amount_minor,platform_fee_eligible_voter_count,platform_fee_policy_version,platform_fee_quoted_at")
    .eq("id", electionId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !election) notFound();

  const { data: contests } = await supabase
    .from("contests")
    .select("id,title,description,is_required,display_order,tie_policy")
    .eq("election_id", electionId)
    .order("display_order");

  const { count: voterCount, error: voterCountError } = canViewRegister && election.voting_mode !== "public_paid"
    ? await supabase.from("election_voters").select("id", { count: "exact", head: true }).eq("election_id", electionId)
      .eq("eligibility_status", "eligible")
    : { count: null, error: null };
  if (voterCountError) throw new Error("Could not load the voter register count.");

  let platformFeeQuote: {
    eligibleVoterCount: number; amountMinor: number; currency: string; policyVersion: number; status: string;
  } | null = null;
  if (canManagePayments && election.voting_mode !== "public_paid") {
    const { data: quote } = await supabase.rpc("get_platform_fee_quote", { p_election_id: electionId });
    if (quote && typeof quote === "object") {
      const value = quote as Record<string, unknown>;
      const eligibleVoterCount = Number(value.eligibleVoterCount);
      const amountMinor = Number(value.amountMinor);
      const policyVersion = Number(value.policyVersion);
      if (Number.isSafeInteger(eligibleVoterCount) && eligibleVoterCount >= 0
        && Number.isSafeInteger(amountMinor) && amountMinor > 0
        && Number.isSafeInteger(policyVersion) && policyVersion > 0
        && value.currency === "KES" && typeof value.status === "string") {
        platformFeeQuote = { eligibleVoterCount, amountMinor, currency: "KES", policyVersion, status: value.status };
      }
    }
  }

  let importBatch = null;
  if (canViewRegister && election.voting_mode !== "public_paid") {
    let importQuery = supabase.from("import_batches")
      .select("id,status,total_rows,accepted_rows,rejected_rows,created_at,original_filename")
      .eq("election_id", electionId);
    if (batchId && /^[0-9a-f-]{36}$/i.test(batchId)) importQuery = importQuery.eq("id", batchId);
    else importQuery = importQuery.order("created_at", { ascending: false }).limit(1);
    const { data } = await importQuery.maybeSingle();
    importBatch = data;
  }

  let auditTrail = null;
  if (canViewAudit) {
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

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark">M</span><span>mandate</span></Link>
        <div className="nav-actions"><Link href={`/organizations/${organizationId}`}>Organization</Link><form action={signOutAction}><button className="quiet-button">Sign out</button></form></div>
      </header>
      <section className="dashboard-intro">
        <p className="kicker">ELECTION DRAFT</p>
        <h1>{election.title}</h1>
        <p className="muted">{election.description || "No description provided."}</p>
      </section>
      <section className="panel election-summary">
        <div className="panel-heading"><div><p className="kicker">STATUS</p><h2>{election.status}</h2></div><span className="status-pill">{election.voting_mode.replaceAll("_", " ")}</span></div>
        <div className="summary-grid">
          <div><span>Starts</span><strong>{new Date(election.starts_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}</strong></div>
          <div><span>Ends</span><strong>{new Date(election.ends_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}</strong></div>
          <div><span>Timezone</span><strong>{election.timezone}</strong></div>
          <div><span>Results</span><strong>{election.result_visibility}</strong></div>
        </div>
      </section>
      {canOpen && election.status === "draft" && (
        election.voting_mode === "public_paid" && !election.paid_voting_authorized_at ? (
          <section className="panel">
            <p className="kicker">PLATFORM AUTHORIZATION PENDING</p>
            <h2>Public paid voting is configured but not released</h2>
            <p className="muted">The organization can prepare the public election configuration, but Mandate must complete merchant, legal, provider, pricing and accounting approval before setup confirmation and opening are available.</p>
          </section>
        ) : (
          <SetupConfirmation electionId={electionId} confirmed={Boolean(election.setup_confirmed_at)} />
        )
      )}
      {election.voting_mode === "public_paid" && (
        <section className="panel">
          <p className="kicker">PUBLIC PARTICIPANT ACCESS</p>
          <h2>Email-verified voting credits</h2>
          <p className="muted">Participants verify an email address, purchase credits through Paystack, and cast ballots without their contact identity being written to ballot records.</p>
          <div className="summary-grid">
            <div><span>Public link</span><strong>{election.public_slug ? `/public-vote/${election.public_slug}` : "Not configured"}</strong></div>
            <div><span>Credit price</span><strong>{election.currency === "KES" && election.price_per_credit_minor ? `KSh ${(Number(election.price_per_credit_minor)/100).toFixed(2)}` : "Not configured"}</strong></div>
            <div><span>Participant cap</span><strong>{election.max_credits_per_participant ?? "Not configured"}</strong></div>
            <div><span>Platform approval</span><strong>{election.paid_voting_authorized_at ? "Authorized" : "Pending"}</strong></div>
          </div>
        </section>
      )}
      {canManagePayments && platformFeeQuote && ["draft", "scheduled"].includes(election.status) && election.voting_mode !== "public_paid" && (
        <PlatformFeeCheckout
          organizationId={organizationId}
          electionId={electionId}
          quote={platformFeeQuote}
        />
      )}
      {canViewRegister && election.voting_mode !== "public_paid" && (
        <section className="panel voter-register-panel">
          <div className="panel-heading"><div><p className="kicker">ELIGIBLE VOTERS</p><h2>Voter register</h2></div><span className="count">{voterCount ?? 0}</span></div>
          <p className="muted">Upload a private CSV register, validate every row, then commit the eligible voters to this draft election.</p>
          <p className="form-hint">Imported voters are not yet invited. Election opening remains blocked until each eligible voter has a secure access token and invitation record.</p>
          {importBatch && (
            <div className="import-result">
              <div><strong>{importBatch.original_filename}</strong><p className="muted">{importBatch.total_rows} rows · {importBatch.status}</p></div>
              <div className="import-counts"><span>{importBatch.accepted_rows} accepted</span><span>{importBatch.rejected_rows} rejected</span></div>
              {importBatch.status === "validated" && canManageRegister && (
                <CommitImportForm organizationId={organizationId} electionId={electionId} batchId={importBatch.id} />
              )}
              {importBatch.status === "committed" && <p className="form-hint">This import has been committed to the voter register.</p>}
            </div>
          )}
          {canManageRegister && election.status === "draft" && !election.platform_fee_quoted_at && (
            <>
              <p className="template-link"><Link href="/voter-register-template.csv" download>Download CSV template</Link></p>
              <VoterImportForm organizationId={organizationId} electionId={electionId} />
              {(voterCount ?? 0) > 0 && (
                <div className="invitation-section">
                  <div className="form-section-title">Voter invitations</div>
                  {election.platform_fee_status === "paid" ? (
                    <>
                      <p className="form-hint">Invitations are sent privately to registered email addresses. Phone-only voters need a separate delivery channel. The raw access token is never shown in this workspace.</p>
                      <DispatchInvitationsForm organizationId={organizationId} electionId={electionId} />
                    </>
                  ) : (
                    <p className="form-hint">Pay the Mandate platform service fee before voter invitations can be dispatched.</p>
                  )}
                </div>
              )}
              {election.platform_fee_quoted_at && (
                <p className="form-hint">The voter register is frozen against platform-fee policy v{election.platform_fee_policy_version} and the quoted eligible-voter count. To change the register, the invoice must be cancelled through an audited support process.</p>
              )}
            </>
          )}
        </section>
      )}
      {auditTrail?.events && <ElectionAuditTimeline events={auditTrail.events} />}
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
      />
      {publishedResults && (
        <section className="panel results-panel">
          <div className="panel-heading"><div><p className="kicker">PUBLISHED RESULTS</p><h2>Election results</h2></div><span className="status-pill">Published</span></div>
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
                  <div className="result-bar"><span style={{ width: `${option.shareBasisPoints / 100}%` }} /></div>
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
      <section className="panel contest-panel">
        <div className="panel-heading"><div><p className="kicker">BALLOT STRUCTURE</p><h2>Contests and options</h2></div><span className="count">{optionResults.length}</span></div>
        {optionResults.map(({ contest, options }) => (
          <article className="contest-card" key={contest.id}>
            <div><h3>{contest.title}</h3><p className="muted">{contest.is_required ? "Required" : "Optional"} · {contest.tie_policy.replaceAll("_", " ")}</p></div>
            <ul>{options.map((option) => <li key={option.id}><strong>{option.display_name}</strong>{option.profile && <p className="muted">{option.profile}</p>}</li>)}</ul>
          </article>
        ))}
        <p className="form-hint">{election.voting_mode === "public_paid"
          ? "Next: complete platform authorization, review the public price and participant cap, then confirm and open the election. Public paid voting cannot accept purchases or ballots until all release gates are satisfied."
          : "Next: complete the voter register, review the election rules, and verify the opening checklist. This draft cannot accept votes yet."}</p>
      </section>
    </main>
  );
}
