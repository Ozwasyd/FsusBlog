using System.Globalization;
using System.Text.Json;

namespace FsusBlog.Contracts.Articles.Outbox;

/// <summary>Reads original persisted columns and JSON, rejecting conflicting coordinates and versions.</summary>
public static class ArticleMutationOutboxEnvelopeCodec
{
    public const string CurrentSchemaId = "fsusblog.article-mutation-outbox-envelope.v2";
    public const int CurrentSchemaVersion = 2;

    public static ArticleMutationOutboxEnvelope Read(ArticleMutationOutboxValue item)
    {
        ArgumentNullException.ThrowIfNull(item);
        using JsonDocument document = JsonDocument.Parse(
            string.IsNullOrWhiteSpace(item.PayloadJson) ? "{}" : item.PayloadJson);
        JsonElement root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException($"Article mutation outbox event {item.EventId} payload must be an object.");
        }

        int payloadSchemaVersion = ReadInt32(root, "schemaVersion") ?? 1;
        int schemaVersion = item.SchemaVersion > 0 ? item.SchemaVersion : payloadSchemaVersion;
        if (item.SchemaVersion > 0 && item.SchemaVersion != payloadSchemaVersion)
        {
            throw new InvalidOperationException(
                $"Article mutation outbox event {item.EventId} payload schemaVersion disagrees with its column.");
        }
        if (schemaVersion is < 1 or > CurrentSchemaVersion)
        {
            throw new InvalidOperationException(
                $"Article mutation outbox event {item.EventId} uses unsupported schema version {schemaVersion}.");
        }

        int payloadArticleId = ReadInt32(root, "articleId") ?? item.AggregateId;
        string payloadEventType = ReadString(root, "eventType") ?? item.EventType;
        if (payloadArticleId != item.AggregateId
            || !string.Equals(payloadEventType, item.EventType, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Article mutation outbox event {item.EventId} envelope disagrees with its aggregate columns.");
        }

        long? releaseId = ResolveCoordinate(
            item.ArticlePublicationId,
            ReadInt64(root, "releaseId"),
            ReadInt64(root, "articlePublicationId"),
            "releaseId",
            item.EventId);
        DateTime occurredAt = ReadDateTime(root, "occurredAt") ?? item.CreatedAt;
        var version = new ArticleMutationVersionReference(
            ResolveCoordinate(
                item.ArticleRevisionId,
                ReadInt64(root, "articleRevisionId"),
                null,
                "articleRevisionId",
                item.EventId),
            ResolveCoordinate(
                item.RevisionNo,
                ReadInt32(root, "revisionNo"),
                null,
                "revisionNo",
                item.EventId),
            releaseId,
            ResolveCoordinate(
                item.PublicationNo,
                ReadInt32(root, "releaseNo"),
                ReadInt32(root, "publicationNo"),
                "releaseNo",
                item.EventId),
            ResolveCoordinate(
                item.ResponsibilitySnapshotId,
                ReadInt64(root, "responsibilitySnapshotId"),
                null,
                "responsibilitySnapshotId",
                item.EventId),
            ResolveCoordinate(
                item.RightsSnapshotId,
                ReadInt64(root, "rightsSnapshotId"),
                null,
                "rightsSnapshotId",
                item.EventId),
            ResolveCoordinate(
                item.ResponsibilityVersion,
                ReadInt32(root, "responsibilityVersion"),
                null,
                "responsibilityVersion",
                item.EventId),
            ReadDateTime(root, "publicUpdatedAt"),
            occurredAt);

        return new ArticleMutationOutboxEnvelope(
            schemaVersion,
            item.EventId,
            item.AggregateId,
            item.EventType,
            version,
            new ArticleMutationScopeChange(
                ReadScope(root, "before", "beforeCategoryId", "beforeTagIds", "beforeVisibility"),
                ReadScope(root, "after", "afterCategoryId", "afterTagIds", "afterVisibility")),
            occurredAt);
    }

    private static ArticleMutationScopeSnapshot? ReadScope(
        JsonElement root,
        string objectName,
        string categoryName,
        string tagsName,
        string visibilityName)
    {
        JsonElement scope = root;
        bool hasObject = TryGetProperty(root, objectName, out JsonElement nested)
            && nested.ValueKind == JsonValueKind.Object;
        if (hasObject)
        {
            scope = nested;
            categoryName = "categoryId";
            tagsName = "tagIds";
            visibilityName = "visibility";
        }

        int? categoryId = ReadInt32(scope, categoryName);
        IReadOnlyList<int> tagIds = ReadInt32Array(scope, tagsName);
        string? visibility = ReadString(scope, visibilityName);
        return hasObject || categoryId.HasValue || tagIds.Count > 0 || visibility is not null
            ? new ArticleMutationScopeSnapshot(categoryId, tagIds, visibility)
            : null;
    }

    private static T? ResolveCoordinate<T>(
        T? columnValue,
        T? primaryPayloadValue,
        T? compatibilityPayloadValue,
        string coordinateName,
        string eventId)
        where T : struct, IEquatable<T>
    {
        T? payloadValue = primaryPayloadValue ?? compatibilityPayloadValue;
        if (primaryPayloadValue.HasValue
            && compatibilityPayloadValue.HasValue
            && !primaryPayloadValue.Value.Equals(compatibilityPayloadValue.Value))
        {
            throw new InvalidOperationException(
                $"Article mutation outbox event {eventId} has conflicting {coordinateName} aliases.");
        }

        if (columnValue.HasValue && payloadValue.HasValue && !columnValue.Value.Equals(payloadValue.Value))
        {
            throw new InvalidOperationException(
                $"Article mutation outbox event {eventId} payload {coordinateName} disagrees with its column.");
        }

        return columnValue ?? payloadValue;
    }

    private static string? ReadString(JsonElement root, string name)
        => TryGetProperty(root, name, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? ReadInt32(JsonElement root, string name)
        => TryGetProperty(root, name, out JsonElement value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt32(out int result)
                ? result
                : null;

    private static long? ReadInt64(JsonElement root, string name)
        => TryGetProperty(root, name, out JsonElement value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt64(out long result)
                ? result
                : null;

    private static DateTime? ReadDateTime(JsonElement root, string name)
    {
        string? value = ReadString(root, name);
        return DateTime.TryParse(
            value,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
            out DateTime result)
                ? DateTime.SpecifyKind(result, DateTimeKind.Utc)
                : null;
    }

    private static IReadOnlyList<int> ReadInt32Array(JsonElement root, string name)
    {
        if (!TryGetProperty(root, name, out JsonElement value) || value.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return value.EnumerateArray()
            .Where(static item => item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out _))
            .Select(static item => item.GetInt32())
            .Where(static item => item > 0)
            .Distinct()
            .ToArray();
    }

    private static bool TryGetProperty(JsonElement root, string name, out JsonElement value)
    {
        foreach (JsonProperty property in root.EnumerateObject())
        {
            if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                value = property.Value;
                return true;
            }
        }

        value = default;
        return false;
    }
}

