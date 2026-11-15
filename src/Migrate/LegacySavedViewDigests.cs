using System.Globalization;
using System.Security.Cryptography;
using Npgsql;

internal static partial class Migration
{
    private sealed record LegacySavedViewDigests(int Queries, int OwnerSiteViews, int Collections, ImportFinding? Finding = null);

    private static readonly string[] SavedViewDigestRelations =
        ["_collection", "", "_condition", "_condition_value", "_projection", "_receipt"];

    // The fixed v1 store hashes its persisted query order, rather than interpreting the operands or replaying the query.
    private static LegacySavedViewDigests VerifyLegacySavedViewDigests(IReadOnlyDictionary<string, object?[][]> data)
    {
        object?[][] Rows(string suffix) => data[LegacySavedViewPrefix + suffix];
        var views = Rows("");
        var conditions = Rows("_condition").ToLookup(row => (string)row[0]!);
        var operands = Rows("_condition_value").ToLookup(row => ((string)row[0]!, (long)row[1]!));
        var projections = Rows("_projection").ToLookup(row => (string)row[0]!);
        var receipts = Rows("_receipt").ToLookup(row => ((long)row[2]!, (string)row[3]!));
        LegacySavedViewDigests Invalid(string problem) => new(0, 0, 0, new("legacy-saved-views-" + problem, LegacySavedViewPrefix, 1));

        foreach (var view in views)
        {
            var id = (string)view[0]!;
            var viewConditions = conditions[id].ToArray();
            var viewProjection = projections[id].ToArray();
            using var query = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            AppendSavedViewV1(query, view[3], viewConditions.Length); // schema version, condition count
            for (var index = 0; index < viewConditions.Length; index++)
            {
                var condition = viewConditions[index];
                if ((long)condition[1]! != index) return Invalid("query-order");
                var values = operands[(id, index)].ToArray();
                AppendSavedViewV1(query, condition[2], condition[3], condition[4], condition[5], values.Length);
                for (var position = 0; position < values.Length; position++)
                {
                    if ((long)values[position][2]! != position) return Invalid("query-order");
                    AppendSavedViewV1(query, values[position][3]);
                }
            }
            AppendSavedViewV1(query, view[9..16]); // primary sort, null placement, collation, timezone and tie breaker
            AppendSavedViewV1(query, viewProjection.Length);
            for (var index = 0; index < viewProjection.Length; index++)
            {
                var field = viewProjection[index];
                if ((long)field[1]! != index) return Invalid("query-order");
                AppendSavedViewV1(query, field[2], field[3]);
            }
            AppendSavedViewV1(query, view[16]); // page size
            if (FinishSourceSeal(query) != (string)view[7]!) return Invalid("query-digest");

            using var content = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            if (view[17] is not (0L or 1L)) return Invalid("view-digest");
            // ComputeViewDigest binds the current query to the original administrator, site and view identity.
            AppendSavedViewV1(content, view[3], view[1], view[2], id, view[4], view[5], view[7], view[8], (long)view[17]! == 1, view[18], view[19]);
            if (FinishSourceSeal(content) != (string)view[22]!) return Invalid("view-digest");
        }

        var collections = Rows("_collection");
        foreach (var collection in collections)
        {
            var history = receipts[((long)collection[0]!, (string)collection[1]!)];
            var rev = (long)collection[2]!;
            var last = history.SingleOrDefault(receipt => (long)receipt[9]! == rev);
            using var empty = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var head = rev == 0 ? FinishSourceSeal(empty) : last?[6] as string;
            if (head is null || head != (string)collection[5]!) return Invalid("collection-digest");
            using var content = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            AppendSavedViewV1(content, 1, collection[0], collection[1], rev, collection[3], collection[4], head);
            if (FinishSourceSeal(content) != (string)collection[6]!) return Invalid("collection-digest");
        }
        return new(views.Length, views.Length, collections.Length);
    }

    // Equivalent to the v1 CanonicalDigestBuilder: decimal UTF-8 byte length, colon, value, semicolon.
    private static void AppendSavedViewV1(IncrementalHash digest, params object?[] values)
    {
        foreach (var value in values)
        {
            var text = value switch
            {
                null => "null",
                bool flag => flag ? "true" : "false",
                IFormattable formatted => formatted.ToString(null, CultureInfo.InvariantCulture),
                _ => value.ToString() ?? "",
            };
            var bytes = StrictUtf8.GetBytes(text);
            digest.AppendData(StrictUtf8.GetBytes(bytes.Length.ToString(CultureInfo.InvariantCulture)));
            digest.AppendData(":"u8);
            digest.AppendData(bytes);
            digest.AppendData(";"u8);
        }
    }

    private static async Task<LegacySavedViewDigests?> VerifyRetainedLegacySavedViewDigestsAsync(NpgsqlConnection target,
        NpgsqlTransaction tx, CandidateTable[] definitions, CancellationToken ct)
    {
        var owned = LegacySavedViewRelations.Where(relation => definitions.Contains(relation.Target)).ToArray();
        if (owned.Length == 0) return null;
        var data = new Dictionary<string, object?[][]>(StringComparer.Ordinal);
        foreach (var suffix in SavedViewDigestRelations)
        {
            var relation = owned.Single(item => item.Name == LegacySavedViewPrefix + suffix);
            var table = relation.Target;
            await using var command = new NpgsqlCommand($"""
                SELECT * FROM {ImportSchema}.{table.Name} ORDER BY {KeyForPostgres(table)} LIMIT {RehearsalLimit + 1}
                """, target, tx) { CommandTimeout = LegacyCommandTimeout };
            await using var rows = await command.ExecuteReaderAsync(ct);
            var values = new List<object?[]>();
            while (await rows.ReadAsync(ct))
            {
                if (values.Count == RehearsalLimit) throw new InvalidOperationException("The retained saved-view digest verification exceeded its row limit.");
                var entry = new object?[table.Columns.Length];
                for (var index = 0; index < entry.Length; index++) entry[index] = rows.IsDBNull(index) ? null : rows.GetValue(index);
                values.Add(entry);
            }
            data.Add(relation.Name, values.ToArray());
        }
        var result = VerifyLegacySavedViewDigests(data);
        if (result.Finding is { } finding)
            throw new InvalidOperationException($"The retained saved-view source failed canonical verification: {finding.Category}.");
        return result;
    }
}
