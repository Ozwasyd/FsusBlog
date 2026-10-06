using System.Text.Json;

namespace FsusBlog.Contracts.Articles;

/// <summary>The existing current responsibility snapshot's stored JSON strings.</summary>
public sealed record ArticleResponsibilityStorageEncoding(string AuthorsJson, string? ReviewerJson, string SourcesJson)
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>Preserves the original Web JSON encoding; it does not admit an unconfirmed responsibility draft.</summary>
    public static ArticleResponsibilityStorageEncoding Encode(ArticleResponsibilityDraft draft)
        => new(JsonSerializer.Serialize(draft.Authors, s_jsonOptions),
            draft.Reviewer is null ? null : JsonSerializer.Serialize(draft.Reviewer, s_jsonOptions),
            JsonSerializer.Serialize(draft.Sources, s_jsonOptions));
}

/// <summary>Current revision field encoding shared by production persistence and offline projection.</summary>
public static class ArticleRevisionStorageEncoding
{
    /// <summary>Preserves the original comma-separated sorted tag IDs without additional filtering or deduplication.</summary>
    public static string EncodeTagIds(IReadOnlyList<int> tagIds) => string.Join(',', tagIds.OrderBy(static id => id));
}
