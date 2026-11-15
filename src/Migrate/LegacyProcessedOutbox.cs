using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;

internal static partial class Migration
{
    private const string LegacyOutboxSource = "article_mutation_outbox";
    private const string LegacyOutboxEdgeSource = "article_mutation_outbox_edge";
    private const int LegacyOutboxMaxPayloadBytes = 16 * 1024;
    private const int LegacyOutboxTotalPayloadBytes = 32 * 1024 * 1024;
    private const int LegacyOutboxMaxEdges = RehearsalLimit * 9;

    private static readonly string[] LegacyRequiredOutboxEdges =
    [
        "public-aot-invalidation", "http-cache-invalidation", "search-projection", "article-detail-aeds",
        "taxonomy-projection", "public-artifact-revocation", "public-hot-read"
    ];
    private static readonly HashSet<string> LegacyKnownOutboxEdges =
        [.. LegacyRequiredOutboxEdges, "integrity-proof", "notification"];

    private static readonly LegacyOutboxDefinition LegacyOutboxParent = OutboxDefinition(LegacyOutboxSource, """
        id/bigint event_id/varchar(36) aggregate_type/varchar(32) aggregate_id/integer schema_version/integer
        article_revision_id/bigint? revision_no/integer? rights_snapshot_id/bigint? responsibility_snapshot_id/bigint?
        responsibility_version/integer? article_publication_id/bigint? publication_no/integer? event_type/varchar(64)
        payload_json/text status/varchar(24) retry_count/integer next_retry_at/timestamp created_at/timestamp
        processed_at/timestamp? last_error/varchar(1024)? claim_token/varchar(64)? claimed_by/varchar(128)?
        claimed_at/timestamp? heartbeat_at/timestamp? claim_expires_at/timestamp?
        """, ["event_id"]);
    private static readonly LegacyOutboxDefinition LegacyOutboxEdge = OutboxDefinition(LegacyOutboxEdgeSource, """
        id/bigint outbox_event_id/bigint edge_name/varchar(64) status/varchar(24) attempt_count/integer
        last_error/varchar(1024)? updated_at/timestamp delivery_key/varchar(64)?
        """, ["outbox_event_id", "edge_name"]);

    private sealed record LegacyOutboxDefinition(string Source, CandidateTable Table, LegacyField[] Fields);
    private sealed record LegacyOutboxEntry(CandidateTable Table, LegacyProjection Projection, object?[][] Rows);
    private sealed record LegacyOutboxRead(LegacyTable[] Relations, LegacyOutboxEntry[] Entries, ImportFinding[] Findings,
        int RepublishCount = 0, int RollbackCount = 0, LegacyRightsDelivery[]? RightsDeliveries = null);
    private sealed record LegacyRightsDelivery(int PublicationNumber, DateTime CreatedAt, DateTime? RetiredAt);
    private sealed record LegacyTerminalEvent(string EventId, int Article, long? PublicationId, DateTime CreatedAt,
        DateTime ProcessedAt, bool ExactDatabaseClock, LegacyPublishedOutboxUpdate? Update, object?[] Values, HashSet<string> Edges,
        LegacyHistoricalResponsibility? History, LegacyRightsDelivery? RightsDelivery)
    {
        internal int PublicationNumber => Update?.PublicationNumber ?? 1;
    }

    private static readonly string[] LegacyOutboxUnsettledStates = ["pending", "processing", "poison"];
    private static readonly string[] LegacyOutboxSensitiveFields =
        ["last_error", "claim_token", "claimed_by", "claimed_at", "heartbeat_at", "claim_expires_at"];

    private static LegacyOutboxDefinition OutboxDefinition(string source, string shape, string[] unique)
    {
        var fields = new List<LegacyField>();
        var columns = new List<CandidateColumn>();
        var required = new List<string>();
        foreach (var item in shape.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
        {
            var split = item.IndexOf('/');
            var name = item[..split];
            var type = item[(split + 1)..];
            if (type.EndsWith('?')) type = type[..^1];
            else required.Add(name);
            var physical = type switch
            {
                "timestamp" => "timestamp without time zone",
                _ when type.StartsWith("varchar", StringComparison.Ordinal) => "character varying" + type[7..],
                _ => type
            };
            fields.Add(new LegacyField(name, physical));
            columns.Add(new CandidateColumn(name, type is "bigint" or "integer" ? "INTEGER" : "TEXT"));
        }
        var table = new CandidateTable("shadow_" + source, 3, "id", columns.ToArray(), unique, required.ToArray());
        return new LegacyOutboxDefinition(source, table, fields.ToArray());
    }

    private static CandidateTable[] OptionalLegacyCommandDefinition(ImportPlan plan)
    {
        if (plan.SourceProjections.Any(row => row.Table == LegacyCreateCommandSource) ||
            plan.ExpectedTables.Any(row => row.Table == LegacyCreateCommandShadow.Name))
            return HasCompleteLegacyCommandPlan(plan) ? [LegacyCreateCommandShadow] :
                throw new InvalidOperationException("The legacy outbox plan contains incomplete create-command coordinates.");
        return [];
    }

    private static bool HasCompleteLegacyOutboxPlan(ImportPlan plan) =>
        CompleteLegacyOutboxPlanEntry(plan, LegacyOutboxParent, RehearsalLimit) &&
        CompleteLegacyOutboxPlanEntry(plan, LegacyOutboxEdge, LegacyOutboxMaxEdges);

    // Source and target hash formats use distinct relation names and bind the same positive cardinalities.
    private static bool CompleteLegacyOutboxPlanEntry(ImportPlan plan, LegacyOutboxDefinition definition, int limit) =>
        plan.SourceProjections?.Where(row => row.Table == definition.Source).ToArray() is [var source] &&
        plan.ExpectedTables?.Where(row => row.Table == definition.Table.Name).ToArray() is [var target] &&
        source.Rows is >= 1 && source.Rows <= limit && source.Rows == target.Rows && IsSha256(source.Sha256) && IsSha256(target.Sha256);

    private static async Task<LegacyOutboxRead> ReadLegacyProcessedOutboxAsync(LegacySource source, DbTransaction tx,
        LegacyTable[] catalog, Dictionary<string, LegacyTable> tables, LegacyTable principals, CancellationToken ct)
    {
        if (source.Provider != "postgres") return new LegacyOutboxRead([], [], []);
        var parents = catalog.Where(table => table.Name.Equals(LegacyOutboxSource, StringComparison.OrdinalIgnoreCase)).ToArray();
        var edges = catalog.Where(table => table.Name.Equals(LegacyOutboxEdgeSource, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (parents.Length == 0 && edges.Length == 0) return new LegacyOutboxRead([], [], []);
        LegacyTable[] relations = [.. parents, .. edges];
        var findings = new List<ImportFinding>();
        var parentsKnown = await KnownOutboxShapeAsync(parents, LegacyOutboxParent);
        var edgesKnown = await KnownOutboxShapeAsync(edges, LegacyOutboxEdge);
        if (!parentsKnown || !edgesKnown)
            return new LegacyOutboxRead(relations, [], findings.ToArray());

        var updateEvidence = await ReadLegacyOrdinaryRepublishAsync(source, tx, tables, principals, parents[0], ct);
        var rollbacks = await ReadLegacyPublishedRollbackOutboxAsync(source, tx, tables, principals, parents[0], ct);
        var history = rollbacks.Count == 1
            ? await ReadLegacyHistoricalResponsibilityAsync(source, tx, tables, parents[0], ct) : [];
        foreach (var pair in rollbacks)
            updateEvidence.Add(pair.Key, pair.Value);
        var events = await ReadLegacyTerminalEventsAsync(source, tx, tables, parents[0], updateEvidence, history, findings, ct);
        var edgeRows = await ReadLegacyTerminalEdgesAsync(source, tx, edges[0], events, findings, ct);
        int incomplete = events.Values.Count(item => item.History is null
            ? !item.Edges.IsSupersetOf(LegacyRequiredOutboxEdges)
            : !item.Edges.SetEquals(LegacyKnownOutboxEdges));
        if (incomplete > 0) findings.Add(new ImportFinding("legacy-outbox-missing-required-edge", LegacyOutboxSource, incomplete));
        var historyEvents = events.Values.Where(item => item.History is not null).OrderBy(item => item.History!.Version).ToArray();
        if (historyEvents.Where((item, index) => item.History!.Version != index + 1 ||
                item.History.PreviousSnapshotId != (index == 0 ? null : historyEvents[index - 1].History!.SnapshotId) ||
                index > 0 && item.CreatedAt <= historyEvents[index - 1].CreatedAt).Any())
            findings.Add(new ImportFinding("legacy-outbox-responsibility-history", LegacyOutboxSource, historyEvents.Length));
        var rightsEvents = events.Values.Where(item => item.RightsDelivery is not null).ToArray();
        var rightsDeliveries = rightsEvents.Select(item => item.RightsDelivery!).ToArray();
        var byNumber = events.Values.Where(item => item.History is null && item.RightsDelivery is null)
            .ToDictionary(item => (item.Article, item.PublicationNumber));
        if (rightsDeliveries.Select(item => item.PublicationNumber).Distinct().Count() != rightsDeliveries.Length ||
            rightsEvents.Where((item, i) =>
                !item.Edges.SetEquals(LegacyKnownOutboxEdges.Where(edge => edge != "integrity-proof")) ||
                !byNumber.TryGetValue((item.Article, rightsDeliveries[i].PublicationNumber), out var original) ||
                original.PublicationId != item.PublicationId || original.CreatedAt >= item.CreatedAt ||
                original.ProcessedAt >= rightsDeliveries[i].RetiredAt || !original.Edges.SetEquals(LegacyKnownOutboxEdges)).Any())
            findings.Add(new ImportFinding("legacy-outbox-rights-proof", LegacyOutboxSource, rightsEvents.Length));
        var updates = events.Values.Where(item => item.Update is not null).ToArray();
        int missingPredecessors = updates.Count(update =>
        {
            var evidence = update.Update!;
            var prior = evidence.PublicationNumber - 1;
            return !byNumber.TryGetValue((update.Article, prior), out var previous) || prior == 1 && !previous.ExactDatabaseClock ||
                previous.PublicationId != evidence.PreviousReleaseId || previous.CreatedAt != evidence.PreviousReleaseAt ||
                !previous.Edges.IsSupersetOf(LegacyRequiredOutboxEdges);
        });
        if (missingPredecessors > 0) findings.Add(new ImportFinding("legacy-outbox-predecessor", LegacyOutboxSource, missingPredecessors));
        if (findings.Count != 0 || events.Count == 0) return new LegacyOutboxRead(relations, [], findings.ToArray());

        return new LegacyOutboxRead(relations,
            [MakeOutboxEntry(LegacyOutboxParent, events.Values.Select(item => item.Values).ToArray()),
             MakeOutboxEntry(LegacyOutboxEdge, edgeRows)], [], updates.Count(item => item.PublicationNumber == 2),
            updates.Count(item => item.PublicationNumber == 3), rightsDeliveries);

        async Task<bool> KnownOutboxShapeAsync(LegacyTable[] selection, LegacyOutboxDefinition definition)
        {
            if (selection is [var relation] && relation.Name == definition.Source && relation.Kind == "r" &&
                relation.Columns.ToHashSet().SetEquals(definition.Fields) &&
                await HasLegacyJournalCatalogAsync(tx, source.Schema, relation.Name, definition.Table, ct)) return true;
            findings.Add(new ImportFinding("legacy-outbox-catalog", definition.Source, 1));
            return false;
        }
    }

    private static LegacyOutboxEntry MakeOutboxEntry(LegacyOutboxDefinition definition, object?[][] rows)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(hash, definition.Source);
        foreach (var field in definition.Fields) AppendLegacyValue(hash, field.Name);
        foreach (var row in rows)
            foreach (var value in row) AppendLegacyValue(hash, value);
        return new LegacyOutboxEntry(definition.Table,
            new LegacyProjection(definition.Source, rows.Length, Convert.ToHexStringLower(hash.GetHashAndReset())), rows);
    }

    private static object?[] LegacyOutboxValues(DbDataReader reader, int columns)
    {
        var result = new object?[columns];
        for (int index = 0; index < columns; index++)
        {
            result[index] = reader.GetValue(index) switch
            {
                DBNull => null,
                DateTime timestamp => DateTime.SpecifyKind(timestamp, DateTimeKind.Unspecified).ToString("O", CultureInfo.InvariantCulture),
                int narrow => (long)narrow,
                var value => value
            };
        }
        return result;
    }

    private static async Task<SortedDictionary<long, LegacyTerminalEvent>> ReadLegacyTerminalEventsAsync(LegacySource source,
        DbTransaction tx, Dictionary<string, LegacyTable> tables, LegacyTable relation,
        Dictionary<long, LegacyPublishedOutboxUpdate> updateEvidence, Dictionary<long, LegacyHistoricalResponsibility> historyEvidence,
        List<ImportFinding> findings, CancellationToken ct)
    {
        string E(string name) => "e." + source.Field(relation, name);
        string A(string name) => "a." + source.Field(tables[Article], name);
        string R(string name) => "r." + source.Field(tables[Revision], name);
        string P(string name) => "p." + source.Field(tables[Publication], name);
        string S(string name) => "s." + source.Field(tables[RightsSnapshot], name);
        string H(string name) => "h." + source.Field(tables[Responsibility], name);
        string F(string name) => "f." + source.Field(tables[Responsibility], name);
        string N(string name) => "n." + source.Field(tables[Publication], name);
        var fields = LegacyOutboxParent.Fields;
        var projection = fields.Select(field => (field.Name switch
        {
            "last_error" or "claim_token" or "claimed_by" => $"CASE WHEN {E(field.Name)} IS NOT NULL THEN 'present'::text END",
            "payload_json" => $"CASE WHEN {source.Utf8Length(E(field.Name))}<={LegacyOutboxMaxPayloadBytes} THEN {E(field.Name)} END",
            "created_at" or "processed_at" or "next_retry_at" => SelectRepresentableLegacyOutboxClock(E(field.Name)),
            _ => E(field.Name)
        }) + " AS " + source.Quote(field.Name));
        await using var query = CreateLegacyCommand(tx, $"""
            SELECT {string.Join(',', projection)}, {R("categoryid")}, {R("tag_ids")},
                ({E("event_type")}<>'created' OR {A("createtime")}={E("created_at")}) AND {R("created_at")}={E("created_at")}
                AND {P("created_at")}={E("created_at")} AND {P("published_at")}={E("created_at")}
                AND ({P("transition_kind")}='immediate-publish' OR
                    ({E("event_type")}='updated' AND {P("transition_kind")}='rollback')) AND {S("created_at")}={E("created_at")}
                AND {P("responsibility_snapshot_id")} IS NOT DISTINCT FROM {E("responsibility_snapshot_id")}
                AND ({E("responsibility_snapshot_id")} IS NULL OR {H("id")} IS NOT NULL) AS exact_graph,
                CASE WHEN {E("event_type")}='{LegacyRightsProofEvent}' AND {P("revision_no")}={P("publication_no")}
                    AND {P("published_at")}<{E("created_at")} AND {A("status")}=2 AND NOT {A("isdeleted")}
                    AND {S("proof_binding_enabled")}
                    AND (({P("publication_no")}=3 AND {P("transition_kind")}='rollback'
                        AND {P("responsibility_snapshot_id")}={H("id")}
                        AND {A("current_publication_id")}={P("id")} AND {A("current_revision_id")}={R("id")}
                        AND {A("public_updated_at")}={P("published_at")})
                        OR ({P("publication_no")} IN (1,2) AND {P("transition_kind")}='immediate-publish'
                            AND {N("published_at")}>{E("processed_at")}
                            AND ({P("publication_no")}=2 OR {A("published_at")}={P("published_at")})
                            AND ({H("created_at")}<={E("created_at")}
                                OR ({P("publication_no")}=2 AND {E("responsibility_snapshot_id")} IS NULL))
                            AND {E("responsibility_snapshot_id")} IS NOT DISTINCT FROM COALESCE({P("responsibility_snapshot_id")}, (
                                SELECT {F("id")} FROM {source.Table(tables[Responsibility])} f
                                WHERE {F("article_id")}={A("id")} AND {F("article_revision_id")}={R("id")}
                                    AND {F("created_at")}<={E("created_at")}
                                ORDER BY {F("responsibility_version")} DESC,{F("id")} DESC LIMIT 1))))
                    THEN {SelectRepresentableLegacyOutboxClock(P("published_at"))} END,
                {SelectRepresentableLegacyOutboxClock(N("published_at"))}
            FROM {source.Table(relation)} e
            LEFT JOIN {source.Table(tables[Article])} a ON {A("id")}={E("aggregate_id")}
            LEFT JOIN {source.Table(tables[Revision])} r ON {R("id")}={E("article_revision_id")}
                AND {R("article_id")}={E("aggregate_id")} AND {R("revision_no")}={E("revision_no")}
            LEFT JOIN {source.Table(tables[Publication])} p ON {P("id")}={E("article_publication_id")}
                AND {P("article_id")}={E("aggregate_id")} AND {P("article_revision_id")}={E("article_revision_id")}
                AND {P("revision_no")}={E("revision_no")} AND {P("publication_no")}={E("publication_no")}
                AND {P("rights_snapshot_id")}={E("rights_snapshot_id")}
            LEFT JOIN {source.Table(tables[RightsSnapshot])} s ON {S("id")}={E("rights_snapshot_id")}
                AND {S("article_id")}={E("aggregate_id")} AND {S("article_revision_id")}={E("article_revision_id")}
                AND {S("revision_no")}={E("revision_no")}
            LEFT JOIN {source.Table(tables[Responsibility])} h ON {H("id")}={E("responsibility_snapshot_id")}
                AND {H("article_id")}={E("aggregate_id")} AND {H("article_revision_id")}={E("article_revision_id")}
                AND {H("revision_no")}={E("revision_no")} AND {H("responsibility_version")}={E("responsibility_version")}
            LEFT JOIN {source.Table(tables[Publication])} n ON {N("article_id")}={P("article_id")}
                AND {N("publication_no")}=CASE {P("publication_no")} WHEN 1 THEN 2 WHEN 2 THEN 3 END
                AND {N("revision_no")}={N("publication_no")}
                AND {E("event_type")}='{LegacyRightsProofEvent}'
            ORDER BY {E("id")} LIMIT {RehearsalLimit + 1}
            """);
        await using var reader = await query.ExecuteReaderAsync(ct);
        var clocks = new[] { "created_at", "processed_at", "next_retry_at" }.Select(reader.GetOrdinal).ToArray();
        var sensitive = LegacyOutboxSensitiveFields.Select(reader.GetOrdinal).ToArray();
        var statusIndex = reader.GetOrdinal("status");
        var accepted = new SortedDictionary<long, LegacyTerminalEvent>();
        var observedIds = new HashSet<long>();
        var eventIds = new HashSet<string>(StringComparer.Ordinal);
        var slots = new HashSet<(int Article, int Publication)>();
        var invalidState = 0;
        var invalidEnvelope = 0;
        var duplicateReleases = 0;
        var unsettled = new int[LegacyOutboxUnsettledStates.Length];
        long payloadBytes = 0;
        var count = 0;
        while (await reader.ReadAsync(ct))
        {
            if (++count > RehearsalLimit)
                throw new InvalidOperationException($"Legacy outbox event count exceeds the {RehearsalLimit}-row observation limit.");
            var status = reader.GetString(statusIndex);
            var unsettledIndex = Array.IndexOf(LegacyOutboxUnsettledStates, status);
            if (unsettledIndex >= 0)
            {
                unsettled[unsettledIndex]++;
                continue;
            }
            var id = reader.GetInt64(0);
            var eventId = reader.GetString(1);
            if (clocks.Any(reader.IsDBNull))
            {
                invalidState++;
                continue;
            }
            var created = reader.GetDateTime(clocks[0]);
            if (id <= 0 || !observedIds.Add(id) || !eventIds.Add(eventId) ||
                !Guid.TryParseExact(eventId, "N", out var guid) || guid == Guid.Empty || guid.ToString("N") != eventId ||
                reader.GetString(2) != "article" || status != "processed" || reader.GetInt32(15) < 0 ||
                reader.GetDateTime(clocks[1]) < created || reader.GetDateTime(clocks[2]) < created || !sensitive.All(reader.IsDBNull))
            {
                invalidState++;
                continue;
            }

            var shape = fields.Length;
            var article = reader.GetInt32(3);
            var eventType = reader.GetString(12);
            bool updated = eventType == "updated";
            var evidence = updateEvidence.GetValueOrDefault(id);
            var history = historyEvidence.GetValueOrDefault(id);
            var releaseId = reader.IsDBNull(10) ? (long?)null : reader.GetInt64(10);
            bool rightsProof = eventType == LegacyRightsProofEvent;
            var sourcePublicClock = reader.IsDBNull(shape + 3) ? (DateTime?)null : reader.GetDateTime(shape + 3);
            var expectedRelease = rightsProof && sourcePublicClock.HasValue ? reader.GetInt32(11) : evidence?.PublicationNumber ?? 1;
            var retiredAt = reader.IsDBNull(shape + 4) ? (DateTime?)null : reader.GetDateTime(shape + 4);
            var responsibility = reader.IsDBNull(8) ? (long?)null : reader.GetInt64(8);
            var responsibilityVersion = reader.IsDBNull(9) ? (int?)null : reader.GetInt32(9);
            var validGraph = history is not null
                ? eventType == LegacyResponsibilityEventType && releaseId is null && reader.IsDBNull(11) &&
                    responsibility == history.SnapshotId && responsibilityVersion == history.Version
                : rightsProof ? sourcePublicClock.HasValue && (expectedRelease == 3 || retiredAt.HasValue) && releaseId > 0 && reader.GetInt32(15) == 0 &&
                    reader.GetDateTime(clocks[2]) == created
                : eventType is ("created" or "updated") && releaseId > 0 && !reader.IsDBNull(11) &&
                    reader.GetInt32(11) == expectedRelease &&
                    (!updated || evidence is not null && (responsibility is not null) == (expectedRelease == 3)) &&
                    !reader.IsDBNull(shape + 2) && reader.GetBoolean(shape + 2);
            if (article <= 0 || reader.GetInt32(4) != 2 || !validGraph ||
                reader.IsDBNull(5) || reader.GetInt64(5) <= 0 || reader.IsDBNull(6) ||
                reader.GetInt32(6) != (history is null ? expectedRelease : 2) ||
                reader.IsDBNull(7) || reader.GetInt64(7) <= 0 ||
                (responsibility is null) != (responsibilityVersion is null) || responsibility is <= 0 || responsibilityVersion is <= 0 ||
                reader.IsDBNull(13) || reader.IsDBNull(shape) || reader.IsDBNull(shape + 1))
            {
                invalidEnvelope++;
                continue;
            }
            var payload = reader.GetString(13);
            payloadBytes += StrictUtf8.GetByteCount(payload);
            if (payloadBytes > LegacyOutboxTotalPayloadBytes)
                throw new InvalidOperationException("Legacy outbox envelopes exceed their cumulative observation byte budget.");
            var expectedTags = ParseLegacyOutboxTags(reader.GetString(shape + 1));
            if (!VerifyLegacyOutboxEnvelope(payload, article, reader.GetInt64(5), reader.GetInt64(7), responsibility,
                responsibilityVersion, releaseId, created, reader.GetInt32(shape), expectedTags, out var exactClock,
                evidence?.BeforeCategory, evidence?.BeforeTags, history is null ? expectedRelease : 2, expectedRelease, history, sourcePublicClock))
            {
                invalidEnvelope++;
                continue;
            }
            if (history is null && !rightsProof && !slots.Add((article, expectedRelease)))
            {
                duplicateReleases++;
                continue;
            }
            accepted.Add(id, new LegacyTerminalEvent(eventId, article, releaseId, created, reader.GetDateTime(clocks[1]),
                exactClock, evidence, LegacyOutboxValues(reader, shape), new HashSet<string>(StringComparer.Ordinal), history,
                rightsProof ? new(expectedRelease, created, retiredAt) : null));
        }

        if (invalidState > 0) findings.Add(new ImportFinding("legacy-outbox-state", relation.Name, invalidState));
        for (int i = 0; i < unsettled.Length; i++)
            if (unsettled[i] > 0) findings.Add(new ImportFinding("legacy-outbox-" + LegacyOutboxUnsettledStates[i], relation.Name, unsettled[i]));
        if (invalidEnvelope > 0) findings.Add(new ImportFinding("legacy-outbox-envelope", relation.Name, invalidEnvelope));
        if (duplicateReleases > 0) findings.Add(new ImportFinding("legacy-outbox-duplicate-release", relation.Name, duplicateReleases));
        return accepted;
    }

    private static string SelectRepresentableLegacyOutboxClock(string column) => $"""
        CASE WHEN {column} BETWEEN TIMESTAMP '0001-01-01 00:00:00' AND TIMESTAMP '9999-12-31 23:59:59.999999' THEN {column} END
        """;

    private static async Task<object?[][]> ReadLegacyTerminalEdgesAsync(LegacySource source, DbTransaction tx, LegacyTable relation,
        SortedDictionary<long, LegacyTerminalEvent> events, List<ImportFinding> findings, CancellationToken ct)
    {
        var fields = LegacyOutboxEdge.Fields;
        var projection = fields.Select(field =>
        {
            var column = "x." + source.Field(relation, field.Name);
            return field.Name switch
            {
                "last_error" => $"CASE WHEN parent.event_type='{LegacyResponsibilityEventType}' AND octet_length({column})<=64 THEN {column} " +
                    $"WHEN {column} IS NOT NULL THEN 'present'::text END",
                "updated_at" => SelectRepresentableLegacyOutboxClock(column),
                _ => column
            };
        });
        await using var query = CreateLegacyCommand(tx, $"""
            SELECT {string.Join(',', projection)}, parent.id IS NOT NULL
            FROM {source.Table(relation)} x
            LEFT JOIN {source.Quote(source.Schema)}.{source.Quote(LegacyOutboxSource)} parent ON parent.id=x.outbox_event_id
            ORDER BY x.id LIMIT {LegacyOutboxMaxEdges + 1}
            """);
        await using var reader = await query.ExecuteReaderAsync(ct);
        var rows = new List<object?[]>();
        var observedIds = new HashSet<long>();
        var invalid = 0;
        var orphan = 0;
        var count = 0;
        while (await reader.ReadAsync(ct))
        {
            if (++count > LegacyOutboxMaxEdges)
                throw new InvalidOperationException($"Legacy outbox edge count exceeds the {LegacyOutboxMaxEdges}-row observation limit.");
            if (!reader.GetBoolean(fields.Length))
            {
                orphan++;
                continue;
            }
            if (!events.TryGetValue(reader.GetInt64(1), out var parent)) continue;
            var id = reader.GetInt64(0);
            var edge = reader.GetString(2);
            var terminal = parent.History is { } history
                ? reader.GetString(3) == "skipped" && reader.GetInt32(4) == 1 && !reader.IsDBNull(5) &&
                    reader.GetString(5) == history.SkipReason
                : reader.GetString(3) == "completed" && reader.GetInt32(4) > 0 && reader.IsDBNull(5);
            if (id <= 0 || !observedIds.Add(id) || !LegacyKnownOutboxEdges.Contains(edge) || !terminal || reader.IsDBNull(7) ||
                reader.GetString(7) != Digest(parent.EventId + ":" + edge) || reader.IsDBNull(6) ||
                reader.GetDateTime(6) < parent.CreatedAt || reader.GetDateTime(6) > parent.ProcessedAt || !parent.Edges.Add(edge))
            {
                invalid++;
                continue;
            }
            rows.Add(LegacyOutboxValues(reader, fields.Length));
        }

        if (invalid > 0) findings.Add(new ImportFinding("legacy-outbox-edge", relation.Name, invalid));
        if (orphan > 0) findings.Add(new ImportFinding("legacy-outbox-orphan-edge", relation.Name, orphan));
        return rows.ToArray();
    }

    private static Task WriteLegacyOutboxShadowAsync(DbTransaction tx, LegacyOutboxEntry entry, CancellationToken ct)
    {
        var table = entry.Table;
        return WriteLegacyShadowRowsAsync(tx, table, $"""
            CREATE TABLE {table.Name} ({LegacyShadowColumns(table)}, PRIMARY KEY (id),
                UNIQUE ({string.Join(',', table.Unique!)})) STRICT
            """, entry.Rows, ct);
    }

    private static Task<ShadowCount> VerifyLegacyOutboxShadowAsync(DbTransaction tx, LegacyOutboxEntry entry,
        CancellationToken ct) => VerifyLegacyShadowRowsAsync(tx, entry.Table, entry.Rows,
            "A legacy outbox shadow value changed.", "Legacy outbox shadow has additional rows.", ct,
            missing: "Legacy outbox shadow rows are missing.", columnMismatch: "A legacy outbox shadow column changed.");
}
