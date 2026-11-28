import { redirect } from "next/navigation";
import { signOutAction } from "../../actions/auth";
import { WorkspaceShell } from "../../components/workspace-shell";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

type AccountBalance = {
  ownerType: string;
  organizationId: string | null;
  organizationName: string | null;
  accountCode: string;
  currency: string;
  balanceMinor: number;
};

type OrganizationPayable = {
  organizationId: string;
  organizationName: string;
  balanceMinor: number;
};

type PlatformPayout = {
  id: string;
  organizationId: string;
  organizationName: string;
  amountMinor: number;
  currency: string;
  status: string;
  reference: string | null;
  providerStatus: string | null;
  providerFeeMinor: number | null;
  failureCode: string | null;
  recipientName: string | null;
  maskedAccount: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  createdAt: string;
  paidAt: string | null;
};

type TransactionEntry = {
  ownerType: string;
  accountCode: string;
  organizationId: string | null;
  direction: string;
  amountMinor: number;
  currency: string;
};

type RecentTransaction = {
  id: string;
  type: string;
  sourceType: string;
  description: string | null;
  createdAt: string;
  entries: TransactionEntry[];
};

const money = (minor: number) => new Intl.NumberFormat("en-KE", {
  style: "currency", currency: "KES", minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(Number(minor || 0) / 100);

const dateTime = (value?: string | null) => value
  ? new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Nairobi" }).format(new Date(value))
  : "—";

const label = (value?: string | null) => (value || "unknown").replace(/[._-]+/g, " ").replace(/\b\w/g, (x) => x.toUpperCase());

export default async function PlatformFinancePage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  const { data, error } = await supabase.rpc("get_platform_finance_summary");
  if (error || !data || typeof data !== "object") {
    return (
      <WorkspaceShell section="Mandate finance" items={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Paid voting", href: "/platform/paid-voting" },
        { label: "Finance", href: "/platform/finance" },
      ]} activeHref="/platform/finance" actions={<form action={signOutAction}><button className="quiet-button">Sign out</button></form>}>
        <main className="dashboard-shell"><section className="panel">
          <h1>Platform finance is restricted</h1>
          <p className="form-error">This ledger is available only to an active Mandate platform operator.</p>
        </section></main>
      </WorkspaceShell>
    );
  }

  const summary = data as Record<string, unknown>;
  const revenue = Number(summary.mandateRevenueMinor ?? 0);
  const processorFees = Number(summary.processorFeesMinor ?? 0);
  const providerClearing = Number(summary.providerClearingMinor ?? 0);
  const organizationPayables = Number(summary.organizationPayablesMinor ?? 0);
  const reserved = Number(summary.reservedPayoutsMinor ?? 0);
  const paidOut = Number(summary.paidOutMinor ?? 0);
  const accounts = (Array.isArray(summary.accounts) ? summary.accounts : []) as AccountBalance[];
  const payables = (Array.isArray(summary.organizationPayables) ? summary.organizationPayables : []) as OrganizationPayable[];
  const payouts = (Array.isArray(summary.payouts) ? summary.payouts : []) as PlatformPayout[];
  const transactions = (Array.isArray(summary.recentTransactions) ? summary.recentTransactions : []) as RecentTransaction[];

  return (
    <WorkspaceShell section="Mandate finance" items={[
      { label: "Dashboard", href: "/dashboard" },
      { label: "Paid voting", href: "/platform/paid-voting" },
      { label: "Finance", href: "/platform/finance" },
    ]} activeHref="/platform/finance" actions={<form action={signOutAction}><button className="quiet-button">Sign out</button></form>}>
      <main className="dashboard-shell finance-shell">
        <section className="dashboard-intro">
          <p className="kicker">PLATFORM FINANCE</p>
          <h1>Central finance ledger</h1>
          <p className="muted">Mandate-wide accounting, processor clearing and organization payable monitoring.</p>
        </section>
        <p className="finance-info">This is an accounting ledger, not a deposit or stored-value wallet. All balances are calculated from posted double-entry transactions. Pending transfers remain reserved until Paystack confirms their final status.</p>

        <section className="finance-metrics" aria-label="Platform finance summary">
          <div className="finance-metric finance-metric-primary"><p>Mandate revenue</p><strong>{money(revenue)}</strong><span>Posted platform-revenue accounts</span></div>
          <div className="finance-metric"><p>Processor fees</p><strong>{money(processorFees)}</strong><span>Posted Paystack fee expense</span></div>
          <div className="finance-metric"><p>Provider clearing</p><strong>{money(providerClearing)}</strong><span>Net Paystack clearing ledger balance</span></div>
          <div className="finance-metric"><p>Organization payables</p><strong>{money(organizationPayables)}</strong><span>Funds owed to organizations</span></div>
          <div className="finance-metric"><p>Reserved payouts</p><strong>{money(reserved)}</strong><span>Requests not yet final</span></div>
          <div className="finance-metric"><p>Paid out</p><strong>{money(paidOut)}</strong><span>Provider-verified transfers</span></div>
        </section>

        <section className="finance-grid">
          <div className="panel">
            <div className="panel-heading"><div><p className="kicker">ORGANIZATION LEDGERS</p><h2>Payable balances</h2></div><span className="count">{payables.length}</span></div>
            {payables.length === 0 ? <div className="empty-state"><h3>No organization payable balances</h3><p className="muted">No organization-revenue allocations have been posted. Public paid vote-credit revenue remains Mandate-only.</p></div> : (
              <div className="finance-list">
                {payables.map((item) => <div className="finance-row" key={item.organizationId}>
                  <div><strong>{item.organizationName}</strong><p className="muted">Organization payable ledger</p></div>
                  <strong>{money(item.balanceMinor)}</strong>
                </div>)}
              </div>
            )}
          </div>
          <div className="panel">
            <div className="panel-heading"><div><p className="kicker">LEDGER ACCOUNTS</p><h2>Account balances</h2></div><span className="count">{accounts.length}</span></div>
            {accounts.length === 0 ? <div className="empty-state"><h3>No posted accounts</h3><p className="muted">Platform accounts appear when their first verified ledger posting is recorded.</p></div> : (
              <div className="finance-table-wrap"><table className="finance-table">
                <thead><tr><th>Account</th><th>Owner</th><th>Balance</th></tr></thead>
                <tbody>{accounts.map((account, index) => <tr key={`${account.ownerType}:${account.organizationId ?? "platform"}:${account.accountCode}:${index}`}>
                  <td><strong>{label(account.accountCode)}</strong><small>{account.organizationName ?? label(account.ownerType)}</small></td>
                  <td>{label(account.ownerType)}</td>
                  <td>{money(account.balanceMinor)}</td>
                </tr>)}</tbody>
              </table></div>
            )}
          </div>
        </section>

        <section className="panel finance-section">
          <div className="panel-heading"><div><p className="kicker">DISBURSEMENT MONITOR</p><h2>Organization payout activity</h2></div><span className="count">{payouts.length}</span></div>
          {payouts.length === 0 ? <div className="empty-state"><h3>No payout requests</h3><p className="muted">Organization payout requests will be monitored here. Approval remains with the organization’s authorized finance team.</p></div> : (
            <div className="finance-list">
              {payouts.map((payout) => <article className="finance-payout" key={payout.id}>
                <div className="finance-payout-heading">
                  <div><strong>{payout.organizationName}</strong><p className="muted">{payout.recipientName ?? "Beneficiary"} · {payout.maskedAccount ?? "Destination unavailable"}</p></div>
                  <span className="status-pill">{label(payout.status)}</span>
                </div>
                <div className="finance-payout-meta">
                  <span>{money(payout.amountMinor)}</span>
                  <span>Paystack: {label(payout.providerStatus)}</span>
                  <span>Requested {dateTime(payout.createdAt)}</span>
                  {payout.paidAt && <span>Paid {dateTime(payout.paidAt)}</span>}
                  {payout.reference && <span>Ref: {payout.reference}</span>}
                </div>
                {payout.failureCode && <p className="form-hint">Provider exception: {payout.failureCode}</p>}
              </article>)}
            </div>
          )}
        </section>

        <section className="panel finance-section">
          <div className="panel-heading"><div><p className="kicker">ACCOUNTABILITY</p><h2>Recent ledger postings</h2></div><span className="count">{transactions.length}</span></div>
          {transactions.length === 0 ? <div className="empty-state"><h3>No posted ledger activity</h3><p className="muted">Verified collection, fee, payout and reconciliation entries will appear here.</p></div> : (
            <div className="finance-list">
              {transactions.map((transaction) => <article className="finance-payout" key={transaction.id}>
                <div className="finance-payout-heading">
                  <div><strong>{label(transaction.type)}</strong><p className="muted">{transaction.description ?? transaction.sourceType}</p></div>
                  <span className="muted">{dateTime(transaction.createdAt)}</span>
                </div>
                <div className="finance-entry-list">
                  {transaction.entries.map((entry, index) => <div key={`${transaction.id}:${entry.accountCode}:${index}`}>
                    <span>{label(entry.accountCode)} · {label(entry.direction)}</span><strong>{money(entry.amountMinor)}</strong>
                  </div>)}
                </div>
              </article>)}
            </div>
          )}
        </section>
      </main>
    </WorkspaceShell>
  );
}
