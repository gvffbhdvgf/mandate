"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signUpAction, type AuthActionState } from "../actions/auth";

const initialState: AuthActionState = {};

export default function SignupPage() {
  const [state, action, pending] = useActionState(signUpAction, initialState);

  return (
    <main className="auth-shell">
      <Link className="brand" href="/">
        <span className="brand-mark">M</span><span>mandate</span>
      </Link>
      <section className="auth-card">
        <p className="kicker">GET STARTED</p>
        <h1>Create your account</h1>
        <p className="muted">Start organizing clear, accountable elections for your organization.</p>
        {state.error && <p className="form-error" role="alert">{state.error}</p>}
        <form action={action} className="form-stack">
          <label>Your name<input name="displayName" type="text" autoComplete="name" minLength={2} maxLength={160} required /></label>
          <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
          <label>Password<input name="password" type="password" autoComplete="new-password" minLength={10} required /></label>
          <button className="primary-button" disabled={pending}>{pending ? "Creating account…" : "Create account"}</button>
        </form>
        <p className="auth-foot">Already have an account? <Link href="/login">Sign in</Link></p>
      </section>
    </main>
  );
}
