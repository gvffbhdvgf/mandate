import { createSupabaseServerClient } from "../../../../../../lib/supabase/server";

type ReportOption = {
  name: string;
  ballots: number;
  voteUnits: number;
  shareBasisPoints: number;
  rank: number;
  isWinner: boolean;
  isTied: boolean;
  requiresResolution: boolean;
};

type PublishedReport = {
  election: { id: string; title: string; publishedAt: string; timezone: string };
  tally: {
    eligibleVoters: number;
    participatingVoters: number;
    turnoutBasisPoints: number;
    acceptedBallots: number;
    invalidatedBallots: number;
    totalVoteUnits: number;
  };
  contests: Array<{ title: string; options: ReportOption[] }>;
};

const exportRoles = ["owner", "admin", "returning_officer"];

function csvCell(value: unknown): string {
  let text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function csvReport(report: PublishedReport): string {
  const rows: unknown[][] = [
    ["Mandate election results"],
    ["Election", report.election.title],
    ["Published", report.election.publishedAt],
    ["Timezone", report.election.timezone],
    [],
    ["Eligible voters", report.tally.eligibleVoters],
    ["Participating voters", report.tally.participatingVoters],
    ["Accepted ballots", report.tally.acceptedBallots],
    ["Invalidated ballots", report.tally.invalidatedBallots],
    ["Turnout percent", (report.tally.turnoutBasisPoints / 100).toFixed(2)],
    ["Total vote units", report.tally.totalVoteUnits],
    [],
    ["Contest", "Option", "Ballots", "Vote units", "Share percent", "Rank", "Winner", "Tied", "Needs resolution"],
  ];
  for (const contest of report.contests) {
    for (const option of contest.options) {
      rows.push([
        contest.title,
        option.name,
        option.ballots,
        option.voteUnits,
        (option.shareBasisPoints / 100).toFixed(2),
        option.rank,
        option.isWinner ? "Yes" : "No",
        option.isTied ? "Yes" : "No",
        option.requiresResolution ? "Yes" : "No",
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function pdfAscii(value: unknown): string {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "?");
}

function pdfEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function pdfReport(report: PublishedReport): ArrayBuffer {
  const lines = [
    "MANDATE - PUBLISHED ELECTION RESULTS",
    "Election: " + pdfAscii(report.election.title),
    "Published: " + pdfAscii(report.election.publishedAt) + " (" + pdfAscii(report.election.timezone) + ")",
    "",
    "Eligible voters: " + report.tally.eligibleVoters,
    "Participating voters: " + report.tally.participatingVoters,
    "Accepted ballots: " + report.tally.acceptedBallots,
    "Invalidated ballots: " + report.tally.invalidatedBallots,
    "Turnout: " + (report.tally.turnoutBasisPoints / 100).toFixed(2) + "%",
    "Total vote units: " + report.tally.totalVoteUnits,
  ];
  for (const contest of report.contests) {
    lines.push("", "Contest: " + pdfAscii(contest.title));
    for (const option of contest.options) {
      const status = option.isWinner ? " | Winner" : option.isTied ? " | Tied" : "";
      lines.push(
        "  " + pdfAscii(option.name) + " | " + option.voteUnits + " votes | " +
        (option.shareBasisPoints / 100).toFixed(2) + "% | Rank " + option.rank + status,
      );
      if (option.requiresResolution) lines.push("    Resolution required before final declaration");
    }
  }

  const wrapped: string[] = [];
  for (const line of lines) {
    const safe = pdfAscii(line);
    if (safe.length <= 96) {
      wrapped.push(safe);
      continue;
    }
    for (let start = 0; start < safe.length; start += 96) wrapped.push(safe.slice(start, start + 96));
  }
  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += 50) pages.push(wrapped.slice(i, i + 50));
  if (pages.length === 0) pages.push([]);

  const encoder = new TextEncoder();
  const pageIds = pages.map((_, index) => 3 + index * 2);
  const fontId = 3 + pages.length * 2;
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [" + pageIds.map((id) => id + " 0 R").join(" ") +
    "] /Count " + pages.length + " >>";
  for (let i = 0; i < pages.length; i++) {
    const pageId = pageIds[i];
    const streamId = pageId + 1;
    const commands = ["BT", "/F1 10 Tf", "50 792 Td"];
    for (let j = 0; j < pages[i].length; j++) {
      if (j > 0) commands.push("0 -14 Td");
      commands.push("(" + pdfEscape(pages[i][j]) + ") Tj");
    }
    commands.push("ET");
    const stream = commands.join("\n") + "\n";
    objects[pageId] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] " +
      "/Resources << /Font << /F1 " + fontId + " 0 R >> >> /Contents " + streamId + " 0 R >>";
    objects[streamId] = "<< /Length " + encoder.encode(stream).length + " >>\nstream\n" + stream + "endstream";
  }
  objects[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = encoder.encode(pdf).length;
    pdf += i + " 0 obj\n" + objects[i] + "\nendobj\n";
  }
  const xrefOffset = encoder.encode(pdf).length;
  pdf += "xref\n0 " + objects.length + "\n0000000000 65535 f \n";
  for (let i = 1; i < objects.length; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += "trailer\n<< /Size " + objects.length + " /Root 1 0 R >>\nstartxref\n" +
    xrefOffset + "\n%%EOF\n";
  return encoder.encode(pdf).buffer as ArrayBuffer;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ organizationId: string; electionId: string }> },
) {
  const { organizationId, electionId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(organizationId) || !/^[0-9a-f-]{36}$/i.test(electionId)) {
    return Response.json({ error: "REPORT_NOT_FOUND" }, { status: 404 });
  }

  const format = new URL(request.url).searchParams.get("format");
  if (format !== "csv" && format !== "pdf") {
    return Response.json({ error: "SUPPORTED_FORMATS_ARE_CSV_AND_PDF" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return Response.json({ error: "AUTHENTICATION_REQUIRED" }, { status: 401 });

  const { data: membership, error: membershipError } = await supabase
    .from("organization_members")
    .select("role,status")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (membershipError || membership?.status !== "active" || !exportRoles.includes(membership.role)) {
    return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const { data: election, error: electionError } = await supabase
    .from("elections")
    .select("id,organization_id,status")
    .eq("id", electionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (electionError || !election || election.status !== "results_published") {
    return Response.json({ error: "RESULTS_NOT_PUBLISHED" }, { status: 404 });
  }

  const { data, error: resultError } = await supabase.rpc("get_published_results", {
    p_election_id: electionId,
  });
  if (resultError || !data) return Response.json({ error: "REPORT_UNAVAILABLE" }, { status: 404 });

  const report = data as PublishedReport;
  const body: string | ArrayBuffer = format === "csv" ? csvReport(report) : pdfReport(report);
  const { error: auditError } = await supabase.rpc("record_results_export", {
    p_election_id: electionId,
    p_format: format,
  });
  if (auditError) return Response.json({ error: "REPORT_UNAVAILABLE" }, { status: 503 });

  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "attachment; filename=\"mandate-results-" + electionId + "." + format + "\"",
  });
  headers.set("Content-Type", format === "csv" ? "text/csv; charset=utf-8" : "application/pdf");
  return new Response(body, { status: 200, headers });
}
