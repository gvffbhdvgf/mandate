import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { signOutAction } from "../../../actions/auth";
import {
  approveOrganizationPayoutAction,
  createPayoutRecipientAction,
  finalizeOrganizationPayoutOtpAction,
  initiateOrganizationPayoutAction,
  requestOrganizationPayoutAction,
  resendOrganizationPayoutOtpAction,
  verifyOrganizationPayoutAction,
} from "../../../actions/disbursements";
import { WorkspaceShell } from "../../../components/workspace-shell";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

type Recipient = {
  id: string;
  type: string;
  name: string;
  bankCode: string;
  maskedAccount: string;
  active: boolean;
  createdAt: string;
};

type Payout = {
  id: string;
  amountMinor: number;
  currency: string;
  status: string;
  reference: string | null;
  providerStatus: string | null;
  providerFeeMinor: number | null;
  failureCode: string | null;
  failureMessage: string | null;
  recipientName: string | null;
  maskedAccount: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  createdAt: string;
  paidAt: string | null;
};

type LedgerEntry = {
  id: string;
  transactionId: string;
  transactionType: string;
  description: string | null;
  direction: string;
  amountMinor: number;
  currency: string;
  createdAt: string;
};

const money = (minor: number) => new Intl.NumberFormat("en-KE", {
  style: "currency", currency: "KES", minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(Number(minor || 0) / 100);

const dateTime = (value?: string | null) => value
  ? new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Nairobi" }).format(new Date(value))
  : "—";

const label = (value?: string | null) => (value || "unknown").replace(/[._-]+/g, " ").replace(/\b\w/g, (x) => x.toUpperCase());

const errors: Record<string, string> = {
  RECIPIENT_DETAILS_INVALID: "Check the beneficiary details and confirm that the destination belongs to the intended recipient.",
  RECIPIENT_ALREADY_LINKED_TO_ANOTHER_ORGANIZATION: "That Paystack recipient is already assigned to another organization.",
  PAYOUT_REQUEST_INVALID: "Enter a valid positive payout amount and choose a beneficiary.",
  INSUFFICIENT_RECONCILED_ORGANIZATION_FUNDS: "The organization does not have enough reconciled payable funds for this request.",
  PAYOUT_DUAL_CONTROL_REQUIRED: "A different authorized finance member must approve the payout request.",
  PAYOUT_REQUEST_NOT_APPROVABLE: "This payout request is no longer awaiting approval.",
  PAYOUT_NOT_READY_FOR_TRANSFER: "The payout must be approved by a different finance member before it can be submitted.",
  PAYOUT_RECIPIENT_UNAVAILABLE: "The selected beneficiary is no longer active. Register or select another beneficiary.",
  PAYSTACK_TRANSFERS_DISABLED: "Live transfers are not enabled by the current Paystack live-payment master switch.",
  PAYSTACK_TRANSFER_REJECTED: "Paystack rejected the transfer. Review the provider status and correct the issue before requesting another payout.",
  TRANSFER_OUTCOME_UNKNOWN: "The transfer outcome is uncertain. Keep this payout reference and check its status; do not create a second request.",
  TRANSFER_OTP_INVALID: "Enter the OTP sent by Paystack to the merchant contact.",
  PAYOUT_ACTION_INVALID: "The payout action details are invalid. Refresh and try again.",
};

const notices: Record<string, string> = {
  RECIPIENT_CREATED: "Beneficiary saved. Mandate stores only the Paystack recipient code and masked destination.",
  PAYOUT_REQUESTED: "Payout request submitted. A different authorized finance member must approve it.",
  PAYOUT_APPROVED: "Payout approved. It is ready for an authorized finance member to submit to Paystack.",
  TRANSFER_SUBMITTED: "Transfer submitted to Paystack. It is not marked paid until provider verification succeeds.",
  TRANSFER_OTP_SUBMITTED: "OTP submitted. Mandate will only mark the payout paid after Paystack verification.",
  TRANSFER_OTP_RESENT: "Paystack OTP resend requested.",
  TRANSFER_STATUS_CHECKED: "Paystack transfer status checked.",
};

export default async function OrganizationFinancePage({ params, searchParams }: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { organizationId } = await params;
  const feedback = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  const { data: organization, error: organizationError } = await supabase
    .from("organizations").select("id,name,slug").eq("id", organizationId).maybeSingle();
  if (organizationError || !organization) notFound();

  const { data: membership, error: membershipError } = await supabase
    .from("organization_members").select("role,status")
    .eq("organization_id", organizationId).eq("user_id", user.id).maybeSingle();
  if (membershipError || membership?.status !== "active"
    || !["owner", "admin", "finance_manager"].includes(membership.role)) {
    redirect(`/organizations/${organizationId}`);
  }

  const { data, error } = await supabase.rpc("get_organization_finance_summary", {
    p_organization_id: organizationId,
  });
  if (error || !data || typeof data !== "object") {
    return (
      <WorkspaceShell section="Organization finance" context={organization.name}
        items={[{ label: "Dashboard", href: "/dashboard" }, { label: "Organization", href: `/organizations/${organizationId}` }, { label: "Finance", href: `/organizations/${organizationId}/finance` }]}
        activeHref={`/organizations/${organizationId}/finance`}
        actions={<form action={signOutAction}><button className="quiet-button">Sign out</button></form>}>
        <main className="dashboard-shell"><section className="panel">
          <h1>Finance ledger unavailable</h1>
          <p className="form-error">Mandate could not load this organization’s ledger. Refresh the page or contact support.</p>
        </section></main>
      </WorkspaceShell>
    );
  }

  const summary = data as Record<string, unknown>;
  const ledgerBalanceMinor = Number(summary.ledgerBalanceMinor ?? 0);
  const reservedMinor = Number(summary.reservedMinor ?? 0);
  const availableMinor = Number(summary.availableMinor ?? 0);
  const paidOutMinor = Number(summary.paidOutMinor ?? 0);
  const overReserved = summary.overReserved === true;
  const recipients = (Array.isArray(summary.recipients) ? summary.recipients : []) as Recipient[];
  const payouts = (Array.isArray(summary.payouts) ? summary.payouts : []) as Payout[];
  const ledgerEntries = (Array.isArray(summary.ledgerEntries) ? summary.ledgerEntries : []) as LedgerEntry[];

  return (
    <WorkspaceShell section="Organization finance" context={organization.name}
      items={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Organization", href: `/organizations/${organizationId}` },
        { label: "Elections", href: `/organizations/${organizationId}#elections` },
        { label: "Finance", href: `/organizations/${organizationId}/finance` },
      ]}
      activeHref={`/organizations/${organizationId}/finance`}
      actions={<form action={signOutAction}><button className="quiet-button">Sign out</button></form>}>
      <main className="dashboard-shell finance-shell">
        <section className="dashboard-intro">
          <p className="kicker">ORGANIZATION FINANCE</p>
          <h1>Funds and payouts</h1>
          <p className="muted">{organization.name} · Reconciled ledger view</p>
        </section>

        {feedback.error && <p className="form-error">{errors[feedback.error] ?? `Finance action could not be completed (${feedback.error}). Check the payout status before retrying.`}</p>}
        {feedback.success && <p className="finance-success">{notices[feedback.success] ?? "Finance update completed."}</p>}
        {overReserved && <p className="form-error">Outstanding payout reservations exceed the current ledger balance. New payout requests are blocked pending reconciliation.</p>}

        <section className="finance-metrics" aria-label="Organization finance summary">
          <div className="finance-metric finance-metric-primary"><p>Available to request</p><strong>{money(availableMinor)}</strong><span>Posted ledger balance less pending payout reservations</span></div>
          <div className="finance-metric"><p>Ledger balance</p><strong>{money(ledgerBalanceMinor)}</strong><span>Verified organization payable funds</span></div>
          <div className="finance-metric"><p>Reserved</p><strong>{money(reservedMinor)}</strong><span>Requests awaiting final provider status</span></div>
          <div className="finance-metric"><p>Paid out</p><strong>{money(paidOutMinor)}</strong><span>Provider-verified transfers</span></div>
        </section>

        <section className="finance-grid">
          <div className="panel">
            <div className="panel-heading"><div><p className="kicker">BENEFICIARIES</p><h2>Payment destinations</h2></div><span className="count">{recipients.length}</span></div>
            {recipients.length === 0 ? <div className="empty-state"><h3>No beneficiaries yet</h3><p className="muted">Register the organization’s M-Pesa number, Till or bank destination. Confirm the details before saving.</p></div> : (
              <div className="finance-list">
                {recipients.map((recipient) => <div className="finance-row" key={recipient.id}>
                  <div><strong>{recipient.name}</strong><p className="muted">{label(recipient.type)} · {recipient.bankCode} · {recipient.maskedAccount}</p></div>
                  <span className="status-pill">Active</span>
                </div>)}
              </div>
            )}
            <div className="finance-form-divider" />
            <p className="kicker">ADD DESTINATION</p>
            <form className="form-stack finance-form" action={createPayoutRecipientAction}>
              <input type="hidden" name="organizationId" value={organizationId} />
              <label>Destination type
                <select name="type" defaultValue="mobile_money" required>
                  <option value="mobile_money">M-Pesa personal number</option>
                  <option value="mobile_money_business">M-Pesa Till</option>
                  <option value="kepss">Kenyan bank account</option>
                </select>
              </label>
              <label>Beneficiary name<input name="name" required minLength={2} maxLength={160} placeholder="Account holder or business name" /></label>
              <label>Phone or account number<input name="accountNumber" required minLength={6} maxLength={40} placeholder="Enter destination number" /></label>
              <label>Paystack bank code<input name="bankCode" required minLength={2} maxLength={32} defaultValue="MPESA" placeholder="MPESA, MPTILL or bank code" /></label>
              <label className="finance-confirm"><input type="checkbox" name="destinationConfirmed" value="true" required /> I have independently confirmed that these payment details belong to the intended beneficiary.</label>
              <p className="form-hint">Raw account details are sent to Paystack and are not stored by Mandate. Only the provider recipient code and masked destination are retained.</p>
              <button className="primary-button" type="submit">Save beneficiary</button>
            </form>
          </div>

          <div className="panel">
            <p className="kicker">REQUEST A PAYOUT</p><h2>Withdraw organization funds</h2>
            <p className="muted">Payouts can only use reconciled funds credited to this organization’s payable ledger. Public paid-vote revenue belongs to Mandate and is not included here.</p>
            {availableMinor <= 0 ? <div className="empty-state"><h3>No withdrawable funds</h3><p className="muted">Your available balance is {money(availableMinor)}. Once an eligible organization-revenue election posts reconciled proceeds, they will appear here.</p></div> : recipients.length === 0 ? <div className="empty-state"><h3>Add a beneficiary first</h3><p className="muted">Register and confirm a payment destination before requesting a payout.</p></div> : (
              <form className="form-stack finance-form" action={requestOrganizationPayoutAction}>
                <input type="hidden" name="organizationId" value={organizationId} />
                <label>Pay to
                  <select name="recipientId" required defaultValue="">
                    <option value="" disabled>Select a beneficiary</option>
                    {recipients.map((recipient) => <option value={recipient.id} key={recipient.id}>{recipient.name} · {recipient.maskedAccount}</option>)}
                  </select>
                </label>
                <label>Amount (KES)<input name="amountKes" type="number" min="0.01" step="0.01" max={availableMinor / 100} required placeholder="0.00" /></label>
                <p className="form-hint">A different active organization owner, administrator or finance manager must approve this request.</p>
                <button className="primary-button" type="submit">Request payout</button>
              </form>
            )}
          </div>
        </section>

        <section className="panel finance-section">
          <div className="panel-heading"><div><p className="kicker">PAYOUT ACTIVITY</p><h2>Requests and transfers</h2></div><span className="count">{payouts.length}</span></div>
          {payouts.length === 0 ? <div className="empty-state"><h3>No payout activity</h3><p className="muted">Beneficiaries and payout requests will appear here.</p></div> : (
            <div className="finance-list">
              {payouts.map((payout) => <article className="finance-payout" key={payout.id}>
                <div className="finance-payout-heading">
                  <div><strong>{money(payout.amountMinor)}</strong><p className="muted">{payout.recipientName ?? "Beneficiary"} · {payout.maskedAccount ?? "Destination unavailable"}</p></div>
                  <span className={`status-pill ${payout.status === "paid" ? "status-paid" : payout.status === "failed" ? "status-failed" : ""}`}>{label(payout.status)}</span>
                </div>
                <div className="finance-payout-meta">
                  <span>Requested {dateTime(payout.createdAt)}</span>
                  {payout.providerStatus && <span>Paystack: {label(payout.providerStatus)}</span>}
                  {payout.paidAt && <span>Paid {dateTime(payout.paidAt)}</span>}
                  {payout.reference && <span>Ref: {payout.reference}</span>}
                </div>
                {payout.requestedBy && <p className="form-hint">Requested by {payout.requestedBy}{payout.approvedBy ? ` · Approved by ${payout.approvedBy}` : ""}</p>}
                {payout.failureMessage && <p className="form-error">{payout.failureMessage} {payout.failureCode ? `(${payout.failureCode})` : ""}</p>}
                {payout.status === "requested" || payout.status === "under_review" ? (
                  <form action={approveOrganizationPayoutAction} className="finance-inline-action">
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="payoutRequestId" value={payout.id} />
                    <span className="form-hint">Approval must come from someone other than the requester.</span>
                    <button className="secondary-button compact-button" type="submit">Approve request</button>
                  </form>
                ) : payout.status === "approved" ? (
                  <form action={initiateOrganizationPayoutAction} className="finance-inline-action">
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="payoutRequestId" value={payout.id} />
                    <button className="primary-button compact-button" type="submit">Submit transfer to Paystack</button>
                  </form>
                ) : payout.status === "processing" && payout.providerStatus === "otp" ? (
                  <div className="finance-otp-actions">
                    <form action={finalizeOrganizationPayoutOtpAction} className="finance-inline-action">
                      <input type="hidden" name="organizationId" value={organizationId} />
                      <input type="hidden" name="payoutRequestId" value={payout.id} />
                      <label>Paystack OTP<input name="otp" inputMode="numeric" autoComplete="one-time-code" minLength={4} maxLength={8} required /></label>
                      <button className="primary-button compact-button" type="submit">Confirm OTP</button>
                    </form>
                    <form action={resendOrganizationPayoutOtpAction}>
                      <input type="hidden" name="organizationId" value={organizationId} />
                      <input type="hidden" name="payoutRequestId" value={payout.id} />
                      <button className="secondary-button compact-button" type="submit">Resend OTP</button>
                    </form>
                  </div>
                ) : payout.status === "processing" ? (
                  <form action={verifyOrganizationPayoutAction} className="finance-inline-action">
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="payoutRequestId" value={payout.id} />
                    <button className="secondary-button compact-button" type="submit">Check Paystack status</button>
                  </form>
                ) : null}
              </article>)}
            </div>
          )}
        </section>

        <section className="panel finance-section">
          <div className="panel-heading"><div><p className="kicker">DOUBLE-ENTRY LEDGER</p><h2>Account activity</h2></div><span className="count">{ledgerEntries.length}</span></div>
          {ledgerEntries.length === 0 ? <div className="empty-state"><h3>No posted organization proceeds</h3><p className="muted">The ledger is ready, but this organization has not yet received a reconciled revenue allocation.</p></div> : (
            <div className="finance-table-wrap"><table className="finance-table">
              <thead><tr><th>Activity</th><th>Direction</th><th>Amount</th><th>Date</th></tr></thead>
              <tbody>{ledgerEntries.map((entry) => <tr key={entry.id}>
                <td><strong>{label(entry.transactionType)}</strong><small>{entry.description ?? entry.transactionId}</small></td>
                <td><span className={`finance-direction finance-direction-${entry.direction}`}>{label(entry.direction)}</span></td>
                <td>{money(entry.amountMinor)}</td>
                <td>{dateTime(entry.createdAt)}</td>
              </tr>)}</tbody>
            </table></div>
          )}
        </section>
      </main>
    </WorkspaceShell>
  );
}
