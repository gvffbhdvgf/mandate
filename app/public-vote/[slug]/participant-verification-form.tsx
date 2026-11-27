"use client";

import { useState, useTransition } from "react";
import { initializePublicVoteCreditCheckout, requestPublicParticipantOtp, verifyPublicParticipantOtp } from "../../actions/public-vote";
import { PublicPaidBallot } from "./public-paid-ballot";

type ParticipantElection = {
  title: string;
  currency: string;
  pricePerCreditMinor: number;
  maxCreditsPerParticipant: number;
  endsAt: string;
  timezone: string;
  creditsRemaining: number;
};

type BallotContext = {
  election: { title: string; slug: string; endsAt: string; timezone: string };
  creditsRemaining: number;
  contests: Array<{
    id: string;
    title: string;
    required: boolean;
    ballotsCast: number;
    options: Array<{ id: string; displayName: string }>;
  }>;
};

export function ParticipantVerificationForm({
  slug,
  initialSession = null,
  initialBallotContext = null,
}: {
  slug: string;
  initialSession?: ParticipantElection | null;
  initialBallotContext?: BallotContext | null;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [participantElection, setParticipantElection] = useState<ParticipantElection | null>(initialSession);
  const [ballotContext, setBallotContext] = useState<BallotContext | null>(initialBallotContext);
  const [quantity, setQuantity] = useState(1);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  function sendCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    startTransition(async () => {
      const result = await requestPublicParticipantOtp(email);
      if (result.error) setMessage(result.error);
      else {
        setCodeSent(true);
        setMessage("A six-digit verification code has been sent if this address can receive email.");
      }
    });
  }

  function verifyCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    startTransition(async () => {
      const result = await verifyPublicParticipantOtp(email, code, slug);
      if (result.error) setMessage(result.error);
      else if (result.election) {
        setParticipantElection(result.election as ParticipantElection);
        setBallotContext((result.ballotContext as BallotContext | null) ?? null);
        setQuantity(1);
      }
    });
  }

  if (participantElection && ballotContext && ballotContext.creditsRemaining > 0) {
    return (
      <section className="form-stack">
        <p className="form-hint" role="status">Your email is verified. You can now cast a ballot using your purchased credits.</p>
        <PublicPaidBallot slug={slug} initialContext={ballotContext} />
      </section>
    );
  }

  if (participantElection) {
    const totalMinor = participantElection.pricePerCreditMinor * quantity;
    return (
      <section className="form-stack" aria-live="polite">
        <p className="form-hint" role="status">Your email is verified for this election. Your ballot choices remain separate from your payment identity.</p>
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            setMessage("");
            const key = idempotencyKey || crypto.randomUUID();
            setIdempotencyKey(key);
            startTransition(async () => {
              const result = await initializePublicVoteCreditCheckout(slug, quantity, key);
              if (result.error) setMessage(result.error);
              else if (result.authorizationUrl) window.location.assign(result.authorizationUrl);
            });
          }}
        >
          <label>Voting credits to purchase
            <input
              type="number"
              min={1}
              max={participantElection.maxCreditsPerParticipant}
              step={1}
              value={quantity}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isSafeInteger(next) && next >= 1 && next <= participantElection.maxCreditsPerParticipant) {
                  setQuantity(next);
                  setIdempotencyKey("");
                }
              }}
              required
            />
          </label>
          <p className="form-hint">
            {quantity} credit{quantity === 1 ? "" : "s"} · KSh {(totalMinor / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
          <button className="primary-button" disabled={pending || quantity < 1 || quantity > participantElection.maxCreditsPerParticipant}>
            {pending ? "Preparing secure checkout…" : "Continue to Paystack"}
          </button>
        </form>
        {message && <p className="form-error" role="alert">{message}</p>}
      </section>
    );
  }

  return (
    <section className="form-stack">
      {!codeSent ? (
        <form onSubmit={sendCode} className="form-stack">
          <label>Email address
            <input
              type="email"
              name="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              required
            />
          </label>
          <button className="primary-button" disabled={pending}>{pending ? "Sending code…" : "Send email code"}</button>
        </form>
      ) : (
        <form onSubmit={verifyCode} className="form-stack">
          <label>Six-digit email code
            <input
              type="text"
              name="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              required
            />
          </label>
          <button className="primary-button" disabled={pending || code.length !== 6}>{pending ? "Verifying…" : "Verify email"}</button>
          <button className="secondary-button" type="button" disabled={pending} onClick={() => { setCodeSent(false); setCode(""); setMessage(""); }}>Use a different email</button>
        </form>
      )}
      {message && <p className="form-hint" role="status">{message}</p>}
    </section>
  );
}
