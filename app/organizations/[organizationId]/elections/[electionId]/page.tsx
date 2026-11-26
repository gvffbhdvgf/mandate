import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { signOutAction } from "../../../../actions/auth";
import { createSupabaseServerClient } from "../../../../../lib/supabase/server";
import { VoterImportForm } from "./voter-import-form";
import { CommitImportForm } from "./commit-import-form";

export default async function ElectionPage({ params, searchParams }: {
  params: Promise<{ organizationId: string; electionId: string }>;
  searchParams: Promise<{ batchId?: string }>;
}) {
  const { organizationId, electionId } = await params;
  const { batchId } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  const { data: election, error } = await supabase
    .from("elections")
    .select("id,organization_id,title,description,status,voting_mode,starts_at,ends_at,timezone,result_visibility")
    .eq("id", electionId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !election) notFound();

  const { data: contests } = await supabase
    .from("contests")
    .select("id,title,description,is_required,display_order,tie_policy")
    .eq("election_id", electionId)
    .order("display_order");

  const { count: voterCount, error: voterCountError } = await supabase
    .from("election_voters")
    .select("id", { count: "exact", head: true })
    .eq("election_id", electionId);
  if (voterCountError) throw new Error("Could not load the voter register count.");

  let importQuery = supabase.from("import_batches")
    .select("id,status,total_rows,accepted_rows,rejected_rows,created_at,original_filename")
    .eq("election_id", electionId);
  if (batchId && /^[0-9a-f-]{36}$/i.test(batchId)) {
    importQuery = importQuery.eq("id", batchId);
  } else {
    importQuery = importQuery.order("created_at", { ascending: false }).limit(1);
  }
  const { data: importBatch } = await importQuery.maybeSingle();

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
      <section className="panel voter-register-panel">
        <div className="panel-heading"><div><p className="kicker">ELIGIBLE VOTERS</p><h2>Voter register</h2></div><span className="count">{voterCount ?? 0}</span></div>
        <p className="muted">Upload a private CSV register, validate every row, then commit the eligible voters to this draft election.</p>
        {importBatch && (
          <div className="import-result">
            <div><strong>{importBatch.original_filename}</strong><p className="muted">{importBatch.total_rows} rows · {importBatch.status}</p></div>
            <div className="import-counts"><span>{importBatch.accepted_rows} accepted</span><span>{importBatch.rejected_rows} rejected</span></div>
            {importBatch.status === "validated" && (
              <CommitImportForm organizationId={organizationId} electionId={electionId} batchId={importBatch.id} />
            )}
            {importBatch.status === "committed" && <p className="form-hint">This import has been committed to the voter register.</p>}
          </div>
        )}
        {election.status === "draft" && (
          <>
            <p className="template-link"><Link href="/voter-register-template.csv" download>Download CSV template</Link></p>
            <VoterImportForm organizationId={organizationId} electionId={electionId} />
          </>
        )}
      </section>
      <section className="panel contest-panel">
        <div className="panel-heading"><div><p className="kicker">BALLOT STRUCTURE</p><h2>Contests and options</h2></div><span className="count">{optionResults.length}</span></div>
        {optionResults.map(({ contest, options }) => (
          <article className="contest-card" key={contest.id}>
            <div><h3>{contest.title}</h3><p className="muted">{contest.is_required ? "Required" : "Optional"} · {contest.tie_policy.replaceAll("_", " ")}</p></div>
            <ul>{options.map((option) => <li key={option.id}>{option.display_name}</li>)}</ul>
          </article>
        ))}
        <p className="form-hint">Next: complete the voter register, review the election rules, and verify the opening checklist. This draft cannot accept votes yet.</p>
      </section>
    </main>
  );
}
