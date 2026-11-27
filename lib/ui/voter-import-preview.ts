import { parse } from "csv-parse/browser/esm/sync";
import { z } from "zod";

export type VoterPreviewRow = {
  voterRef: string;
  name: string;
  email: string;
  phone: string;
  weight: number;
};

export type VoterImportPreview = {
  valid: boolean;
  totalRows: number;
  acceptedRows: number;
  rejectedRows: number;
  previewRows: VoterPreviewRow[];
  errors: Array<{ row: number; message: string }>;
  warnings: string[];
};

const allowedHeaders = new Set(["voter_ref", "name", "email", "phone_e164", "weight"]);
const emailSchema = z.string().email();
const phonePattern = /^\+[1-9][0-9]{7,14}$/;

function invalid(message: string, totalRows = 0): VoterImportPreview {
  return {
    valid: false,
    totalRows,
    acceptedRows: 0,
    rejectedRows: totalRows,
    previewRows: [],
    errors: [{ row: 0, message }],
    warnings: [],
  };
}

export function previewVoterCsv(csvText: string, votingMode: string): VoterImportPreview {
  let records: Array<Record<string, string>>;
  try {
    records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
      relax_column_count: false,
      max_record_size: 10_000,
    }) as Array<Record<string, string>>;
  } catch {
    return invalid("We could not read this CSV. Check its headings, encoding and row formatting.");
  }

  if (records.length === 0) return invalid("This file has no voter rows.");
  if (records.length > 25_000) return invalid("A voter import can contain at most 25,000 rows.", records.length);

  const headers = Object.keys(records[0]).map((header) => header.trim().toLowerCase());
  if (!headers.includes("voter_ref") || !headers.includes("name")) {
    return invalid("Required columns are missing. Include voter_ref and name, plus email or phone_e164 for each voter.", records.length);
  }
  const unexpected = headers.filter((header) => !allowedHeaders.has(header));
  const warnings = unexpected.length
    ? [`Additional columns are not used and will be ignored: ${unexpected.slice(0, 5).join(", ")}${unexpected.length > 5 ? ", and others" : ""}.`]
    : [];

  const seenRefs = new Set<string>();
  const seenEmails = new Set<string>();
  const errors: Array<{ row: number; message: string }> = [];
  const previewRows: VoterPreviewRow[] = [];
  const rejected = new Set<number>();

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const values = Object.fromEntries(Object.entries(record).map(([key, value]) => [key.trim().toLowerCase(), String(value ?? "").trim()]));
    const voterRef = values.voter_ref ?? "";
    const name = values.name ?? "";
    const email = (values.email ?? "").toLowerCase();
    const phone = values.phone_e164 ?? "";
    const weightRaw = values.weight ?? "";
    const weight = weightRaw === "" ? 1 : Number(weightRaw);
    const rowErrors: string[] = [];

    if (!voterRef || voterRef.length > 200) rowErrors.push("Add a voter reference (up to 200 characters).");
    if (!name || name.length > 200) rowErrors.push("Add the voter's name (up to 200 characters).");
    if (email && !emailSchema.safeParse(email).success) rowErrors.push("Enter a valid email address or leave it blank.");
    if (phone && !phonePattern.test(phone)) rowErrors.push("Use an international phone number, for example +254712345678.");
    if (!email && !phone) rowErrors.push("Add a contact address: an email address or an international phone number.");
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > 1_000_000) rowErrors.push("Voting weight must be a whole number from 1 to 1,000,000.");
    if (votingMode === "registered_single" && weight !== 1) rowErrors.push("This election uses one person, one vote, so every voter weight must be 1.");

    const refKey = voterRef.toLowerCase();
    if (refKey && seenRefs.has(refKey)) rowErrors.push("This voter reference is duplicated in the file.");
    if (email && seenEmails.has(email)) rowErrors.push("This email address is duplicated in the file.");
    if (refKey) seenRefs.add(refKey);
    if (email) seenEmails.add(email);

    if (rowErrors.length) {
      rejected.add(rowNumber);
      for (const message of rowErrors) errors.push({ row: rowNumber, message });
      return;
    }

    if (previewRows.length < 6) previewRows.push({ voterRef, name, email, phone, weight });
  });

  const rejectedRows = rejected.size;
  return {
    valid: errors.length === 0,
    totalRows: records.length,
    acceptedRows: records.length - rejectedRows,
    rejectedRows,
    previewRows,
    errors,
    warnings,
  };
}
