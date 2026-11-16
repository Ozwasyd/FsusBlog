using System.Text;
using System.Text.Json;
using Npgsql;

internal static partial class Migration
{
    // Independent cryptographic/relational witness, not an ImportPlan or admission decision.
    private sealed record LegacyCustodyCoordinate(int ArticleId, long PublicationId, int PublicationNumber,
        long RevisionId, int RevisionNumber, long RightsSnapshotId, DateTime PublishedAt, DateTime? RetiredAt,
        DateTime ArticleIssuedAt, string PolicyHash, string ContentHash, bool RightsBinding,
        long CurrentPublicationId);

    private static async Task<int> RunLegacyHistoryCustodyAsync(CancellationToken token)
    {
        try { return await VerifyLegacyHistoryCustodyAsync(token); }
        catch (Exception error) when (IsLegacyPublishProofError(error))
        {
            throw new InvalidOperationException("The history custody proof could not be verified.", error);
        }
    }

    private static Task<int> VerifyLegacyHistoryCustodyAsync(CancellationToken token) => RunBoundedLegacyOperationAsync(token, 8,
        "The history custody read exceeded its budget.", "The history custody source rejected the read", async ct =>
    {
        var source = ParseLegacySource("postgres");
        await using var db = source.Connection;
        await db.OpenAsync(ct);
        await using var tx = await BeginLegacyReadAsync(db, ct);
        var catalog = await ReadLegacyCatalogAsync(source, tx, ct);
        var (tables, blockers) = SelectLegacyTables(source, catalog);
        if (blockers.Count != 0) throw new FormatException("Incomplete source catalog.");
        var keysBytes = await ReadLegacyProofFileAsync(LegacyProofKeyInput, ct) ?? throw new FormatException("Reviewed keys required.");
        var keys = ReadLegacyPublishProofKeys(keysBytes);
        var publications = new Dictionary<long, LegacyCustodyCoordinate>();
        var graphs = new List<string>();
        await using (var query = CreateLegacyCommand(tx, $"""
            SELECT p.article_id,p.id,p.publication_no,p.article_revision_id,p.revision_no,p.rights_snapshot_id,
                p.published_at,n.published_at,a.published_at,s.policy_hash,s.content_canonical_hash,s.proof_binding_enabled,
                CASE WHEN a.id IS NOT NULL AND r.id IS NOT NULL AND s.id IS NOT NULL
                    AND p.tableoid=to_regclass(@publications) AND a.tableoid=to_regclass(@articles)
                    AND r.tableoid=to_regclass(@revisions) AND s.tableoid=to_regclass(@snapshots)
                    AND octet_length(row_to_json(p)::text)+octet_length(row_to_json(s)::text)<=16384
                    THEN json_build_array(row_to_json(p),row_to_json(s),a.current_publication_id,a.published_at)::text END,
                a.current_publication_id
            FROM {source.Table(tables[Publication])} p
            LEFT JOIN {source.Table(tables[Article])} a ON a.id=p.article_id
            LEFT JOIN {source.Table(tables[Revision])} r ON r.id=p.article_revision_id AND r.article_id=p.article_id AND r.revision_no=p.revision_no
            LEFT JOIN {source.Table(tables[RightsSnapshot])} s ON s.id=p.rights_snapshot_id AND s.article_id=p.article_id
                AND s.article_revision_id=p.article_revision_id AND s.revision_no=p.revision_no
            LEFT JOIN {source.Table(tables[Publication])} n ON n.article_id=p.article_id AND n.publication_no=p.publication_no+1
            ORDER BY p.article_id,p.publication_no LIMIT 7
            """))
        {
            foreach (var (name, table) in new[] { ("publications", Publication), ("articles", Article), ("revisions", Revision), ("snapshots", RightsSnapshot) })
            {
                var parameter = query.CreateParameter(); parameter.ParameterName = name; parameter.Value = source.Table(tables[table]);
                query.Parameters.Add(parameter);
            }
            await using var rows = await query.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                if (publications.Count == 6 || rows.IsDBNull(12) || rows.IsDBNull(13)) throw new FormatException("Unsupported publication graph.");
                var item = new LegacyCustodyCoordinate(rows.GetInt32(0), rows.GetInt64(1), rows.GetInt32(2), rows.GetInt64(3),
                    rows.GetInt32(4), rows.GetInt64(5), rows.GetDateTime(6), rows.IsDBNull(7) ? null : rows.GetDateTime(7),
                    rows.GetDateTime(8), rows.GetString(9), rows.GetString(10), rows.GetBoolean(11), rows.GetInt64(13));
                if (item.ArticleId <= 0 || item.PublicationId <= 0 || item.PublicationNumber is < 1 or > 3 ||
                    item.RevisionId <= 0 || item.RevisionNumber is < 1 or > 3 || item.RightsSnapshotId <= 0 ||
                    item.RetiredAt <= item.PublishedAt || !publications.TryAdd(item.RevisionId, item)) throw new FormatException();
                graphs.Add(rows.GetString(12));
            }
        }
        if (publications.Count == 0 || publications.Values.Select(p => p.ArticleId).Distinct().Count() > 3 ||
            publications.Values.Select(p => (p.ArticleId, p.PublicationNumber)).Distinct().Count() != publications.Count)
            throw new FormatException();
        // Missing successor numbers are not evidence of an active publication.
        // Establish the complete per-article sequence and current pointer first.
        foreach (var article in publications.Values.GroupBy(p => p.ArticleId))
        {
            var history = article.OrderBy(p => p.PublicationNumber).ToArray();
            var current = history[^1];
            for (var index = 0; index < history.Length; index++)
            {
                var item = history[index];
                DateTime? retirement = index + 1 < history.Length ? history[index + 1].PublishedAt : null;
                if (item.PublicationNumber != index + 1 || item.CurrentPublicationId != current.PublicationId ||
                    item.RetiredAt != retirement ||
                    item.ArticleIssuedAt != history[0].PublishedAt)
                    throw new FormatException("Publication history is not contiguous or does not bind the current article pointer.");
            }
        }
        var publishRows = await ReadRows(LegacyPublishProofShape, 6);
        var rightsRows = await ReadRows(LegacyRightsProofShape, 3);
        if (publishRows.Length != publications.Count || rightsRows.Length == 0) throw new FormatException();
        var seen = new HashSet<long>();
        foreach (var row in publishRows)
        {
            var raw = ParseLegacyTransparencyRecord(row);
            if (!publications.TryGetValue(LegacyJsonInt(raw, "article_revision_id"), out var graph))
                throw new FormatException("Publication proof has no source publication coordinates.");
            var verified = VerifyLegacyPublishProof(Encoding.UTF8.GetBytes(row), keys);
            if (!seen.Add(verified.RevisionId) || verified.ArticleId != graph.ArticleId || verified.Revision != graph.RevisionNumber ||
                "sha256:" + verified.Hash != graph.ContentHash || LegacyLogTime(raw, "published_at").DateTime != graph.ArticleIssuedAt)
                throw new FormatException("Publication proof does not bind its source coordinates.");
        }
        var transparency = await ReadLegacyTransparencySourceAsync(source, tx, catalog, publishRows.Length + rightsRows.Length, ct)
            ?? throw new FormatException("A complete pinned checkpoint is required.");
        var entries = VerifyLegacyTransparencyRows(publishRows, rightsRows, transparency, keys);
        if (entries.Count != publishRows.Length + rightsRows.Length) throw new FormatException();
        var witnesses = new List<object>();
        seen.Clear();
        foreach (var raw in rightsRows)
        {
            var proof = ParseLegacyTransparencyRecord(raw);
            if (!publications.TryGetValue(LegacyJsonInt(proof, "article_revision_id"), out var graph))
                throw new FormatException("Rights proof has no source publication coordinates.");
            var parent = LegacyRightsProofParent(publishRows, proof);
            var payload = VerifyLegacyRightsProof(proof, parent, keys);
            if (!entries.TryGetValue((LegacyRightsProofKind, graph.RevisionId), out var log))
                throw new FormatException("Rights proof has no matching transparency entry.");
            var appended = LegacyLogTime(ParseLegacyTransparencyRecord(Encoding.UTF8.GetString(log.SourceRow)), "created_at").DateTime;
            var created = LegacyLogTime(proof, "created_at").DateTime;
            var updated = LegacyLogTime(proof, "updated_at").DateTime;
            if (!seen.Add(graph.RevisionId) || !graph.RightsBinding || LegacyJsonInt(proof, "article_id") != graph.ArticleId ||
                LegacyJsonInt(proof, "revision_no") != graph.RevisionNumber || LegacyJsonInt(proof, "article_rights_snapshot_id") != graph.RightsSnapshotId ||
                graph.PolicyHash != "sha256:" + RequiredProofText(proof, "rights_policy_hash") ||
                graph.ContentHash != "sha256:" + RequiredProofText(proof, "content_canonical_hash") ||
                created < graph.PublishedAt || appended < updated || updated >= graph.RetiredAt || appended >= graph.RetiredAt)
                throw new FormatException("Rights proof does not bind its source lifetime.");
            witnesses.Add(new { coordinates = graph, sourceRowSha256 = Digest(raw), signedPayloadSha256 = DigestBytes(payload),
                parentSourceRowSha256 = Digest(parent.GetRawText()), logSourceRowSha256 = DigestBytes(log.SourceRow) });
        }
        await tx.RollbackAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            format = "fsusblog-legacy-history-custody-v1", sourceSchema = source.Schema,
            keysSha256 = DigestBytes(keysBytes), checkpointSha256 = Digest(transparency.Checkpoint),
            publicationGraphSha256 = DigestMediaDocument(graphs), publicationRowsSha256 = DigestMediaDocument(publishRows),
            rightsRowsSha256 = DigestMediaDocument(rightsRows), witnesses,
            custodyVerified = true, outboxVerified = false, readyToStage = false, readyToApply = false
        }, Json));
        return 0;

        async Task<string[]> ReadRows(LegacyOutboxDefinition definition, int limit)
        {
            var relation = catalog.SingleOrDefault(t => t.Name == definition.Source);
            if (relation is not { Kind: "r" } || !relation.Columns.ToHashSet().SetEquals(definition.Fields) ||
                !await HasLegacyJournalCatalogAsync(tx, source.Schema, relation.Name, definition.Table, ct)) throw new FormatException();
            var table = source.Table(relation);
            await using var query = CreateLegacyCommand(tx, $"""
                SELECT CASE WHEN p.tableoid=to_regclass(@relation) AND octet_length(row_to_json(p)::text)<=8192
                    THEN row_to_json(p)::text END FROM {table} p ORDER BY p.id LIMIT {limit + 1}
                """);
            var parameter = query.CreateParameter(); parameter.ParameterName = "relation"; parameter.Value = table; query.Parameters.Add(parameter);
            await using var rows = await query.ExecuteReaderAsync(ct);
            var result = new List<string>();
            while (await rows.ReadAsync(ct))
            {
                if (rows.IsDBNull(0) || result.Count == limit) throw new FormatException();
                result.Add(rows.GetString(0));
            }
            return result.ToArray();
        }
    });

    private static string DigestBytes(byte[] value) => Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(value));
}
