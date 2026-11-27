import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { signOutAction } from "../../actions/auth";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { CreateElectionForm } from "./create-election-form";
import { OrganizationMembersPanel } from "./members-panel";

export default async function OrganizationPage({ params, searchParams }: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ memberNotice?: string; memberError?: string }>;
}) {
  const { organizationId } = await params;
  const feedback = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  const { data: organization, error: organizationError } = await supabase
    .from("organizations")
    .select("id,name,slug,status")
    .eq("id", organizationId)
    .maybeSingle();

  if (organizationError || !organization) notFound();

  const { data: membership } = await supabase
    .from("organization_members")
    .select("role,status")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();
  const canManageMembers = membership?.status === "active" && ["owner", "admin"].includes(membership.role);
  const canManageElections = membership?.status === "active" && ["owner", "admin", "election_manager"].includes(membership.role);
  let setupDrafts: any[] = [];
  if (canManageElections) {
    const { data: draftRows, error: draftsError } = await supabase.rpc("list_election_setup_drafts", {
      p_organization_id: organizationId,
    });
    if (draftsError) throw new Error("Could not load saved election setup drafts.");
    setupDrafts = draftRows ?? [];
  }
  let members: any[] = [];
  let pendingInvitations: any[] = [];
  if (canManageMembers) {
    const [memberResult, invitationResult] = await Promise.all([
      supabase.rpc("get_organization_members", { p_organization_id: organizationId }),
      supabase.from("organization_invitations")
        .select("id,email,role,expires_at,created_at")
        .eq("organization_id", organizationId)
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
    ]);
    if (memberResult.error || invitationResult.error) throw new Error("Could not load organization membership.");
    members = memberResult.data ?? [];
    pendingInvitations = invitationResult.data ?? [];
  }

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
      {canManageMembers && (
        <OrganizationMembersPanel
          organizationId={organizationId}
          members={members}
          invitations={pendingInvitations}
          actorRole={membership.role}
          memberNotice={feedback.memberNotice}
          memberError={feedback.memberError}
        />
      )}
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
        {canManageElections && <div className="panel create-panel">
          <p className="kicker">GUIDED SETUP</p><h2>Create an election</h2>
          <p className="muted">A six-step, resumable setup. Drafts are saved to the server; the election stays closed until its rules are reviewed and the voter register is ready.</p>
          <CreateElectionForm organizationId={organizationId} drafts={setupDrafts} />
        </div>}
      </section>
    </main>
  );
}
