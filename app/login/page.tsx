"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signInAction, type AuthActionState } from "../actions/auth";

const initialState: AuthActionState = {};

export default function LoginPage() {
  const [state, action, pending] = useActionState(signInAction, initialState);

  return (
    <main className="auth-shell">
      <Link className="brand" href="/">
        <span className="brand-mark">M</span><span>mandate</span>
      </Link>
      <section className="auth-card">
        <p className="kicker">WELCOME BACK</p>
        <h1>Sign in to Mandate</h1>
        <p className="muted">Manage your organization’s elections with clarity and confidence.</p>
        {state.error && <p className="form-error" role="alert">{state.error}</p>}
        <form action={action} className="form-stack">
          <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
          <button className="primary-button" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
        </form>
        <p className="auth-foot">New to Mandate? <Link href="/signup">Create an account</Link></p>
      </section>
    </main>
  );
}
