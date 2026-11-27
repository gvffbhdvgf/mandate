"use client";

import { useActionState } from "react";
import Link from "next/link";
import { resendSignupConfirmationAction, signUpAction, type AuthActionState } from "../actions/auth";

const initialState: AuthActionState = {};

export function SignupForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signUpAction, initialState);
  const [resendState, resendAction, resendPending] = useActionState(resendSignupConfirmationAction, initialState);

  if (state.status === "confirmation_required") {
    return (
      <section aria-live="polite">
        <p className="form-success">{state.message}</p>
        <p className="form-hint">Confirmation requested for <strong>{state.email}</strong>.</p>
        <form action={resendAction} className="form-stack">
          <input type="hidden" name="email" value={state.email ?? ""} />
          <input type="hidden" name="next" value={state.next ?? next} />
          <button className="secondary-button" disabled={resendPending}>{resendPending ? "Requesting…" : "Resend confirmation email"}</button>
        </form>
        {resendState.message && <p className="form-hint" role="status">{resendState.message}</p>}
        {resendState.error && <p className="form-error" role="alert">{resendState.error}</p>}
        <p className="auth-foot"><Link href={"/login?next=" + encodeURIComponent(state.next ?? next)}>Continue to sign in</Link></p>
      </section>
    );
  }

  return (
    <>
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <form action={action} className="form-stack">
        <input type="hidden" name="next" value={next} />
        <label>Your name<input name="displayName" type="text" autoComplete="name" minLength={2} maxLength={160} required /></label>
        <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
        <label>Password<input name="password" type="password" autoComplete="new-password" minLength={10} maxLength={128} required /><small>Use at least 10 characters.</small></label>
        <button className="primary-button" disabled={pending}>{pending ? "Creating account…" : "Create account"}</button>
      </form>
    </>
  );
}
