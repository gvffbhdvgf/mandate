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
    <section className="panel audit-panel">
      <div className="panel-heading"><div><p className="kicker">ACCOUNTABILITY</p><h2>Election activity</h2></div><span className="count">{events.length}</span></div>
      <ol className="audit-list">
        {events.map((event, index) => (
          <li className="audit-item" key={`${event.action}-${event.createdAt}-${index}`}>
            <span className="audit-dot" />
            <div className="audit-content">
              <strong>{event.action.replaceAll(".", " ").replaceAll("_", " ")}</strong>
              <p>{event.actorType === "system" ? "System event" : "Authorized organization member"} · {new Date(event.createdAt).toLocaleString("en-KE")}</p>
              {event.metadata && Object.keys(event.metadata).length > 0 && (
                <details><summary>Event details</summary><pre>{JSON.stringify(event.metadata, null, 2)}</pre></details>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
