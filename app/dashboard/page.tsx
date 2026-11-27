import Link from "next/link";
import { redirect } from "next/navigation";
import { signOutAction } from "../actions/auth";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import { CreateOrganizationForm } from "./create-organization-form";
import { WorkspaceShell } from "../components/workspace-shell";
import { formatStatusLabel } from "../../lib/ui/presentation";

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  const { data: organizationRows, error } = await supabase
    .from("organizations")
    .select("id,name,slug,status,created_at")
    .order("created_at", { ascending: false });

  if (error) throw new Error("Could not load your organizations.");
  const organizations = organizationRows ?? [];

  return (
    <WorkspaceShell
      section="Dashboard"
      items={[{ label: "Dashboard", href: "/dashboard" }]}
      activeHref="/dashboard"
      actions={<form action={signOutAction}><button className="quiet-button">Sign out</button></form>}
    >
    <main className="dashboard-shell">
      <section className="dashboard-intro">
        <p className="kicker">YOUR WORKSPACE</p>
        <h1>Good to see you.</h1>
        <p className="muted">{user.email}</p>
      </section>
      <section className="dashboard-grid">
        <div className="panel">
          <div className="panel-heading"><div><p className="kicker">ORGANIZATIONS</p><h2>Your organizations</h2></div><span className="count">{organizations.length}</span></div>
          {organizations.length === 0 ? (
            <div className="empty-state"><h3>Start with your organization</h3><p className="muted">Create a workspace before setting up your first election.</p></div>
          ) : (
            <div className="organization-list">
              {organizations.map((organization) => (
                <Link className="organization-item" href={`/organizations/${organization.id}`} key={organization.id}>
                  <div><h3>{organization.name}</h3><p className="muted">/{organization.slug}</p></div>
                  <span className={`status-pill status-${organization.status}`}>{formatStatusLabel(organization.status)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="panel create-panel">
          <p className="kicker">FIRST STEP</p><h2>Create an organization</h2>
          <p className="muted">Set up the workspace where your election team will manage members, candidates and voting.</p>
          <CreateOrganizationForm />
        </div>
      </section>
    </main>
    </WorkspaceShell>
  );
}
