"use client";

import { useActionState, useRef, useState, type ChangeEvent } from "react";
import { stageVoterImportAction, type VoterImportActionState } from "../../../../actions/voters";
import type { VoterImportPreview } from "../../../../../lib/ui/voter-import-preview";

const initialState: VoterImportActionState = {};

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function downloadErrorReport(preview: VoterImportPreview) {
  const rows = ["CSV row,Problem", ...preview.errors.map((error) => `${error.row},${csvCell(error.message)}`)];
  const blob = new Blob([rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "voter-import-errors.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function VoterImportForm({ organizationId, electionId, votingMode = "registered_single" }: {
  organizationId: string;
  electionId: string;
  votingMode?: string;
}) {
  const [state, action, pending] = useActionState(stageVoterImportAction, initialState);
  const [preview, setPreview] = useState<VoterImportPreview | null>(null);
  const [fileName, setFileName] = useState("");
  const [checkingFile, setCheckingFile] = useState(false);
  const parseSequence = useRef(0);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    const sequence = ++parseSequence.current;
    setPreview(null);
    setFileName(file?.name ?? "");
    setCheckingFile(Boolean(file));
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setPreview({ valid: false, totalRows: 0, acceptedRows: 0, rejectedRows: 0, previewRows: [], errors: [{ row: 0, message: "The CSV file must be 10 MB or smaller." }], warnings: [] });
      setCheckingFile(false);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setPreview({ valid: false, totalRows: 0, acceptedRows: 0, rejectedRows: 0, previewRows: [], errors: [{ row: 0, message: "Choose a .csv file." }], warnings: [] });
      setCheckingFile(false);
      return;
    }
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const { previewVoterCsv } = await import("../../../../../lib/ui/voter-import-preview");
      const buffer = await file.arrayBuffer();
      let csvText: string;
      try {
        csvText = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        if (sequence === parseSequence.current) {
          setPreview({ valid: false, totalRows: 0, acceptedRows: 0, rejectedRows: 0, previewRows: [], errors: [{ row: 0, message: "This file is not valid UTF-8. Save it as a UTF-8 CSV and try again." }], warnings: [] });
        }
        return;
      }
      const result = previewVoterCsv(csvText, votingMode);
      if (sequence === parseSequence.current) setPreview(result);
    } catch {
      if (sequence === parseSequence.current) {
        setPreview({ valid: false, totalRows: 0, acceptedRows: 0, rejectedRows: 0, previewRows: [], errors: [{ row: 0, message: "We could not read this file. Save it as a UTF-8 CSV and try again." }], warnings: [] });
      }
    } finally {
      if (sequence === parseSequence.current) setCheckingFile(false);
    }
  }

  return (
    <form action={action} className="form-stack import-form" aria-busy={pending || checkingFile}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="electionId" value={electionId} />
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
      <label>Choose your voter register CSV
        <input name="file" type="file" accept=".csv,text/csv" aria-describedby="voter-import-help" onChange={handleFileChange} required />
      </label>
      <p className="form-hint" id="voter-import-help">Each row needs a unique voter reference, a name and either an email address or an international phone number such as +254712345678. The browser checks every row, then the server checks the file against the existing register. No voters are added unless validation succeeds and you confirm.</p>
      {fileName && <p className="selected-file"><strong>Selected file</strong><span>{fileName}</span></p>}
      {preview && (
        <section className="import-preview" aria-label="CSV validation preview">
          {preview.totalRows > 0 && (
            <div className="preview-counts" aria-live="polite">
              <div><strong>{preview.totalRows.toLocaleString("en-KE")}</strong><span>Rows found</span></div>
              <div><strong>{preview.acceptedRows.toLocaleString("en-KE")}</strong><span>Ready to upload</span></div>
              <div><strong>{preview.rejectedRows.toLocaleString("en-KE")}</strong><span>Need fixing</span></div>
            </div>
          )}
          {preview.warnings.map((warning) => <p className="preview-warning" key={warning}>{warning}</p>)}
          {preview.valid ? (
            <>
              <p className="form-success" role="status">All {preview.totalRows.toLocaleString("en-KE")} rows passed the preliminary check. The server will validate them again before staging. No voters have been added yet.</p>
              <div className="import-preview-table-wrap">
                <table className="import-preview-table">
                  <caption>Sample of the first {preview.previewRows.length} valid voter rows</caption>
                  <thead><tr><th scope="col">Reference</th><th scope="col">Name</th><th scope="col">Contact</th><th scope="col">Weight</th></tr></thead>
                  <tbody>
                    {preview.previewRows.map((row) => (
                      <tr key={row.voterRef}>
                        <td>{row.voterRef}</td><td>{row.name}</td><td>{row.email || row.phone}</td><td>{row.weight}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="preview-errors" role="alert">
              <div><strong>Fix these issues before uploading.</strong><p>No voters have been added.</p></div>
              <ul>
                {preview.errors.slice(0, 30).map((error, index) => (
                  <li key={`${error.row}-${index}`}>{error.row > 0 ? `Row ${error.row}: ` : "File: "}{error.message}</li>
                ))}
              </ul>
              {preview.errors.length > 30 && <p className="form-hint">Showing the first 30 issues. Download the full error report to review the rest.</p>}
              <button type="button" className="secondary-button" onClick={() => downloadErrorReport(preview)}>Download error report</button>
            </div>
          )}
        </section>
      )}
      <p className="form-hint" role="status" aria-live="polite">{pending ? "Uploading your private file and checking every voter…" : checkingFile ? "Reading your CSV and checking each row…" : "Your voter list stays private. No voters are added until you review and confirm the import."}</p>
      <button className="primary-button" disabled={pending || checkingFile || !preview?.valid}>{pending ? "Checking voter register…" : checkingFile ? "Checking CSV…" : "Upload and validate CSV"}</button>
    </form>
  );
}
