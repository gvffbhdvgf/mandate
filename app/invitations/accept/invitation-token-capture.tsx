"use client";

import { useEffect, useRef, useState } from "react";
import { stageOrganizationInvitationAction } from "../../actions/organization-members";

export function InvitationTokenCapture() {
  const formRef = useRef<HTMLFormElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("Preparing your secure invitation link…");

  useEffect(() => {
    const fragment = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : "";
    const token = new URLSearchParams(fragment).get("token") ?? "";
    window.history.replaceState(null, "", window.location.pathname + window.location.search);

    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
      setMessage("This invitation link is incomplete. Please open the original invitation email again.");
      return;
    }
    if (tokenRef.current && formRef.current) {
      tokenRef.current.value = token;
      formRef.current.requestSubmit();
    }
  }, []);

  return (
    <form ref={formRef} action={stageOrganizationInvitationAction} className="form-stack">
      <input ref={tokenRef} type="hidden" name="token" />
      <p className="form-hint" role="status" aria-live="polite">{message}</p>
      <noscript><p className="form-error">JavaScript is required to securely process this invitation link.</p></noscript>
    </form>
  );
}
