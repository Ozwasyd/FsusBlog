using System.Data.Common;

internal static partial class Migration
{
    private const string LegacyResponsibilityEventType = "responsibility-updated";
    private sealed record LegacyHistoricalResponsibility(long SnapshotId, int Version, long CurrentRevision, DateTime PublicUpdatedAt)
    {
        internal string SkipReason => FormattableString.Invariant($"superseded-by-revision:{CurrentRevision}");
    }

    private static async Task<Dictionary<long, LegacyHistoricalResponsibility>> ReadLegacyHistoricalResponsibilityAsync(
        LegacySource source, DbTransaction tx, Dictionary<string, LegacyTable> tables, LegacyTable events, CancellationToken ct)
    {
        // Frozen v1 historical save keeps the active publication's rights and clock but emits no release coordinate.
        await using var query = CreateLegacyCommand(tx, $"""
            SELECT e.id,h.id,h.responsibility_version,p3.article_revision_id,
                {SelectRepresentableLegacyOutboxClock("p3.published_at")}
            FROM {source.Table(events)} e
            JOIN {source.Table(tables[Article])} a ON a.id=e.aggregate_id
            JOIN {source.Table(tables[Publication])} p3 ON p3.id=a.current_publication_id
                AND p3.article_id=a.id AND p3.article_revision_id=a.current_revision_id
                AND p3.revision_no=3 AND p3.publication_no=3 AND p3.transition_kind='rollback'
                AND p3.rights_snapshot_id=e.rights_snapshot_id AND p3.published_at=a.public_updated_at
            JOIN {source.Table(tables[Publication])} historical ON historical.article_id=a.id AND historical.publication_no=2
                AND historical.revision_no=2 AND historical.article_revision_id=e.article_revision_id
                AND historical.transition_kind='immediate-publish' AND historical.responsibility_snapshot_id IS NULL
            JOIN {source.Table(tables[Responsibility])} h ON h.id=e.responsibility_snapshot_id
                AND h.article_id=a.id AND h.article_revision_id=e.article_revision_id AND h.revision_no=2
                AND h.responsibility_version=e.responsibility_version AND h.created_at=e.created_at
            LEFT JOIN {source.Table(tables[Responsibility])} prior ON prior.id=h.previous_snapshot_id
                AND prior.article_id=h.article_id AND prior.article_revision_id=h.article_revision_id
                AND prior.revision_no=2 AND prior.responsibility_version=1 AND prior.previous_snapshot_id IS NULL
            WHERE e.event_type='{LegacyResponsibilityEventType}' AND e.schema_version=2 AND e.status='processed'
                AND e.article_publication_id IS NULL AND e.publication_no IS NULL AND e.revision_no=2
                AND e.retry_count=0 AND e.next_retry_at=e.created_at AND e.processed_at<=statement_timestamp()
                AND a.status=2 AND NOT a.isdeleted AND p3.published_at<e.created_at
                AND ((h.responsibility_version=1 AND h.previous_snapshot_id IS NULL) OR
                     (h.responsibility_version=2 AND prior.created_at>p3.published_at AND prior.created_at<h.created_at))
            ORDER BY e.id LIMIT 3
            """);
        var entries = new Dictionary<long, LegacyHistoricalResponsibility>();
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
        {
            if (entries.Count == 2 || rows.IsDBNull(4)) return [];
            entries.Add(rows.GetInt64(0), new(rows.GetInt64(1), rows.GetInt32(2), rows.GetInt64(3), rows.GetDateTime(4)));
        }
        return entries;
    }
}
