using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private sealed record LegacyReleaseOrigin(BackupRelation Measurement, string Rows);

    private static async Task<LegacyReleaseOrigin> ReadLegacyReleaseOriginAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        string planSha, string projectionSha, string actorsSha, CancellationToken ct)
    {
        var disclosure = await ReadLegacyResponsibilityDisclosuresAsync(db, tx, ct);
        await using var query = new NpgsqlCommand($$"""
            SELECT CASE WHEN octet_length(row_to_json(t)::text)<=131072 THEN row_to_json(t)::text END
            FROM (
                SELECT p.article_id::int,p.revision,p.source_publication_id AS publication_id,
                    r.source_revision_id,r.source_admin_id AS source_actor_id,r.source_rollback_revision_id,
                    r.source_rollback_reason AS rollback_reason,to_jsonb(s) AS responsibility,
                    jsonb_build_object('publication',to_jsonb(p),'rights',to_jsonb(rights),'event',to_jsonb(event),
                        'edges',(SELECT jsonb_agg(to_jsonb(edge) ORDER BY edge.id)
                            FROM {{ImportSchema}}.{{LegacyOutboxEdge.Table.Name}} edge WHERE edge.outbox_event_id=event.id)) AS evidence,
                    jsonb_strip_nulls(jsonb_build_object('schemaVersion',1,'articleId',p.article_id,'revisionNo',p.revision,
                        'responsibilitySnapshotId',s.id::text,'responsibilityVersion',coalesce(s.responsibility_version,0),
                        'inheritsSiteAuthor',coalesce(s.inherit_site_author=1,true),'legacyFallback',s.id IS NULL,
                        'responsiblePersonConfirmed',coalesce(s.responsible_person_confirmed=1,false),'verification',
                        jsonb_build_object('url',format('/integrity/article/%s/revisions/%s',p.article_id,p.revision),
                            'revisionNo',p.revision,'proofStatus','unavailable'))
                        || CASE WHEN s.id IS NULL THEN
                            '{"authors":[{"name":"{{LegacyDefaultSiteAuthor}}"}],"sources":[]}'::jsonb
                            ELSE $4::jsonb -> s.id::text END) AS manifest,
                    $1::text AS plan_sha256,$2::text AS projection_sha256,$3::text AS source_admin_identity_sha256
                FROM {{ImportSchema}}.shadow_publication p
                JOIN {{ImportSchema}}.shadow_revision r ON r.source_revision_id=p.source_revision_id AND r.article_id=p.article_id
                JOIN {{ImportSchema}}.shadow_article_rights_snapshot rights ON rights.id=p.source_rights_snapshot_id
                JOIN {{ImportSchema}}.{{LegacyOutboxParent.Table.Name}} event ON event.article_publication_id=p.source_publication_id
                LEFT JOIN LATERAL (
                    SELECT h.* FROM {{ImportSchema}}.shadow_article_responsibility_snapshot h
                    WHERE h.article_id=p.article_id AND h.article_revision_id=p.source_revision_id
                        AND (p.source_responsibility_snapshot_id IS NULL OR h.id=p.source_responsibility_snapshot_id)
                    ORDER BY h.responsibility_version DESC LIMIT 1
                ) s ON true
                WHERE (p.revision=2 AND s.id IS NULL) OR
                    (p.revision IN (1,3) AND s.id IS NOT NULL AND s.responsibility_version=1 AND s.previous_snapshot_id IS NULL)
            ) t ORDER BY article_id,revision
            """, db, tx);
        query.Parameters.AddWithValue(planSha);
        query.Parameters.AddWithValue(projectionSha);
        query.Parameters.AddWithValue(actorsSha);
        query.Parameters.AddWithValue(disclosure);
        await using var reader = await query.ExecuteReaderAsync(ct);
        var rows = new List<string>(3);
        var measurement = await MeasureBackupRowsAsync("legacy_release_origin", "r", reader, ct, rows);
        if (measurement.Rows != 3)
            throw new InvalidOperationException("Legacy rollback responsibility cannot be mapped to the supported public manifest.");
        return new(measurement, "[" + string.Join(',', rows) + "]");
    }
}
