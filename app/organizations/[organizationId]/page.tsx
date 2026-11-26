import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { signOutAction } from "../../actions/auth";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { CreateElectionForm } from "./create-election-form";

export default async function OrganizationPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  const { data: organization, error: organizationError } = await supabase
    .from("organizations")
    .select("id,name,slug,status")
    .eq("id", organizationId)
    .maybeSingle();

  if (organizationError || !organization) notFound();

  const { data: electionRows, error: electionsError } = await supabase
    .from("elections")
    .select("id,title,status,voting_mode,starts_at,ends_at,created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (electionsError) throw new Error("Could not load elections.");
  const elections = electionRows ?? [];

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <Link className="brand" href="/"><span className="brand-mark">M</span><span>mandate</span></Link>
        <div className="nav-actions"><Link href="/dashboard">All organizations</Link><form action={signOutAction}><button className="quiet-button">Sign out</button></form></div>
      </header>
      <section className="dashboard-intro">
        <p className="kicker">ORGANIZATION WORKSPACE</p>
        <h1>{organization.name}</h1>
        <p className="muted">/{organization.slug} · {organization.status}</p>
      </section>
      <section className="dashboard-grid organization-workspace-grid">
        <div className="panel">
          <div className="panel-heading"><div><p className="kicker">ELECTIONS</p><h2>Election workspace</h2></div><span className="count">{elections.length}</span></div>
          {elections.length === 0 ? (
            <div className="empty-state"><h3>No elections yet</h3><p className="muted">Create your first election draft. You can review the rules and voter register before opening it.</p></div>
          ) : (
            <div className="organization-list">
              {elections.map((election) => (
                <Link className="organization-item election-item" href={`/organizations/${organizationId}/elections/${election.id}`} key={election.id}>
                  <div><h3>{election.title}</h3><p className="muted">{election.voting_mode.replaceAll("_", " ")} · {new Date(election.starts_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}</p></div>
                  <span className="status-pill">{election.status}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="panel create-panel">
          <p className="kicker">GUIDED SETUP</p><h2>Create an election</h2>
          <p className="muted">Start with the voting method, dates and first contest. The draft stays closed until the voter register and rules are ready.</p>
          <CreateElectionForm organizationId={organizationId} />
        </div>
      </section>
    </main>
  );
}
