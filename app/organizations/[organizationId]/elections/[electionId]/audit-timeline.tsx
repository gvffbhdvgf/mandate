import { formatAuditAction } from "../../../../../lib/ui/presentation";
type AuditEvent = {
  action: string; actorType: string; entityType: string; createdAt: string;
  metadata: Record<string, unknown> | null;
};
const labels: Record<string, string> = {
  votingMode: "Voting method", startsAt: "Voting starts", endsAt: "Voting ends",
  currency: "Currency", pricePerCreditMinor: "Price per credit",
  maxCreditsPerParticipant: "Credit limit per participant",
  configurationHash: "Configuration confirmation", rulesHash: "Rules snapshot",
  setupConfirmedBy: "Setup confirmed by", credits: "Credits purchased",
  amountMinor: "Payment amount", creditsIssued: "Credits issued",
  acceptedBallots: "Accepted ballots", invalidatedBallots: "Invalidated ballots",
  requiresResolution: "Further resolution required", snapshotHash: "Election snapshot",
};
function humanize(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}
function formatMetadataValue(key: string, value: unknown, metadata: Record<string, unknown>): string {
  if (value === null || value === undefined || value === "") return "Not provided";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (key.endsWith("Minor") && metadata.currency === "KES")
      return new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES" }).format(value / 100);
    return new Intl.NumberFormat("en-KE").format(value);
  }
  if (typeof value === "string") {
    if (key === "votingMode") return value === "public_paid" ? "Public paid voting" : humanize(value);
    if (key === "setupConfirmedBy") return "Authorized organization member";
    if (/Id$/i.test(key) || /Hash$/i.test(key)) return "Recorded";
    if (/At$/.test(key) && !Number.isNaN(Date.parse(value)))
      return new Date(value).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" });
    return value.includes("_") ? humanize(value) : value;
  }
  if (Array.isArray(value)) return value.map(String).join(", ");
  return "Available";
}
export function ElectionAuditTimeline({ events }: { events: AuditEvent[] }) {
  if (!events.length) return null;
  return (
    <section className="panel audit-panel">
      <div className="panel-heading"><div><p className="kicker">ACCOUNTABILITY</p><h2>Election activity</h2></div><span className="count">{events.length}</span></div>
      <ol className="audit-list">
        {events.map((event, index) => (
          <li className="audit-item" key={`${event.action}-${event.createdAt}-${index}`}>
            <span className="audit-dot" />
            <div className="audit-content">
              <strong>{formatAuditAction(event.action)}</strong>
              <p>{event.actorType === "system" ? "System event" : "Authorized organization member"} · {new Date(event.createdAt).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}</p>
              {event.metadata && Object.keys(event.metadata).length > 0 && (
                <details><summary>View event information</summary>
                  <dl className="audit-metadata">
                    {Object.entries(event.metadata).map(([key, value]) => (
                      <div className="audit-metadata-row" key={key}>
                        <dt>{labels[key] ?? humanize(key)}</dt>
                        <dd>{formatMetadataValue(key, value, event.metadata ?? {})}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
