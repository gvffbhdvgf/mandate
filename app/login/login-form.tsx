"use client";

import { useActionState, useState } from "react";
import { resendConfirmationAction, signInAction, type AuthActionState } from "../actions/auth";

const initialState: AuthActionState = {};

export function LoginForm({ next, notice }: { next: string; notice?: string }) {
  const [state, action, pending] = useActionState(signInAction, initialState);
  const [resendState, resendAction, resendPending] = useActionState(resendConfirmationAction, initialState);
  const [email, setEmail] = useState("");
  const showResend = notice === "confirm" || state.needsConfirmation;

  return (
    <>
      {notice === "confirm" && (
        <p className="form-hint" role="status">
          Your account has been created and is waiting for email confirmation. Open the confirmation email, then return here to sign in.
        </p>
      )}
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <form action={action} className="form-stack">
        <input type="hidden" name="next" value={next} />
        <label>Email address
          <input name="email" type="email" autoComplete="email" value={email}
            onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        <button className="primary-button" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
      </form>
      {showResend && (
        <form action={resendAction} className="form-stack">
          <input type="hidden" name="email" value={email} />
          <input type="hidden" name="next" value={next} />
          <button className="secondary-button" disabled={resendPending}>
            {resendPending ? "Requesting email…" : "Resend confirmation email"}
          </button>
          {resendState.error && <p className="form-error" role="alert">{resendState.error}</p>}
          {resendState.message && <p className="form-hint" role="status">{resendState.message}</p>}
        </form>
      )}
    </>
  );
}
