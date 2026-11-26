"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export type MemberActionState = { error?: string; message?: string };
const roles = ["admin", "election_manager", "returning_officer", "finance_manager", "viewer"] as const;
const uuidSchema = z.string().uuid();

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login");
  return { supabase, user };
}

export async function createOrganizationInvitationAction(
  _previousState: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "");
  if (!uuidSchema.safeParse(organizationId).success || !z.string().email().max(254).safeParse(email).success || !roles.includes(role as typeof roles[number])) {
    return { error: "Enter a valid email and choose an available organization role." };
  }
  const { supabase } = await requireUser();
  const { data, error } = await supabase.functions.invoke("send-organization-invitation", {
    body: { organizationId, email, role },
  });
  let response: Record<string, unknown> | null = data;
  if (error && "context" in error && error.context instanceof Response) {
    try { response = await error.context.clone().json(); } catch { response = null; }
  }
  const code = String(response?.error ?? error?.message ?? "");
  if (error || code) {
    if (code.includes("INVITATION_DELIVERY_NOT_CONFIGURED")) return { error: "Email invitations are not enabled yet. Configure the verified Resend sender and Mandate site URL first; no invitation was issued." };
    if (code.includes("ROLE_ASSIGNMENT_REQUIRES_OWNER")) return { error: "Only the organization owner can assign Admin or Finance Manager roles." };
    if (code.includes("MEMBER_ALREADY_ACTIVE")) return { error: "That person is already an active member of this organization." };
    if (code.includes("FORBIDDEN")) return { error: "You do not have permission to invite members." };
    if (code.includes("INVITATION_DELIVERY_UNCERTAIN")) return { error: "The email provider did not confirm delivery. Check Pending invitations before retrying; the invitation remains valid in case the message was delivered." };
    if (code.includes("INVITATION_DELIVERY_FAILED")) return { error: "The invitation email could not be delivered. The pending invitation was revoked; try again later." };
    return { error: "The invitation could not be created. Check the details and try again." };
  }
  revalidatePath(`/organizations/${organizationId}`);
  return { message: `Invitation sent to ${email}. It expires in seven days.` };
}

const invitationCookie = "mandate_invitation_token";

export async function stageOrganizationInvitationAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) redirect("/login");
  const cookieStore = await cookies();
  cookieStore.set(invitationCookie, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 24 * 60 * 60,
  });
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect("/invitations/accept");
  redirect("/login?next=%2Finvitations%2Faccept");
}

export async function acceptOrganizationInvitationAction(_formData: FormData): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(invitationCookie)?.value ?? "";
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) redirect("/login");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) redirect("/login?next=%2Finvitations%2Faccept");
  const { data, error } = await supabase.rpc("accept_organization_invitation", { p_token_hash: tokenHash });
  if (error || !data?.organizationId) {
    const message = error?.message ?? "INVITATION_NOT_AVAILABLE";
    const code = message.includes("EMAIL_MISMATCH") ? "email-mismatch"
      : message.includes("EXPIRED") ? "expired"
      : message.includes("NOT_AVAILABLE") || message.includes("ALREADY_USED") ? "unavailable"
      : "failed";
    if (code !== "email-mismatch") cookieStore.delete(invitationCookie);
    redirect(`/invitations/accept?error=${code}`);
  }
  cookieStore.delete(invitationCookie);
  redirect(`/organizations/${data.organizationId}`);
}

export async function switchInvitationAccountAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login?next=%2Finvitations%2Faccept");
}

export async function revokeOrganizationInvitationAction(formData: FormData): Promise<void> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const invitationId = String(formData.get("invitationId") ?? "");
  if (!uuidSchema.safeParse(organizationId).success || !uuidSchema.safeParse(invitationId).success) return;
  const { supabase } = await requireUser();
  await supabase.rpc("revoke_organization_invitation", { p_invitation_id: invitationId });
  revalidatePath(`/organizations/${organizationId}`);
}

export async function changeOrganizationMemberRoleAction(formData: FormData): Promise<void> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const memberId = String(formData.get("memberId") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!uuidSchema.safeParse(organizationId).success || !uuidSchema.safeParse(memberId).success || !roles.includes(role as typeof roles[number])) return;
  const { supabase } = await requireUser();
  await supabase.rpc("change_organization_member_role", { p_member_id: memberId, p_role: role });
  revalidatePath(`/organizations/${organizationId}`);
}

export async function revokeOrganizationMemberAction(formData: FormData): Promise<void> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const memberId = String(formData.get("memberId") ?? "");
  if (!uuidSchema.safeParse(organizationId).success || !uuidSchema.safeParse(memberId).success) return;
  const { supabase } = await requireUser();
  await supabase.rpc("revoke_organization_member", { p_member_id: memberId });
  revalidatePath(`/organizations/${organizationId}`);
}
