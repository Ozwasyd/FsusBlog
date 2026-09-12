using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public sealed record RevisionCompareSourceSelector(
    RevisionCompareSourceKind Kind,
    long? RevisionId = null,
    string? DraftKey = null,
    long? ExpectedServerRevision = null,
    string? DocumentEpoch = null,
    string? ExpectedSourceDigest = null);

public sealed record RevisionCompareReadContext(
    long AdminPrincipalId,
    string SiteScope,
    Guid RequestId);

public sealed record RevisionCompareOptions(
    RevisionCompareViewMode ViewMode,
    RevisionCompareWordSegmentation WordSegmentation,
    int ContextLineCount,
    bool HeadingNavigation,
    IReadOnlyList<string> MetadataFieldIds)
{
    public ImmutableArray<string> MetadataFields { get; } = [.. MetadataFieldIds];
}

public sealed record RevisionCompareBudgets(
    int MaxSourceBytes,
    int MaxLineCount,
    int MaxTokenCount,
    int MaxOutputBytes,
    int MaxMemoryBytes,
    int MaxHunksPerChunk,
    int MaxChunks,
    int TimeoutMilliseconds);

public sealed record RevisionComparePlanRequest(
    int ArticleId,
    RevisionCompareReadContext Reader,
    RevisionCompareSourceSelector Base,
    RevisionCompareSourceSelector Compare,
    RevisionCompareOptions Options,
    RevisionCompareBudgets Budgets,
    string CancellationIdentity,
    DateTimeOffset ExpiresAtUtc);

public sealed record RevisionCompareMetadataDescriptor(
    string FieldId,
    RevisionCompareMetadataValueType ValueType,
    bool Sensitive,
    string Normalization,
    string DisplayFormat,
    string Authority);

public sealed record RevisionCompareMetadataValue(
    string FieldId,
    RevisionCompareMetadataValueType ValueType,
    string CanonicalValue,
    bool Sensitive);
