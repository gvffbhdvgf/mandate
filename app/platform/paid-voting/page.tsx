import Link from "next/link";
import { signOutAction } from "../../actions/auth";
import { WorkspaceShell } from "../../components/workspace-shell";

export default function PlatformPaidVotingPage() {
  return (
    <WorkspaceShell section="Platform operations" context="Public paid-voting status" items={[
      { label: "Dashboard", href: "/dashboard" },
      { label: "Paid-voting status", href: "/platform/paid-voting" },
      { label: "Finance", href: "/platform/finance" },
    ]} activeHref="/platform/paid-voting" actions={<form action={signOutAction}><button className="quiet-button">Sign out</button></form>}>
      <main className="dashboard-shell">
        <section className="panel">
          <p className="kicker">ORGANIZATION-CONTROLLED ELECTIONS</p>
          <h1>No platform approval required</h1>
          <p className="muted">An organization's owner, admin or election manager confirms the election setup and opens it directly from the organization workspace. Mandate platform-operator approval is not part of the election lifecycle.</p>
          <p className="muted">The database continues to enforce organization permissions, Kenya jurisdiction scope for public paid organizational elections, owner confirmation, election configuration, schedule, payment verification and ballot integrity.</p>
          <p className="template-link"><Link href="/dashboard">Go to your organizations and elections</Link></p>
        </section>
      </main>
    </WorkspaceShell>
  );
}
