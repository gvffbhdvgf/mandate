"use client";

import { useActionState, useState } from "react";
import { createOrganizationAction, type OrganizationActionState } from "../actions/organizations";

const initialState: OrganizationActionState = {};

function makeSlug(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

export function CreateOrganizationForm() {
  const [state, action, pending] = useActionState(createOrganizationAction, initialState);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  function updateName(value: string) {
    setName(value);
    if (!slugEdited) setSlug(makeSlug(value));
  }

  return (
    <form action={action} className="form-stack organization-form">
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <label>Organization name<input name="name" value={name} onChange={(event) => updateName(event.target.value)} minLength={2} maxLength={160} required /></label>
      <label>Organization URL<input name="slug" value={slug} onChange={(event) => { setSlugEdited(true); setSlug(makeSlug(event.target.value)); }} minLength={3} maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" required /><small>Use lowercase letters, numbers and hyphens. You can edit this address.</small></label>
      <label>Contact email (optional)<input name="contactEmail" type="email" autoComplete="email" /></label>
      <button className="primary-button" disabled={pending || slug.length < 3}>{pending ? "Creating…" : "Create organization"}</button>
    </form>
  );
}
