using System.Globalization;
using System.Text.Json;

internal static partial class Migration
{
    private static readonly string[] LegacyOutboxEnvelopeFields =
    [
        "schemaVersion", "articleId", "eventType", "articleRevisionId", "revisionNo",
        "rightsSnapshotId", "responsibilitySnapshotId", "responsibilityVersion", "releaseId", "releaseNo",
        "publicUpdatedAt", "occurredAt", "before", "after"
    ];

    private static readonly string[] LegacyOutboxScopeFields = ["categoryId", "tagIds", "visibility"];

    private static readonly string[] LegacyOutboxTimestampFormats =
        ["yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'"];

    private static bool VerifyLegacyOutboxEnvelope(string json, int articleId, long revisionId, long rightsId,
        long? responsibilityId, int? responsibilityVersion, long? releaseId, DateTime createdAt, int expectedCategory,
        int[] expectedTags, out bool exactDatabaseClock, int? beforeCategory = null, int[]? beforeTags = null,
        int revisionNumber = 0, int publicationNumber = 0, LegacyHistoricalResponsibility? history = null, DateTime? rightsPublicUpdatedAt = null)
    {
        exactDatabaseClock = false;
        bool updated = beforeCategory.HasValue;
        int defaultOrdinal = updated ? 2 : 1;
        int expectedRevision = revisionNumber == 0 ? defaultOrdinal : revisionNumber;
        int? expectedPublication = history is not null ? null : publicationNumber == 0 ? defaultOrdinal : publicationNumber;
        if (history is null && !rightsPublicUpdatedAt.HasValue && (updated ? expectedRevision < 2 || expectedPublication < 2 : expectedRevision != 1 || expectedPublication != 1))
            return false;

        if (json is not { Length: > 0 and <= LegacyOutboxMaxPayloadBytes } || articleId <= 0 || revisionId <= 0 || rightsId <= 0 ||
            releaseId <= 0 || responsibilityId is <= 0 || responsibilityVersion is <= 0 ||
            responsibilityId.HasValue != responsibilityVersion.HasValue || expectedCategory <= 0 ||
            updated != (beforeTags is not null) || beforeCategory is <= 0 || beforeTags is { Length: > 32 } ||
            expectedTags is not { Length: <= 32 } || createdAt.Kind == DateTimeKind.Local || createdAt.Ticks % 10 != 0)
            return false;

        try
        {
            if (StrictUtf8.GetByteCount(json) > LegacyOutboxMaxPayloadBytes)
                return false;
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions
            {
                MaxDepth = 3,
                AllowDuplicateProperties = false
            });
            var root = document.RootElement;
            string eventType = rightsPublicUpdatedAt.HasValue ? LegacyRightsProofEvent :
                history is not null ? LegacyResponsibilityEventType : updated ? "updated" : "created";
            if (!HasExactLegacyOutboxFields(root, LegacyOutboxEnvelopeFields) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("schemaVersion"), 2) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("articleId"), articleId) ||
                !LegacyOutboxTextMatches(root.GetProperty("eventType"), eventType) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("articleRevisionId"), revisionId) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("revisionNo"), expectedRevision) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("rightsSnapshotId"), rightsId) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("responsibilitySnapshotId"), responsibilityId) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("responsibilityVersion"), responsibilityVersion) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("releaseId"), releaseId) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("releaseNo"), expectedPublication))
                return false;

            // PostgreSQL retains microseconds from the v1 event clock.
            if (!TryReadLegacyOutboxUtc(root.GetProperty("occurredAt"), out var occurredAt) ||
                !TryReadLegacyOutboxUtc(root.GetProperty("publicUpdatedAt"), out var publicUpdatedAt) ||
                publicUpdatedAt != (rightsPublicUpdatedAt ?? history?.PublicUpdatedAt ?? occurredAt) || occurredAt.Ticks - occurredAt.Ticks % 10 != createdAt.Ticks)
                return false;

            var before = root.GetProperty("before");
            var visibility = history is null ? "published" : "historical";
            bool beforeMatches = history is not null || rightsPublicUpdatedAt.HasValue ? LegacyOutboxScopeMatches(before, expectedCategory, expectedTags, visibility) :
                beforeCategory is { } previous ? LegacyOutboxScopeMatches(before, previous, beforeTags!, visibility) :
                before.ValueKind == JsonValueKind.Null;
            if (!beforeMatches || !LegacyOutboxScopeMatches(root.GetProperty("after"), expectedCategory, expectedTags, visibility))
                return false;

            exactDatabaseClock = occurredAt.Ticks == createdAt.Ticks;
            return true;
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or ArgumentException)
        {
            return false;
        }
    }

    private static bool HasExactLegacyOutboxFields(JsonElement value, string[] fields) =>
        value.ValueKind == JsonValueKind.Object && value.GetPropertyCount() == fields.Length &&
        fields.All(field => value.TryGetProperty(field, out _));

    private static bool LegacyOutboxIntegerMatches(JsonElement value, long? expected) =>
        expected is { } number ? value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var observed) && observed == number :
            value.ValueKind == JsonValueKind.Null;

    private static bool LegacyOutboxTextMatches(JsonElement value, string expected) =>
        value.ValueKind == JsonValueKind.String && value.ValueEquals(expected);

    private static bool LegacyOutboxScopeMatches(JsonElement value, int category, int[] tags, string visibility) =>
        HasExactLegacyOutboxFields(value, LegacyOutboxScopeFields) &&
        LegacyOutboxIntegerMatches(value.GetProperty("categoryId"), category) &&
        LegacyOutboxTextMatches(value.GetProperty("visibility"), visibility) &&
        LegacyOutboxTagsMatch(value.GetProperty("tagIds"), tags);

    private static bool LegacyOutboxTagsMatch(JsonElement tags, int[] expected)
    {
        if (tags.ValueKind != JsonValueKind.Array || tags.GetArrayLength() != expected.Length)
            return false;
        // v1 persists revision tags sorted, while the event can use first-seen input order.
        var unmatched = new HashSet<int>(expected);
        if (unmatched.Count != expected.Length || unmatched.Any(tag => tag <= 0))
            return false;
        foreach (var tag in tags.EnumerateArray())
            if (tag.ValueKind != JsonValueKind.Number || !tag.TryGetInt32(out var id) || !unmatched.Remove(id))
                return false;
        return unmatched.Count == 0;
    }

    private static bool TryReadLegacyOutboxUtc(JsonElement value, out DateTime instant)
    {
        instant = default;
        return value.ValueKind == JsonValueKind.String &&
            value.GetString() is { Length: 20 or >= 22 and <= 28 } stamp &&
            DateTime.TryParseExact(stamp, LegacyOutboxTimestampFormats, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out instant);
    }
}
