import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { signOutAction } from "../../../../actions/auth";
import { createSupabaseServerClient } from "../../../../../lib/supabase/server";

export default async function ElectionPage({ params }: { params: Promise<{ organizationId: string; electionId: string }> }) {
  const { organizationId, electionId } = await params;
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
