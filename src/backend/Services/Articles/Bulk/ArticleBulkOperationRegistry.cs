using System.Collections.Frozen;
using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Services.Articles.Bulk;

internal enum ArticleBulkExecutionStrategy
{
    PerItemIsolated,
    AllOrNothing
}

internal enum ArticleBulkParameterType
{
    Digest,
    OpaqueId,
    Rfc3339Utc,
    StableId,
    StableIdArray
}

internal sealed record ArticleBulkParameterField(
    string Name,
    ArticleBulkParameterType Type,
    int? MaximumItems = null);

internal sealed record ArticleBulkOperation(
    string Id,
    int Version,
    ArticleBulkExecutionStrategy Strategy,
    string CommandOwner,
    ImmutableArray<ArticleBulkParameterField> Parameters,
    ImmutableArray<string> ExpectedArticleStates,
    string PermissionPolicy,
    ImmutableArray<string> SideEffectOwners,
    ImmutableArray<string> FixtureDependencies,
    string ResultKind,
    bool MutatesBusinessState)
{
    internal string ParameterSchema => $"fsusblog.article-bulk.parameters.{Id}.v1";
    internal string IdempotencyScope => "plan-operation-parameters-article-actor";
    internal string RetryEligibility => Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
        ? "failed-items-explicit-revision"
        : "none";
    internal string CancelBoundary => Strategy == ArticleBulkExecutionStrategy.PerItemIsolated
        ? "stop-admission-wait-active"
        : "before-group-commit-only";
    internal int MaximumBatchSize => 10_000;
    internal string ItemReceiptSchema => "fsusblog.article-bulk.item-receipt.v1";
    internal string AggregateReceiptSchema => "fsusblog.article-bulk.aggregate-receipt.v1";
}

internal sealed record ArticleBulkRegistrySnapshot(
    string Schema,
    int Version,
    ArticleBulkExecutionStrategy? DefaultStrategy,
    ImmutableArray<ArticleBulkOperation> Operations,
    FrozenDictionary<string, ImmutableArray<string>> CommandOwners,
    ImmutableArray<ArticleBulkCanonicalCommandOwner> CanonicalCommandOwners,
    string ContentDigest);

internal static partial class ArticleBulkOperationRegistry
{
    internal const string Schema = "fsusblog.article-bulk.operation-registry.v1";
    internal const int Version = 1;

    private static readonly ImmutableArray<string> s_editableStates = ["draft", "inbox", "scheduled"];
    private static readonly ImmutableArray<string> s_metadataEffects =
        ["article-audit", "article-cache", "article-mutation-outbox"];
    private static readonly ImmutableArray<string> s_lifecycleEffects =
        ["article-audit", "article-cache", "article-mutation-outbox", "article-publication-projection", "author-search-index"];

    private static readonly ImmutableArray<ArticleBulkOperation> s_canonicalOperations =
    [
        Operation("category.add", ArticleBulkExecutionStrategy.PerItemIsolated, "article-category-command",
            [Field("categoryId", ArticleBulkParameterType.OpaqueId)], s_editableStates, "article.metadata.write",
            s_metadataEffects, ["category-catalog"], "article-revision", true),
        Operation("category.remove", ArticleBulkExecutionStrategy.PerItemIsolated, "article-category-command",
            [Field("categoryId", ArticleBulkParameterType.OpaqueId)], s_editableStates, "article.metadata.write",
            s_metadataEffects, ["category-catalog"], "article-revision", true),
        Operation("tag.add", ArticleBulkExecutionStrategy.PerItemIsolated, "article-tag-command",
            [Field("tagId", ArticleBulkParameterType.OpaqueId)], s_editableStates, "article.metadata.write",
            s_metadataEffects, ["tag-catalog"], "article-revision", true),
        Operation("tag.remove", ArticleBulkExecutionStrategy.PerItemIsolated, "article-tag-command",
            [Field("tagId", ArticleBulkParameterType.OpaqueId)], s_editableStates, "article.metadata.write",
            s_metadataEffects, ["tag-catalog"], "article-revision", true),
        Operation("property.set", ArticleBulkExecutionStrategy.PerItemIsolated, "article-property-command",
            [Field("definitionId", ArticleBulkParameterType.OpaqueId), Field("typedValueDigest", ArticleBulkParameterType.Digest)],
            s_editableStates, "article.property.write", [.. s_metadataEffects, "author-search-index"],
            ["property-definition"], "article-property-revision", true),
        Operation("property.clear", ArticleBulkExecutionStrategy.PerItemIsolated, "article-property-command",
            [Field("definitionId", ArticleBulkParameterType.OpaqueId)], s_editableStates, "article.property.write",
            [.. s_metadataEffects, "author-search-index"], ["property-definition"], "article-property-revision", true),
        Operation("content-check.run", ArticleBulkExecutionStrategy.PerItemIsolated, "article-content-check-command",
            [Field("checkIds", ArticleBulkParameterType.StableIdArray, 64)], s_editableStates, "article.read",
            ["article-content-check-result"], ["content-check-catalog"], "diagnostic-result", false),
        Operation("relation.reindex", ArticleBulkExecutionStrategy.PerItemIsolated, "article-relation-reindex-command",
            [Field("indexAuthorityDigest", ArticleBulkParameterType.Digest)],
            ["archived", "draft", "inbox", "published", "scheduled"], "article.reindex",
            ["article-relation-index"], [], "reindex-result", false),
        Operation("search.reindex", ArticleBulkExecutionStrategy.PerItemIsolated, "author-search-reindex-command",
            [Field("indexAuthorityDigest", ArticleBulkParameterType.Digest)],
            ["archived", "draft", "inbox", "published", "scheduled"], "article.reindex",
            ["author-search-index"], [], "reindex-result", false),
        Operation("lifecycle.archive", ArticleBulkExecutionStrategy.AllOrNothing, "article-lifecycle-command",
            [Field("reasonCode", ArticleBulkParameterType.StableId)], ["draft", "inbox", "published", "scheduled"],
            "article.lifecycle.write", s_lifecycleEffects, [], "article-lifecycle-revision", true),
        Operation("lifecycle.restore", ArticleBulkExecutionStrategy.AllOrNothing, "article-lifecycle-command",
            [Field("reasonCode", ArticleBulkParameterType.StableId)], ["archived"], "article.lifecycle.write",
            s_lifecycleEffects, [], "article-lifecycle-revision", true),
        Operation("lifecycle.inbox-to-draft", ArticleBulkExecutionStrategy.AllOrNothing, "article-lifecycle-command",
            [Field("reasonCode", ArticleBulkParameterType.StableId)], ["inbox"], "article.lifecycle.write",
            s_lifecycleEffects, [], "article-lifecycle-revision", true),
        Operation("lifecycle.draft-to-inbox", ArticleBulkExecutionStrategy.AllOrNothing, "article-lifecycle-command",
            [Field("reasonCode", ArticleBulkParameterType.StableId)], ["draft"], "article.lifecycle.write",
            s_lifecycleEffects, [], "article-lifecycle-revision", true),
        Operation("schedule.change", ArticleBulkExecutionStrategy.AllOrNothing, "article-schedule-command",
            [Field("scheduledAtUtc", ArticleBulkParameterType.Rfc3339Utc)], ["draft", "scheduled"],
            "article.schedule.write", s_lifecycleEffects, [], "article-lifecycle-revision", true)
    ];

    private static readonly FrozenDictionary<string, ArticleBulkOperation> s_operationsById =
        s_canonicalOperations.ToFrozenDictionary(static operation => operation.Id, StringComparer.Ordinal);

    internal static ArticleBulkRegistrySnapshot Current { get; } = CreateSnapshot(s_canonicalOperations);

    internal static ArticleBulkOperation Get(string operationId)
    {
        if (!StableIdRegex().IsMatch(operationId) || !s_operationsById.TryGetValue(operationId, out var operation))
        {
            throw new ArticleBulkContractException("article-bulk.operation-unsupported");
        }

        return operation;
    }

    internal static FrozenDictionary<string, object> NormalizeParameters(
        string operationId,
        IReadOnlyDictionary<string, JsonElement> parameters)
    {
        ArgumentNullException.ThrowIfNull(parameters);
        ArticleBulkOperation operation = Get(operationId);
        string[] expected = [.. operation.Parameters.Select(static field => field.Name).Order(StringComparer.Ordinal)];
        string[] actual = [.. parameters.Keys.Order(StringComparer.Ordinal)];
        if (!expected.SequenceEqual(actual, StringComparer.Ordinal))
        {
            throw new ArticleBulkContractException("article-bulk.parameter-schema-mismatch");
        }

        var normalized = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (ArticleBulkParameterField field in operation.Parameters)
        {
            JsonElement value = parameters[field.Name];
            normalized[field.Name] = NormalizeParameter(field, value);
        }

        return normalized.ToFrozenDictionary(StringComparer.Ordinal);
    }

    internal static void Validate(ArticleBulkRegistrySnapshot candidate)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        if (candidate.Operations.IsDefault || candidate.CanonicalCommandOwners.IsDefault
            || candidate.CommandOwners is null)
        {
            throw new ArticleBulkContractException("article-bulk.registry-tampered");
        }
        ArticleBulkCanonicalCommandOwners.ValidateExact(
            candidate.Operations,
            ArticleBulkCanonicalCommandOwners.Current);
        ArticleBulkRegistrySnapshot expected = Current;
        if (candidate.Schema != Schema || candidate.Version != Version || candidate.DefaultStrategy is not null
            || candidate.Operations.Length != s_canonicalOperations.Length
            || !candidate.Operations.SequenceEqual(s_canonicalOperations)
            || !candidate.CanonicalCommandOwners.SequenceEqual(ArticleBulkCanonicalCommandOwners.Current)
            || candidate.CommandOwners.Count != expected.CommandOwners.Count
            || candidate.CommandOwners.Any(pair => !expected.CommandOwners.TryGetValue(pair.Key, out var ids)
                || !pair.Value.SequenceEqual(ids))
            || candidate.ContentDigest != DigestRegistry(candidate with
            {
                ContentDigest = string.Empty
            }))
        {
            throw new ArticleBulkContractException("article-bulk.registry-tampered");
        }
    }

    private static ArticleBulkRegistrySnapshot CreateSnapshot(ImmutableArray<ArticleBulkOperation> operations)
    {
        ArticleBulkCanonicalCommandOwners.ValidateExact(operations, ArticleBulkCanonicalCommandOwners.Current);
        FrozenDictionary<string, ImmutableArray<string>> owners =
            ArticleBulkCanonicalCommandOwners.CreateOperationMap(ArticleBulkCanonicalCommandOwners.Current);
        var unsigned = new ArticleBulkRegistrySnapshot(
            Schema,
            Version,
            null,
            operations,
            owners,
            ArticleBulkCanonicalCommandOwners.Current,
            string.Empty);
        return unsigned with
        {
            ContentDigest = DigestRegistry(unsigned)
        };
    }

    private static string DigestRegistry(ArticleBulkRegistrySnapshot registry)
    {
        var digestable = new
        {
            registry.Schema,
            registry.Version,
            registry.DefaultStrategy,
            Operations = registry.Operations,
            CommandOwners = registry.CommandOwners.OrderBy(static pair => pair.Key, StringComparer.Ordinal),
            registry.CanonicalCommandOwners
        };
        return ArticleBulkDigest.Of(digestable);
    }

    private static object NormalizeParameter(ArticleBulkParameterField field, JsonElement value)
    {
        if (field.Type == ArticleBulkParameterType.StableIdArray)
        {
            if (value.ValueKind != JsonValueKind.Array)
            {
                throw new ArticleBulkContractException("article-bulk.parameter-invalid");
            }
            string[] values = [.. value.EnumerateArray().Select(static item => item.GetString() ?? string.Empty)];
            if (values.Length == 0 || values.Length > field.MaximumItems
                || values.Any(value => !StableIdRegex().IsMatch(value))
                || values.Distinct(StringComparer.Ordinal).Count() != values.Length)
            {
                throw new ArticleBulkContractException("article-bulk.parameter-invalid");
            }
            return values.Order(StringComparer.Ordinal).ToImmutableArray();
        }

        if (value.ValueKind != JsonValueKind.String)
        {
            throw new ArticleBulkContractException("article-bulk.parameter-invalid");
        }
        string text = value.GetString()!;
        bool valid = field.Type switch
        {
            ArticleBulkParameterType.Digest => DigestRegex().IsMatch(text),
            ArticleBulkParameterType.OpaqueId => OpaqueIdRegex().IsMatch(text),
            ArticleBulkParameterType.StableId => StableIdRegex().IsMatch(text),
            ArticleBulkParameterType.Rfc3339Utc => DateTimeOffset.TryParseExact(
                text,
                ["yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'"],
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AssumeUniversal
                    | System.Globalization.DateTimeStyles.AdjustToUniversal,
                out _),
            _ => false
        };
        return valid ? text : throw new ArticleBulkContractException("article-bulk.parameter-invalid");
    }

    private static ArticleBulkParameterField Field(string name, ArticleBulkParameterType type, int? maximumItems = null) =>
        new(name, type, maximumItems);

    private static ArticleBulkOperation Operation(
        string id,
        ArticleBulkExecutionStrategy strategy,
        string owner,
        ImmutableArray<ArticleBulkParameterField> parameters,
        ImmutableArray<string> states,
        string permission,
        ImmutableArray<string> sideEffects,
        ImmutableArray<string> fixtures,
        string resultKind,
        bool mutates) => new(
            id,
            Version,
            strategy,
            owner,
            parameters,
            states.Order(StringComparer.Ordinal).ToImmutableArray(),
            permission,
            sideEffects.Order(StringComparer.Ordinal).ToImmutableArray(),
            fixtures.Order(StringComparer.Ordinal).ToImmutableArray(),
            resultKind,
            mutates);

    [GeneratedRegex("^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\\z", RegexOptions.CultureInvariant)]
    private static partial Regex StableIdRegex();

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex OpaqueIdRegex();

    [GeneratedRegex("^sha256:[0-9a-f]{64}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex DigestRegex();
}

internal sealed class ArticleBulkContractException(string code) : InvalidOperationException(code)
{
    internal string Code { get; } = code;
}

internal static class ArticleBulkDigest
{
    private static readonly JsonSerializerOptions s_options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };

    internal static string Of<T>(T value)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using var stream = new HashWriteStream(hash);
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions
        {
            Encoder = s_options.Encoder,
            Indented = s_options.WriteIndented,
            MaxDepth = s_options.MaxDepth == 0 ? 64 : s_options.MaxDepth
        }))
        {
            JsonSerializer.Serialize(writer, value, s_options);
            writer.Flush();
        }
        return $"sha256:{Convert.ToHexStringLower(hash.GetHashAndReset())}";
    }

    // Hash the same canonical UTF-8 JSON as it is written. Materializing a large plan
    // rents multi-megabyte serializer buffers that remain in each worker's shared pool.
    private sealed class HashWriteStream(IncrementalHash hash) : Stream
    {
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush()
        {
        }

        public override void Write(byte[] buffer, int offset, int count)
            => hash.AppendData(buffer, offset, count);

        public override void Write(ReadOnlySpan<byte> buffer)
            => hash.AppendData(buffer);

        public override int Read(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin)
            => throw new NotSupportedException();

        public override void SetLength(long value)
            => throw new NotSupportedException();
    }
}
