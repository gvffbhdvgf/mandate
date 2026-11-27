"use client";

import { useActionState, useEffect } from "react";
import {
  startPlatformFeeCheckoutAction,
  type PlatformFeeCheckoutState,
} from "../../../../actions/payments";

const initialState: PlatformFeeCheckoutState = {};

type FeeQuote = {
  eligibleVoterCount: number;
  amountMinor: number;
  currency: string;
  policyVersion: number;
  status: string;
};

export function PlatformFeeCheckout({
  organizationId,
  electionId,
  quote,
}: {
  organizationId: string;
  electionId: string;
  quote: FeeQuote;
}) {
  const [state, action, pending] = useActionState(startPlatformFeeCheckoutAction, initialState);

  useEffect(() => {
    if (state.authorizationUrl) window.location.assign(state.authorizationUrl);
  }, [state.authorizationUrl]);

  const amount = (quote.amountMinor / 100).toLocaleString("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <section className="panel platform-fee-panel">
      <div className="panel-heading">
        <div><p className="kicker">MANDATE PLATFORM SERVICE FEE</p><h2>Election service invoice</h2></div>
        <span className="status-pill">{quote.status.replaceAll("_", " ")}</span>
      </div>
      <div className="summary-grid">
        <div><span>Eligible voters</span><strong>{quote.eligibleVoterCount.toLocaleString("en-KE")}</strong></div>
        <div><span>Service fee</span><strong>KSh {amount}</strong></div>
        <div><span>Pricing policy</span><strong>v{quote.policyVersion}</strong></div>
        <div><span>Rate</span><strong>KSh 20 per voter · KSh 500 minimum</strong></div>
      </div>
      <p className="muted">This is Mandate's service fee for this registered election. The amount is calculated from the committed eligible-voter register and locked to this policy version. The voter register cannot be changed after the invoice is created. Paystack payment processing charges, if any, are handled under the provider's merchant terms and are not added as a client-entered amount.</p>
      {quote.eligibleVoterCount < 1 ? (
        <p className="form-hint">Commit at least one eligible voter before generating the invoice.</p>
      ) : quote.status === "paid" ? (
        <p className="form-success" role="status">Payment verified. Election opening can proceed once voter invitations and the other opening checks are complete.</p>
      ) : quote.status === "exception" ? (
        <p className="form-error" role="alert">This payment requires reconciliation. Do not pay again until it has been reviewed.</p>
      ) : (
        <form action={action} className="form-stack">
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="electionId" value={electionId} />
          <input type="hidden" name="eligibleVoterCount" value={quote.eligibleVoterCount} />
          <input type="hidden" name="amountMinor" value={quote.amountMinor} />
          <input type="hidden" name="policyVersion" value={quote.policyVersion} />
          {state.error && <p className="form-error" role="alert">{state.error}</p>}
          {state.message && <p className="form-success" role="status">{state.message}</p>}
          <button className="primary-button" disabled={pending || Boolean(state.authorizationUrl)}>
            {pending ? "Preparing secure checkout…" : "Continue to secure payment"}
          </button>
        </form>
      )}
    </section>
  );
}
