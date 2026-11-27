"use client";

import { useState, useTransition } from "react";
import { requestPublicParticipantOtp, verifyPublicParticipantOtp } from "../../actions/public-vote";

export function ParticipantVerificationForm({ slug }: { slug: string }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [verified, setVerified] = useState(false);
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
      else setVerified(true);
    });
  }

  if (verified) {
    return (
      <section className="form-stack" aria-live="polite">
        <p className="form-hint" role="status">Your email is verified for this election. The next step is checkout; payment remains unavailable until the election and payment release gates are enabled.</p>
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
