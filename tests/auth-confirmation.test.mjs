import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("unconfirmed sign-in explains the confirmation requirement without exposing provider details", async () => {
  const auth = await read("../app/actions/auth.ts");
  assert.match(auth, /email_not_confirmed/);
  assert.match(auth, /use the resend option below/);
  assert.match(auth, /\[auth\.signin\] Supabase rejected sign-in/);
  assert.doesNotMatch(auth, /return \{ error: error\.message/);
});

test("confirmation resend uses Supabase signup resend and a same-origin callback", async () => {
  const auth = await read("../app/actions/auth.ts");
  const login = await read("../app/login/login-form.tsx");
  assert.match(auth, /resendSignupConfirmationAction/);
  assert.match(auth, /auth\.resend\(/);
  assert.match(auth, /type: "signup"/);
  assert.match(auth, /emailRedirectTo: callbackUrlFor/);
  assert.match(auth, /If this address has an unconfirmed Mandate account/);
  assert.match(login, /Resend confirmation email/);
  assert.match(login, /resendSignupConfirmationAction/);
  assert.match(login, /Didn't receive the confirmation email/);
});

test("confirmation notice only promises invitation acceptance for invitation destinations", async () => {
  const login = await read("../app/login/login-form.tsx");
  assert.match(login, /next === "\\/invitations\\/accept"/);
  assert.match(login, /to continue\\./);
});

test("auth callback reports expired or failed confirmation instead of silently redirecting", async () => {
  const callback = await read("../app/auth/callback/route.ts");
  assert.match(callback, /callbackFailureUrl/);
  assert.match(callback, /providerError \\|\\| !code/);
  assert.match(callback, /exchangeCodeForSession\\(code\\)/);
  assert.match(callback, /confirmation_failed/);
  assert.match(callback, /forgot-password\\?notice=expired/);
  assert.match(callback, /\[auth\.callback\] Code exchange failed/);
});

test("password recovery callback keeps its dedicated password update route", async () => {
  const callback = await read("../app/auth/callback/route.ts");
  assert.match(callback, /next === "\\/update-password"/);
  assert.match(callback, /returnTo/);
});
