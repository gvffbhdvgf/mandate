"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export type OrganizationActionState = { error?: string };

const organizationSchema = z.object({
  name: z.string().trim().min(2).max(160),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(3).max(60),
  contactEmail: z.union([z.literal(""), z.string().email()]).optional(),
});

export async function createOrganizationAction(
  _previousState: OrganizationActionState,
  formData: FormData,
): Promise<OrganizationActionState> {
  const parsed = organizationSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    contactEmail: formData.get("contactEmail") ?? "",
  });
  if (!parsed.success) return { error: "Check the organization name, URL slug and contact email." };

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) redirect("/login");

  const { error } = await supabase.rpc("create_organization", {
    p_name: parsed.data.name,
    p_slug: parsed.data.slug,
    p_contact_email: parsed.data.contactEmail || null,
    p_timezone: "Africa/Nairobi",
  });

  if (error) {
    if (error.message.includes("ORGANIZATION_SLUG_TAKEN")) return { error: "That organization URL is already in use. Choose another." };
    return { error: "We could not create the organization. Please review the details and try again." };
  }

  redirect("/dashboard");
}
