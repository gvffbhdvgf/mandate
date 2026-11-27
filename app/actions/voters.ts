"use server";

import { parse } from "csv-parse/browser/esm/sync";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export type VoterImportActionState = { error?: string };

const rowSchema = z.object({
  voter_ref: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  email: z.union([z.literal(""), z.string().email()]).optional().default(""),
  phone_e164: z.union([z.literal(""), z.string().regex(/^\\+[1-9][0-9]{7,14}$/)]).optional().default(""),
  weight: z.coerce.number().int().min(1).max(1_000_000).optional().default(1),
});

export async function stageVoterImportAction(
  _previousState: VoterImportActionState,
  formData: FormData,
): Promise<VoterImportActionState> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const electionId = String(formData.get("electionId") ?? "");
  const file = formData.get("file");

  if (!z.string().uuid().safeParse(organizationId).success || !z.string().uuid().safeParse(electionId).success) {
    return { error: "The election reference is invalid. Refresh and try again." };
  }
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file to import." };
  if (file.size > 10 * 1024 * 1024) return { error: "The CSV file must be 10 MB or smaller." };
  if (!file.name.toLowerCase().endsWith(".csv")) return { error: "Upload a .csv file." };
  if (file.type && !["text/csv", "application/csv", "application/vnd.ms-excel"].includes(file.type)) {
    return { error: "The uploaded file must be a CSV." };
  }

  let records: Record<string, string>[];
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
      relax_column_count: false,
      max_record_size: 10_000,
    }) as Record<string, string>[];
  } catch {
    return { error: "We could not read this CSV. Check its encoding, headings and row formatting." };
  }

  if (records.length < 1) return { error: "The CSV has no voter rows." };
  if (records.length > 25_000) return { error: "A voter import can contain at most 25,000 rows." };

  const headers = Object.keys(records[0]).map((header) => header.trim().toLowerCase());
  const allowedHeaders = new Set(["voter_ref", "name", "email", "phone_e164", "weight"]);
  if (!headers.includes("voter_ref") || !headers.includes("name") || headers.some((header) => !allowedHeaders.has(header))) {
    return { error: "Use the supplied CSV template. Required columns: voter_ref and name; optional columns: email, phone_e164 and weight." };
  }

  const normalized: Array<{
    external_voter_ref: string;
    display_name: string;
    normalized_email: string | null;
    phone_e164: string | null;
    weight_units: number;
  }> = [];
  const seenRefs = new Set<string>();
  const seenEmails = new Set<string>();

  for (let index = 0; index < records.length; index += 1) {
    const raw = Object.fromEntries(Object.entries(records[index]).map(([key, value]) => [key.trim().toLowerCase(), value]));
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) return { error: `Check voter row ${index + 2}: reference, name, email, phone or weight is invalid.` };

    const email = parsed.data.email.trim().toLowerCase() || null;
    const phone = parsed.data.phone_e164.trim() || null;
    if (!email && !phone) return { error: `Voter row ${index + 2} needs an email address or an E.164 phone number.` };

    const refKey = parsed.data.voter_ref.toLowerCase();
    if (seenRefs.has(refKey)) return { error: `Voter reference is duplicated on row ${index + 2}.` };
    if (email && seenEmails.has(email)) return { error: `Email address is duplicated on row ${index + 2}.` };
    seenRefs.add(refKey);
    if (email) seenEmails.add(email);

    normalized.push({
      external_voter_ref: parsed.data.voter_ref,
      display_name: parsed.data.name,
      normalized_email: email,
      phone_e164: phone,
      weight_units: parsed.data.weight,
    });
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  const { data: election, error: electionError } = await supabase
    .from("elections")
    .select("id,organization_id,status,voting_mode")
    .eq("id", electionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (electionError || !election) return { error: "You cannot access this election." };
  if (election.status !== "draft") return { error: "The voter register is locked after the election opens." };
  if (election.voting_mode === "registered_single" && normalized.some((row) => row.weight_units !== 1)) {
    return { error: "One-person-one-vote elections require every voter weight to be 1." };
  }

  const batchFileId = crypto.randomUUID();
  const objectPath = `${organizationId}/${electionId}/${batchFileId}.csv`;
  const { error: uploadError } = await supabase.storage
    .from("mandate-voter-imports")
    .upload(objectPath, file, { contentType: "text/csv", upsert: false });

  if (uploadError) return { error: "The private voter file could not be uploaded. Check your election permissions and try again." };

  const { data, error } = await supabase.rpc("stage_voter_import", {
    p_election_id: electionId,
    p_private_object_path: objectPath,
    p_original_filename: file.name,
    p_rows: normalized,
  });

  if (error || !data?.batchId) {
    await supabase.storage.from("mandate-voter-imports").remove([objectPath]);
    if (error?.message.includes("VOTER_ALREADY_REGISTERED")) return { error: "One or more voters are already in this election register." };
    if (error?.message.includes("DUPLICATE_VOTER")) return { error: "The file contains duplicate voter references or email addresses." };
    return { error: "The voter import could not be validated. Check the CSV and try again." };
  }

  redirect(`/organizations/${organizationId}/elections/${electionId}?batchId=${data.batchId}`);
}

export async function stageManualVoterAction(
  _previousState: VoterImportActionState,
  formData: FormData,
): Promise<VoterImportActionState> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const electionId = String(formData.get("electionId") ?? "");
  const parsed = rowSchema.safeParse({
    voter_ref: formData.get("voterRef"),
    name: formData.get("name"),
    email: String(formData.get("email") ?? "").trim(),
    phone_e164: String(formData.get("phone") ?? "").trim(),
    weight: formData.get("weight") ?? "1",
  });

  if (!z.string().uuid().safeParse(organizationId).success || !z.string().uuid().safeParse(electionId).success) {
    return { error: "The election reference is invalid. Refresh and try again." };
  }
  if (!parsed.success) return { error: "Check the voter reference, name, contact details and voting weight." };

  const email = parsed.data.email.trim().toLowerCase() || null;
  const phone = parsed.data.phone_e164.trim() || null;
  if (!email && !phone) return { error: "Add an email address or an international phone number." };

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  const { data: election, error: electionError } = await supabase
    .from("elections")
    .select("id,organization_id,status,voting_mode")
    .eq("id", electionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (electionError || !election) return { error: "You cannot access this election." };
  if (election.status !== "draft") return { error: "The voter register is locked after the election opens." };
  if (election.voting_mode === "public_paid") return { error: "Manual voter registration is not used for public paid elections." };
  if (election.voting_mode === "registered_single" && parsed.data.weight !== 1) {
    return { error: "One-person-one-vote elections require a voting weight of 1." };
  }

  const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const csv = [
    "voter_ref,name,email,phone_e164,weight",
    [parsed.data.voter_ref, parsed.data.name, email ?? "", phone ?? "", String(parsed.data.weight)].map(csvCell).join(","),
  ].join("\n");
  const batchFileId = crypto.randomUUID();
  const objectPath = `${organizationId}/${electionId}/${batchFileId}.csv`;
  const { error: uploadError } = await supabase.storage
    .from("mandate-voter-imports")
    .upload(objectPath, new Blob([csv], { type: "text/csv" }), { contentType: "text/csv", upsert: false });
  if (uploadError) return { error: "The private voter record could not be staged. Check your election permissions and try again." };

  const { data, error } = await supabase.rpc("stage_voter_import", {
    p_election_id: electionId,
    p_private_object_path: objectPath,
    p_original_filename: "manual-voter-entry.csv",
    p_rows: [{
      external_voter_ref: parsed.data.voter_ref,
      display_name: parsed.data.name,
      normalized_email: email,
      phone_e164: phone,
      weight_units: parsed.data.weight,
    }],
  });
  if (error || !data?.batchId) {
    await supabase.storage.from("mandate-voter-imports").remove([objectPath]);
    if (error?.message.includes("VOTER_ALREADY_REGISTERED")) return { error: "This voter reference or email address is already registered in the election." };
    if (error?.message.includes("DUPLICATE_VOTER")) return { error: "This voter duplicates another record in the register." };
    return { error: "The voter could not be validated. Check the details and try again." };
  }

  redirect(`/organizations/${organizationId}/elections/${electionId}?batchId=${data.batchId}`);
}

export async function commitVoterImportAction(
  _previousState: VoterImportActionState,
  formData: FormData,
): Promise<VoterImportActionState> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const electionId = String(formData.get("electionId") ?? "");
  const batchId = String(formData.get("batchId") ?? "");
  if (![organizationId, electionId, batchId].every((value) => z.string().uuid().safeParse(value).success)) {
    return { error: "The import reference is invalid. Refresh and try again." };
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) redirect("/login");

  const { error } = await supabase.rpc("commit_voter_import", { p_batch_id: batchId });
  if (error) return { error: "The voter register could not be committed. Check that the election is still a draft and retry." };

  redirect(`/organizations/${organizationId}/elections/${electionId}`);
}
