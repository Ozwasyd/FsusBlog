using System.Globalization;
using System.Text.Json;

internal static partial class Migration
{
    private static readonly string[] LegacyCreatedEnvelopeFields =
    [
        "schemaVersion", "articleId", "eventType", "articleRevisionId", "revisionNo",
        "rightsSnapshotId", "responsibilitySnapshotId", "responsibilityVersion", "releaseId", "releaseNo",
        "publicUpdatedAt", "occurredAt", "before", "after"
    ];

    private static readonly string[] LegacyCreatedScopeFields = ["categoryId", "tagIds", "visibility"];

    private static readonly string[] LegacyCreatedTimestampFormats =
        ["yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'"];

    private static bool VerifyLegacyOutboxEnvelope(string json, int articleId, long revisionId, long rightsId,
        long? responsibilityId, int? responsibilityVersion, long releaseId, DateTime createdAt, int expectedCategory,
        int[] expectedTags)
    {
        if (json is not { Length: > 0 and <= LegacyOutboxMaxPayloadBytes } || articleId <= 0 || revisionId <= 0 || rightsId <= 0 ||
            releaseId <= 0 || responsibilityId is <= 0 || responsibilityVersion is <= 0 ||
            responsibilityId.HasValue != responsibilityVersion.HasValue || expectedCategory <= 0 ||
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
            if (!HasExactLegacyOutboxFields(root, LegacyCreatedEnvelopeFields) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("schemaVersion"), 2) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("articleId"), articleId) ||
                !LegacyOutboxTextMatches(root.GetProperty("eventType"), "created") ||
                !LegacyOutboxIntegerMatches(root.GetProperty("articleRevisionId"), revisionId) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("revisionNo"), 1) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("rightsSnapshotId"), rightsId) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("responsibilitySnapshotId"), responsibilityId) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("responsibilityVersion"), responsibilityVersion) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("releaseId"), releaseId) ||
                !LegacyOutboxIntegerMatches(root.GetProperty("releaseNo"), 1) ||
                root.GetProperty("before").ValueKind != JsonValueKind.Null)
                return false;

            // A published first create writes both JSON times from the same instant. PostgreSQL retains microseconds.
            if (!TryReadLegacyOutboxUtc(root.GetProperty("occurredAt"), out var occurredAt) ||
                !TryReadLegacyOutboxUtc(root.GetProperty("publicUpdatedAt"), out var publicUpdatedAt) ||
                occurredAt != publicUpdatedAt || occurredAt.Ticks - occurredAt.Ticks % 10 != createdAt.Ticks)
                return false;

            var after = root.GetProperty("after");
            return HasExactLegacyOutboxFields(after, LegacyCreatedScopeFields) &&
                LegacyOutboxIntegerMatches(after.GetProperty("categoryId"), expectedCategory) &&
                LegacyOutboxTextMatches(after.GetProperty("visibility"), "published") &&
                LegacyOutboxTagsMatch(after.GetProperty("tagIds"), expectedTags);
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

    private static bool LegacyOutboxTagsMatch(JsonElement tags, int[] expected)
    {
        if (tags.ValueKind != JsonValueKind.Array || tags.GetArrayLength() != expected.Length)
            return false;
        // v1 persists revision tags sorted, while the created event uses first-seen input order.
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
            DateTime.TryParseExact(stamp, LegacyCreatedTimestampFormats, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out instant);
    }
}
