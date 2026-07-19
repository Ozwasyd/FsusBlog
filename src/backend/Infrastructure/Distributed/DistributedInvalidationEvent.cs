using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.Distributed;

public static class DistributedInvalidationEventKinds
{
    public const string ArticleMutation = "article_mutation";
    public const string CommentMutation = "comment_mutation";
    public const string TaxonomyMutation = "taxonomy_mutation";
    public const string SystemPageMutation = "system_page_mutation";
    public const string SeoMutation = "seo_mutation";
    public const string ComplianceMutation = "compliance_mutation";
    public const string PublicAotArtifactUpdated = "public_aot_artifact_updated";
    public const string PublicHotReadVersionPublished = "public_hot_read_version_published";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal)
    {
        ArticleMutation,
        CommentMutation,
        TaxonomyMutation,
        SystemPageMutation,
        SeoMutation,
        ComplianceMutation,
        PublicAotArtifactUpdated,
        PublicHotReadVersionPublished
    };
}

public sealed record DistributedInvalidationEvent(
    [property: JsonPropertyName("schema")] string Schema,
    [property: JsonPropertyName("eventId")] string EventId,
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("sourceNodeId")] string SourceNodeId,
    [property: JsonPropertyName("runtimeScope")] string RuntimeScope,
    [property: JsonPropertyName("cacheTags")] IReadOnlyList<string> CacheTags,
    [property: JsonPropertyName("routeKeys")] IReadOnlyList<string> RouteKeys,
    [property: JsonPropertyName("artifactKeys")] IReadOnlyList<string> ArtifactKeys,
    [property: JsonPropertyName("emittedAt")] DateTimeOffset EmittedAt,
    [property: JsonPropertyName("traceId")] string TraceId)
{
    public const string CurrentSchema = "fsusblog.distributed-invalidation.v1";

    public string ReplayIdentity => string.Concat(RuntimeScope, ':', EventId);

    public static DistributedInvalidationEvent Create(
        string eventId,
        string kind,
        string sourceNodeId,
        string runtimeScope,
        IEnumerable<string>? cacheTags,
        IEnumerable<string>? routeKeys,
        IEnumerable<string>? artifactKeys,
        string traceId,
        TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(clock);
        var value = new DistributedInvalidationEvent(
            CurrentSchema,
            eventId?.Trim() ?? string.Empty,
            kind?.Trim() ?? string.Empty,
            sourceNodeId?.Trim() ?? string.Empty,
            runtimeScope?.Trim() ?? string.Empty,
            NormalizeKeys(cacheTags),
            NormalizeKeys(routeKeys),
            NormalizeKeys(artifactKeys),
            clock.GetUtcNow(),
            traceId?.Trim() ?? string.Empty);
        value.Validate();
        return value;
    }

    public void Validate()
    {
        if (!string.Equals(Schema, CurrentSchema, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Distributed invalidation event schema is unsupported.");
        }
        if (string.IsNullOrWhiteSpace(EventId)
            || string.IsNullOrWhiteSpace(SourceNodeId)
            || string.IsNullOrWhiteSpace(RuntimeScope)
            || string.IsNullOrWhiteSpace(TraceId))
        {
            throw new InvalidDataException("Distributed invalidation event identity is incomplete.");
        }
        if (!DistributedInvalidationEventKinds.All.Contains(Kind))
        {
            throw new InvalidDataException("Distributed invalidation event kind is unsupported.");
        }
        if (EmittedAt == default)
        {
            throw new InvalidDataException("Distributed invalidation event timestamp is missing.");
        }
        if (CacheTags.Count == 0 && RouteKeys.Count == 0 && ArtifactKeys.Count == 0)
        {
            throw new InvalidDataException("Distributed invalidation event has no affected targets.");
        }
        ValidateCanonicalKeys(CacheTags);
        ValidateCanonicalKeys(RouteKeys);
        ValidateCanonicalKeys(ArtifactKeys);
    }

    private static string[] NormalizeKeys(IEnumerable<string>? values)
        => values?
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Select(static value => value.Trim())
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray()
            ?? [];

    private static void ValidateCanonicalKeys(IReadOnlyList<string> values)
    {
        string[] normalized = NormalizeKeys(values);
        if (!values.SequenceEqual(normalized, StringComparer.Ordinal))
        {
            throw new InvalidDataException("Distributed invalidation event targets are not canonical.");
        }
    }
}
