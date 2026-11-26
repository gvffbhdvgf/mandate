"use client";

import { useActionState, useState } from "react";
import { createOrganizationAction, type OrganizationActionState } from "../actions/organizations";

const initialState: OrganizationActionState = {};

export function CreateOrganizationForm() {
  const [state, action, pending] = useActionState(createOrganizationAction, initialState);
  const [name, setName] = useState("");
  const slug = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

  return (
    <form action={action} className="form-stack organization-form">
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <label>Organization name<input name="name" value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={160} required /></label>
      <label>Organization URL<input name="slug" value={slug} readOnly required /><small>This address is generated from your organization name.</small></label>
      <label>Contact email (optional)<input name="contactEmail" type="email" autoComplete="email" /></label>
      <button className="primary-button" disabled={pending || slug.length < 3}>{pending ? "Creating…" : "Create organization"}</button>
    </form>
  );
}
