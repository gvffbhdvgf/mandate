import { formatAuditAction, formatAuditMetadata } from "../../../../../lib/ui/presentation";

type AuditEvent = {
  action: string;
  actorType: string;
  entityType: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
};

export function ElectionAuditTimeline({ events }: { events: AuditEvent[] }) {
  if (!events.length) return null;

  return (
    <section className="panel audit-panel" aria-labelledby="activity-heading" id="activity">
      <div className="panel-heading">
        <div>
          <p className="kicker">ACCOUNTABILITY</p>
          <h2 id="activity-heading">Election activity</h2>
          <p className="muted">A record of important changes to this election.</p>
        </div>
        <span className="count" aria-label={`${events.length} activity records`}>{events.length}</span>
      </div>
      <ol className="audit-list">
        {events.map((event, index) => {
          const details = formatAuditMetadata(event.metadata);
          return (
            <li className="audit-item" key={`${event.action}-${event.createdAt}-${index}`}>
              <span className="audit-dot" aria-hidden="true" />
              <div className="audit-content">
                <strong>{formatAuditAction(event.action)}</strong>
                <p>
                  {event.actorType === "system" ? "Automated system" : "Authorized organization member"}
                  <span aria-hidden="true"> · </span>
                  <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}</time>
                </p>
                {details.length > 0 && (
                  <details className="audit-details">
                    <summary>View event details</summary>
                    <dl>
                      {details.map((detail) => (
                        <div key={detail.label}>
                          <dt>{detail.label}</dt>
                          <dd>{detail.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
