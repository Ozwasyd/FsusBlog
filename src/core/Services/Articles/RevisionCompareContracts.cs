using System.Collections.Immutable;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Core.Services.Articles;

public enum RevisionCompareSourceKind
{
    CurrentDraft = 0,
    CurrentRevision = 1,
    HistoricalRevision = 2
}

public enum RevisionCompareViewMode
{
    Unified = 0,
    Split = 1
}

public enum RevisionCompareWordSegmentation
{
    UnicodeTextElementsV1 = 0
}

public enum RevisionCompareMetadataValueType
{
    String = 0,
    NullableString = 1,
    Int32 = 2,
    Int32List = 3,
    Boolean = 4,
    NullableInstant = 5
}

public enum RevisionCompareSnapshotKind
{
    Rights = 0,
    Responsibility = 1,
    Release = 2
}

public enum RevisionCompareSnapshotState
{
    Present = 0,
    NotApplicable = 1,
    Missing = 2
}

public enum RevisionComparePackageReadStatus
{
    Available = 0,
    Unavailable = 1,
    Stale = 2,
    Invalid = 3,
    BudgetExceeded = 4
}

public enum RevisionComparePlanStatus
{
    Accepted = 0,
    Unavailable = 1,
    Stale = 2,
    Invalid = 3,
    BudgetExceeded = 4,
    Cancelled = 5,
    Tampered = 6
}

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

public sealed class RevisionCompareSnapshot
{
    private RevisionCompareSnapshot(
        RevisionCompareSnapshotKind kind,
        RevisionCompareSnapshotState state,
        string? reference,
        int schemaVersion,
        ImmutableArray<byte> payload,
        string? payloadDigest)
    {
        Kind = kind;
        State = state;
        Reference = reference;
        SchemaVersion = schemaVersion;
        Payload = payload;
        PayloadDigest = payloadDigest;
    }

    public RevisionCompareSnapshotKind Kind
    {
        get;
    }

    public RevisionCompareSnapshotState State
    {
        get;
    }

    public string? Reference
    {
        get;
    }

    public int SchemaVersion
    {
        get;
    }

    public ImmutableArray<byte> Payload
    {
        get;
    }

    public string? PayloadDigest
    {
        get;
    }

    public static RevisionCompareSnapshot Present(
        RevisionCompareSnapshotKind kind,
        string reference,
        int schemaVersion,
        ReadOnlySpan<byte> payload)
    {
        if (string.IsNullOrWhiteSpace(reference) || schemaVersion <= 0 || payload.IsEmpty)
        {
            throw new RevisionCompareContractException("revision_compare_snapshot_invalid");
        }

        ImmutableArray<byte> bytes = [.. payload];
        return new RevisionCompareSnapshot(
            kind,
            RevisionCompareSnapshotState.Present,
            reference,
            schemaVersion,
            bytes,
            RevisionCompareCanonical.Sha256(bytes.AsSpan()));
    }

    public static RevisionCompareSnapshot NotApplicable(RevisionCompareSnapshotKind kind)
        => new(kind, RevisionCompareSnapshotState.NotApplicable, null, 0, [], null);

    public static RevisionCompareSnapshot Missing(RevisionCompareSnapshotKind kind)
        => new(kind, RevisionCompareSnapshotState.Missing, null, 0, [], null);
}

public sealed class RevisionComparePackage
{
    internal RevisionComparePackage(
        int articleId,
        RevisionCompareSourceKind sourceKind,
        string sourceIdentity,
        long? revisionId,
        int? revisionNo,
        long? serverRevision,
        string? documentEpoch,
        ImmutableArray<byte> rawMarkdown,
        string sourceDigest,
        ImmutableArray<RevisionCompareMetadataValue> metadata,
        ImmutableArray<RevisionCompareSnapshot> snapshots,
        string packageDigest)
    {
        ArticleId = articleId;
        SourceKind = sourceKind;
        SourceIdentity = sourceIdentity;
        RevisionId = revisionId;
        RevisionNo = revisionNo;
        ServerRevision = serverRevision;
        DocumentEpoch = documentEpoch;
        RawMarkdown = rawMarkdown;
        SourceDigest = sourceDigest;
        Metadata = metadata;
        Snapshots = snapshots;
        PackageDigest = packageDigest;
    }

    public int ArticleId
    {
        get;
    }

    public RevisionCompareSourceKind SourceKind
    {
        get;
    }

    public string SourceIdentity
    {
        get;
    }

    public long? RevisionId
    {
        get;
    }

    public int? RevisionNo
    {
        get;
    }

    public long? ServerRevision
    {
        get;
    }

    public string? DocumentEpoch
    {
        get;
    }

    public ImmutableArray<byte> RawMarkdown
    {
        get;
    }

    public string SourceDigest
    {
        get;
    }

    public ImmutableArray<RevisionCompareMetadataValue> Metadata
    {
        get;
    }

    public ImmutableArray<RevisionCompareSnapshot> Snapshots
    {
        get;
    }

    public string PackageDigest
    {
        get;
    }
}

public sealed record RevisionComparePackageReadResult(
    RevisionComparePackageReadStatus Status,
    RevisionComparePackage? Package,
    string ReasonCode)
{
    public static RevisionComparePackageReadResult Available(RevisionComparePackage package)
        => new(RevisionComparePackageReadStatus.Available, package, "accepted");

    public static RevisionComparePackageReadResult Unavailable()
        => new(RevisionComparePackageReadStatus.Unavailable, null, "revision_compare_source_unavailable");

    public static RevisionComparePackageReadResult Stale()
        => new(RevisionComparePackageReadStatus.Stale, null, "revision_compare_source_stale");

    public static RevisionComparePackageReadResult Invalid()
        => new(RevisionComparePackageReadStatus.Invalid, null, "revision_compare_source_invalid");

    public static RevisionComparePackageReadResult BudgetExceeded()
        => new(RevisionComparePackageReadStatus.BudgetExceeded, null, "revision_compare_source_budget_exceeded");
}

public interface IRevisionComparePackageReader
{
    Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(
        RevisionCompareReadContext context,
        int articleId,
        RevisionCompareSourceSelector selector,
        CancellationToken cancellationToken = default);
}

public sealed record RevisionComparePackageReference(
    RevisionCompareSourceKind SourceKind,
    string SourceIdentity,
    long? RevisionId,
    int? RevisionNo,
    long? ServerRevision,
    string? DocumentEpoch,
    string SourceDigest,
    string PackageDigest,
    int SourceByteLength);

public sealed class RevisionComparePlan
{
    internal RevisionComparePlan(
        int schemaVersion,
        string plannerVersion,
        int articleId,
        RevisionCompareReadContext reader,
        RevisionCompareSourceSelector baseSelector,
        RevisionCompareSourceSelector compareSelector,
        RevisionComparePackageReference basePackage,
        RevisionComparePackageReference comparePackage,
        RevisionCompareOptions options,
        RevisionCompareBudgets budgets,
        string cancellationIdentity,
        DateTimeOffset expiresAtUtc,
        string contentDigest)
    {
        SchemaVersion = schemaVersion;
        PlannerVersion = plannerVersion;
        ArticleId = articleId;
        Reader = reader;
        BaseSelector = baseSelector;
        CompareSelector = compareSelector;
        BasePackage = basePackage;
        ComparePackage = comparePackage;
        Options = options with
        {
            MetadataFieldIds = options.MetadataFields
        };
        Budgets = budgets;
        CancellationIdentity = cancellationIdentity;
        ExpiresAtUtc = expiresAtUtc;
        ContentDigest = contentDigest;
    }

    public int SchemaVersion
    {
        get;
    }

    public string PlannerVersion
    {
        get;
    }

    public int ArticleId
    {
        get;
    }

    public RevisionCompareReadContext Reader
    {
        get;
    }

    public RevisionCompareSourceSelector BaseSelector
    {
        get;
    }

    public RevisionCompareSourceSelector CompareSelector
    {
        get;
    }

    public RevisionComparePackageReference BasePackage
    {
        get;
    }

    public RevisionComparePackageReference ComparePackage
    {
        get;
    }

    public RevisionCompareOptions Options
    {
        get;
    }

    public RevisionCompareBudgets Budgets
    {
        get;
    }

    public string CancellationIdentity
    {
        get;
    }

    public DateTimeOffset ExpiresAtUtc
    {
        get;
    }

    public string ContentDigest
    {
        get;
    }
}

public sealed record RevisionComparePlanReceipt(
    int SchemaVersion,
    Guid RequestId,
    RevisionComparePlanStatus Status,
    string ReasonCode,
    string? PlanDigest,
    string? BasePackageDigest,
    string? ComparePackageDigest,
    string CancellationIdentity,
    string ContentDigest);

public sealed record RevisionComparePlanBundle(
    RevisionComparePlan Plan,
    RevisionComparePackage BasePackage,
    RevisionComparePackage ComparePackage,
    RevisionComparePlanReceipt Receipt);

public sealed record RevisionComparePlanResult(
    RevisionComparePlanStatus Status,
    RevisionComparePlanBundle? Bundle,
    RevisionComparePlanReceipt Receipt)
{
    public bool IsSuccess => Status == RevisionComparePlanStatus.Accepted && Bundle is not null;
}

public static class RevisionCompareMetadataRegistry
{
    private static readonly ImmutableArray<RevisionCompareMetadataDescriptor> s_descriptors =
    [
        new("title", RevisionCompareMetadataValueType.String, false, "exact-utf8", "plain-text", "article-revision.title"),
        new("summary", RevisionCompareMetadataValueType.NullableString, false, "exact-utf8-or-null", "plain-text", "article-revision.summary"),
        new("cover-image-url", RevisionCompareMetadataValueType.NullableString, false, "exact-utf8-or-null", "url", "article-revision.cover-image-url"),
        new("category-id", RevisionCompareMetadataValueType.Int32, false, "invariant-decimal", "stable-id", "article-revision.category-id"),
        new("tag-ids", RevisionCompareMetadataValueType.Int32List, false, "sorted-invariant-decimal", "stable-id-list", "article-revision.tag-ids"),
        new("status", RevisionCompareMetadataValueType.Int32, false, "invariant-decimal", "closed-enum", "article-lifecycle.status"),
        new("scheduled-publish-at", RevisionCompareMetadataValueType.NullableInstant, false, "utc-roundtrip-or-null", "utc-instant", "article-lifecycle.scheduled-publish-at")
    ];

    private static readonly IReadOnlyDictionary<string, RevisionCompareMetadataDescriptor> s_byId =
        s_descriptors.ToDictionary(static item => item.FieldId, StringComparer.Ordinal);

    public static ImmutableArray<RevisionCompareMetadataDescriptor> Descriptors => s_descriptors;

    public static bool TryGet(string fieldId, out RevisionCompareMetadataDescriptor descriptor)
        => s_byId.TryGetValue(fieldId, out descriptor!);

    public static RevisionCompareMetadataValue String(string fieldId, string value)
        => Create(fieldId, RevisionCompareMetadataValueType.String, value);

    public static RevisionCompareMetadataValue NullableString(string fieldId, string? value)
        => Create(fieldId, RevisionCompareMetadataValueType.NullableString, value ?? "null");

    public static RevisionCompareMetadataValue Int32(string fieldId, int value)
        => Create(fieldId, RevisionCompareMetadataValueType.Int32, value.ToString(CultureInfo.InvariantCulture));

    public static RevisionCompareMetadataValue Int32List(string fieldId, IEnumerable<int> values)
        => Create(
            fieldId,
            RevisionCompareMetadataValueType.Int32List,
            string.Join(',', values.Distinct().Order().Select(static value => value.ToString(CultureInfo.InvariantCulture))));

    public static RevisionCompareMetadataValue NullableInstant(string fieldId, DateTime? value)
        => Create(
            fieldId,
            RevisionCompareMetadataValueType.NullableInstant,
            value.HasValue ? value.Value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) : "null");

    private static RevisionCompareMetadataValue Create(
        string fieldId,
        RevisionCompareMetadataValueType valueType,
        string canonicalValue)
    {
        if (!TryGet(fieldId, out RevisionCompareMetadataDescriptor descriptor)
            || descriptor.ValueType != valueType
            || canonicalValue.Length > RevisionCompareContract.MaxMetadataValueLength)
        {
            throw new RevisionCompareContractException("revision_compare_metadata_invalid");
        }

        return new RevisionCompareMetadataValue(fieldId, valueType, canonicalValue, descriptor.Sensitive);
    }
}

public static class RevisionComparePackageSeal
{
    public static RevisionComparePackage Create(
        int articleId,
        RevisionCompareSourceKind sourceKind,
        string sourceIdentity,
        long? revisionId,
        int? revisionNo,
        long? serverRevision,
        string? documentEpoch,
        ReadOnlySpan<byte> rawMarkdown,
        IEnumerable<RevisionCompareMetadataValue> metadata,
        IEnumerable<RevisionCompareSnapshot> snapshots)
    {
        if (rawMarkdown.Length > RevisionCompareContract.AbsoluteMaxSourceBytes)
        {
            throw new RevisionCompareContractException("revision_compare_source_budget_exceeded");
        }

        ImmutableArray<byte> source = [.. rawMarkdown];
        ImmutableArray<RevisionCompareMetadataValue> metadataValues = [.. metadata.OrderBy(static item => item.FieldId, StringComparer.Ordinal)];
        ImmutableArray<RevisionCompareSnapshot> snapshotValues = [.. snapshots.OrderBy(static item => item.Kind)];
        RevisionCompareContract.ValidatePackageShape(
            articleId,
            sourceKind,
            sourceIdentity,
            revisionId,
            revisionNo,
            serverRevision,
            documentEpoch,
            metadataValues,
            snapshotValues);

        string sourceDigest = RevisionCompareCanonical.Sha256(source.AsSpan());
        string packageDigest = RevisionCompareCanonical.PackageDigest(
            articleId,
            sourceKind,
            sourceIdentity,
            revisionId,
            revisionNo,
            serverRevision,
            documentEpoch,
            sourceDigest,
            source.Length,
            metadataValues,
            snapshotValues);
        return new RevisionComparePackage(
            articleId,
            sourceKind,
            sourceIdentity,
            revisionId,
            revisionNo,
            serverRevision,
            documentEpoch,
            source,
            sourceDigest,
            metadataValues,
            snapshotValues,
            packageDigest);
    }

    public static bool Verify(RevisionComparePackage package)
    {
        try
        {
            RevisionCompareContract.ValidatePackageShape(
                package.ArticleId,
                package.SourceKind,
                package.SourceIdentity,
                package.RevisionId,
                package.RevisionNo,
                package.ServerRevision,
                package.DocumentEpoch,
                package.Metadata,
                package.Snapshots);
            return string.Equals(
                    package.SourceDigest,
                    RevisionCompareCanonical.Sha256(package.RawMarkdown.AsSpan()),
                    StringComparison.Ordinal)
                && string.Equals(
                    package.PackageDigest,
                    RevisionCompareCanonical.PackageDigest(
                        package.ArticleId,
                        package.SourceKind,
                        package.SourceIdentity,
                        package.RevisionId,
                        package.RevisionNo,
                        package.ServerRevision,
                        package.DocumentEpoch,
                        package.SourceDigest,
                        package.RawMarkdown.Length,
                        package.Metadata,
                        package.Snapshots),
                    StringComparison.Ordinal);
        }
        catch (RevisionCompareContractException)
        {
            return false;
        }
    }
}

public static class RevisionCompareContract
{
    public const int SchemaVersion = 1;
    public const string PlannerVersion = "revision-compare-plan-v1";
    public const string DiffEngineVersion = "revision-source-diff-v1";
    public const string SegmenterVersion = "unicode-text-elements-v1";
    public const int MaxIdentityLength = 256;
    public const int MaxMetadataValueLength = 8_192;
    public const int AbsoluteMaxSourceBytes = 4 * 1024 * 1024;
    public const int AbsoluteMaxLineCount = 200_000;
    public const int AbsoluteMaxTokenCount = 1_000_000;
    public const int AbsoluteMaxOutputBytes = 32 * 1024 * 1024;
    public const int AbsoluteMaxMemoryBytes = 256 * 1024 * 1024;
    public const int AbsoluteMaxHunksPerChunk = 4_096;
    public const int AbsoluteMaxChunks = 1_024;
    public const int AbsoluteMaxTimeoutMilliseconds = 120_000;

    public static void ValidateRequest(RevisionComparePlanRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.ArticleId <= 0
            || request.Reader.AdminPrincipalId <= 0
            || !ValidIdentity(request.Reader.SiteScope)
            || request.Reader.RequestId == Guid.Empty
            || !ValidIdentity(request.CancellationIdentity)
            || request.ExpiresAtUtc.Offset != TimeSpan.Zero)
        {
            throw new RevisionCompareContractException("revision_compare_request_invalid");
        }

        ValidateSelector(request.Base);
        ValidateSelector(request.Compare);
        if (!Enum.IsDefined(request.Options.ViewMode)
            || !Enum.IsDefined(request.Options.WordSegmentation)
            || request.Options.ContextLineCount is < 0 or > 100
            || request.Options.MetadataFields.Length != request.Options.MetadataFields.Distinct(StringComparer.Ordinal).Count())
        {
            throw new RevisionCompareContractException("revision_compare_options_invalid");
        }

        foreach (string fieldId in request.Options.MetadataFields)
        {
            if (!RevisionCompareMetadataRegistry.TryGet(fieldId, out _))
            {
                throw new RevisionCompareContractException("revision_compare_metadata_field_unknown");
            }
        }

        RevisionCompareBudgets budgets = request.Budgets;
        if (budgets.MaxSourceBytes is <= 0 or > AbsoluteMaxSourceBytes
            || budgets.MaxLineCount is <= 0 or > AbsoluteMaxLineCount
            || budgets.MaxTokenCount is <= 0 or > AbsoluteMaxTokenCount
            || budgets.MaxOutputBytes is <= 0 or > AbsoluteMaxOutputBytes
            || budgets.MaxMemoryBytes is <= 0 or > AbsoluteMaxMemoryBytes
            || budgets.MaxHunksPerChunk is <= 0 or > AbsoluteMaxHunksPerChunk
            || budgets.MaxChunks is <= 0 or > AbsoluteMaxChunks
            || budgets.TimeoutMilliseconds is <= 0 or > AbsoluteMaxTimeoutMilliseconds)
        {
            throw new RevisionCompareContractException("revision_compare_budget_invalid");
        }
    }

    public static int CountLines(ReadOnlySpan<byte> source)
    {
        if (source.IsEmpty)
        {
            return 0;
        }

        int count = 1;
        for (int index = 0; index < source.Length; index++)
        {
            if (source[index] == (byte)'\n')
            {
                count++;
            }
            else if (source[index] == (byte)'\r'
                && (index + 1 >= source.Length || source[index + 1] != (byte)'\n'))
            {
                count++;
            }
        }
        return count;
    }

    internal static void ValidatePackageShape(
        int articleId,
        RevisionCompareSourceKind sourceKind,
        string sourceIdentity,
        long? revisionId,
        int? revisionNo,
        long? serverRevision,
        string? documentEpoch,
        ImmutableArray<RevisionCompareMetadataValue> metadata,
        ImmutableArray<RevisionCompareSnapshot> snapshots)
    {
        if (articleId <= 0 || !Enum.IsDefined(sourceKind) || !ValidIdentity(sourceIdentity))
        {
            throw new RevisionCompareContractException("revision_compare_package_identity_invalid");
        }

        bool validCoordinates = sourceKind switch
        {
            RevisionCompareSourceKind.CurrentDraft => revisionId is null
                && revisionNo is null
                && serverRevision is > 0
                && ValidIdentity(documentEpoch),
            RevisionCompareSourceKind.CurrentRevision or RevisionCompareSourceKind.HistoricalRevision => revisionId is > 0
                && revisionNo is > 0
                && serverRevision is null
                && documentEpoch is null,
            _ => false
        };
        if (!validCoordinates)
        {
            throw new RevisionCompareContractException("revision_compare_package_coordinates_invalid");
        }

        if (metadata.IsDefault
            || metadata.Length == 0
            || metadata.Select(static item => item.FieldId).Distinct(StringComparer.Ordinal).Count() != metadata.Length)
        {
            throw new RevisionCompareContractException("revision_compare_metadata_invalid");
        }
        foreach (RevisionCompareMetadataValue value in metadata)
        {
            if (!RevisionCompareMetadataRegistry.TryGet(value.FieldId, out RevisionCompareMetadataDescriptor descriptor)
                || descriptor.ValueType != value.ValueType
                || descriptor.Sensitive != value.Sensitive
                || value.CanonicalValue.Length > MaxMetadataValueLength)
            {
                throw new RevisionCompareContractException("revision_compare_metadata_invalid");
            }
        }

        if (snapshots.IsDefault
            || snapshots.Length != Enum.GetValues<RevisionCompareSnapshotKind>().Length
            || snapshots.Select(static item => item.Kind).Distinct().Count() != snapshots.Length)
        {
            throw new RevisionCompareContractException("revision_compare_snapshot_set_invalid");
        }
        foreach (RevisionCompareSnapshot snapshot in snapshots)
        {
            bool presentValid = snapshot.State == RevisionCompareSnapshotState.Present
                && ValidIdentity(snapshot.Reference)
                && snapshot.SchemaVersion > 0
                && !snapshot.Payload.IsDefaultOrEmpty
                && string.Equals(
                    snapshot.PayloadDigest,
                    RevisionCompareCanonical.Sha256(snapshot.Payload.AsSpan()),
                    StringComparison.Ordinal);
            bool absentValid = snapshot.State is RevisionCompareSnapshotState.NotApplicable or RevisionCompareSnapshotState.Missing
                && snapshot.Reference is null
                && snapshot.SchemaVersion == 0
                && snapshot.Payload.IsEmpty
                && snapshot.PayloadDigest is null;
            if (!presentValid && !absentValid)
            {
                throw new RevisionCompareContractException("revision_compare_snapshot_invalid");
            }
        }
    }

    private static void ValidateSelector(RevisionCompareSourceSelector selector)
    {
        ArgumentNullException.ThrowIfNull(selector);
        bool valid = selector.Kind switch
        {
            RevisionCompareSourceKind.CurrentDraft => selector.RevisionId is null
                && ValidIdentity(selector.DraftKey)
                && selector.ExpectedServerRevision is > 0
                && ValidIdentity(selector.DocumentEpoch),
            RevisionCompareSourceKind.CurrentRevision or RevisionCompareSourceKind.HistoricalRevision => selector.RevisionId is > 0
                && selector.DraftKey is null
                && selector.ExpectedServerRevision is null
                && selector.DocumentEpoch is null,
            _ => false
        };
        if (!valid || (selector.ExpectedSourceDigest is not null && !RevisionCompareCanonical.IsSha256(selector.ExpectedSourceDigest)))
        {
            throw new RevisionCompareContractException("revision_compare_selector_invalid");
        }
    }

    private static bool ValidIdentity(string? value)
        => !string.IsNullOrWhiteSpace(value)
            && value.Length <= MaxIdentityLength
            && !value.Any(char.IsControl);
}

internal static class RevisionCompareCanonical
{
    public static string Sha256(ReadOnlySpan<byte> value)
        => Convert.ToHexStringLower(SHA256.HashData(value));

    public static bool IsSha256(string value)
        => value.Length == 64 && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    public static string PackageDigest(
        int articleId,
        RevisionCompareSourceKind sourceKind,
        string sourceIdentity,
        long? revisionId,
        int? revisionNo,
        long? serverRevision,
        string? documentEpoch,
        string sourceDigest,
        int sourceByteLength,
        ImmutableArray<RevisionCompareMetadataValue> metadata,
        ImmutableArray<RevisionCompareSnapshot> snapshots)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, RevisionCompareContract.SchemaVersion);
        Append(hash, articleId);
        Append(hash, (int)sourceKind);
        Append(hash, sourceIdentity);
        Append(hash, revisionId);
        Append(hash, revisionNo);
        Append(hash, serverRevision);
        Append(hash, documentEpoch);
        Append(hash, sourceDigest);
        Append(hash, sourceByteLength);
        foreach (RevisionCompareMetadataValue value in metadata)
        {
            Append(hash, value.FieldId);
            Append(hash, (int)value.ValueType);
            Append(hash, value.CanonicalValue);
            Append(hash, value.Sensitive);
        }
        foreach (RevisionCompareSnapshot snapshot in snapshots)
        {
            Append(hash, (int)snapshot.Kind);
            Append(hash, (int)snapshot.State);
            Append(hash, snapshot.Reference);
            Append(hash, snapshot.SchemaVersion);
            Append(hash, snapshot.PayloadDigest);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static string PlanDigest(
        RevisionComparePlanRequest request,
        RevisionComparePackageReference basePackage,
        RevisionComparePackageReference comparePackage)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, RevisionCompareContract.SchemaVersion);
        Append(hash, RevisionCompareContract.PlannerVersion);
        Append(hash, request.ArticleId);
        Append(hash, request.Reader.AdminPrincipalId);
        Append(hash, request.Reader.SiteScope);
        Append(hash, request.Reader.RequestId);
        AppendSelector(hash, request.Base);
        AppendSelector(hash, request.Compare);
        AppendPackageReference(hash, basePackage);
        AppendPackageReference(hash, comparePackage);
        Append(hash, (int)request.Options.ViewMode);
        Append(hash, (int)request.Options.WordSegmentation);
        Append(hash, request.Options.ContextLineCount);
        Append(hash, request.Options.HeadingNavigation);
        foreach (string fieldId in request.Options.MetadataFields.Order(StringComparer.Ordinal))
        {
            Append(hash, fieldId);
        }
        AppendBudgets(hash, request.Budgets);
        Append(hash, request.CancellationIdentity);
        Append(hash, request.ExpiresAtUtc.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static string ReceiptDigest(
        Guid requestId,
        RevisionComparePlanStatus status,
        string reasonCode,
        string? planDigest,
        string? basePackageDigest,
        string? comparePackageDigest,
        string cancellationIdentity)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(hash, RevisionCompareContract.SchemaVersion);
        Append(hash, requestId);
        Append(hash, (int)status);
        Append(hash, reasonCode);
        Append(hash, planDigest);
        Append(hash, basePackageDigest);
        Append(hash, comparePackageDigest);
        Append(hash, cancellationIdentity);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static RevisionComparePackageReference Reference(RevisionComparePackage package)
        => new(
            package.SourceKind,
            package.SourceIdentity,
            package.RevisionId,
            package.RevisionNo,
            package.ServerRevision,
            package.DocumentEpoch,
            package.SourceDigest,
            package.PackageDigest,
            package.RawMarkdown.Length);

    public static bool ReferenceMatches(RevisionComparePackageReference reference, RevisionComparePackage package)
        => reference == Reference(package);

    private static void AppendSelector(IncrementalHash hash, RevisionCompareSourceSelector selector)
    {
        Append(hash, (int)selector.Kind);
        Append(hash, selector.RevisionId);
        Append(hash, selector.DraftKey);
        Append(hash, selector.ExpectedServerRevision);
        Append(hash, selector.DocumentEpoch);
        Append(hash, selector.ExpectedSourceDigest);
    }

    private static void AppendPackageReference(IncrementalHash hash, RevisionComparePackageReference reference)
    {
        Append(hash, (int)reference.SourceKind);
        Append(hash, reference.SourceIdentity);
        Append(hash, reference.RevisionId);
        Append(hash, reference.RevisionNo);
        Append(hash, reference.ServerRevision);
        Append(hash, reference.DocumentEpoch);
        Append(hash, reference.SourceDigest);
        Append(hash, reference.PackageDigest);
        Append(hash, reference.SourceByteLength);
    }

    private static void AppendBudgets(IncrementalHash hash, RevisionCompareBudgets budgets)
    {
        Append(hash, budgets.MaxSourceBytes);
        Append(hash, budgets.MaxLineCount);
        Append(hash, budgets.MaxTokenCount);
        Append(hash, budgets.MaxOutputBytes);
        Append(hash, budgets.MaxMemoryBytes);
        Append(hash, budgets.MaxHunksPerChunk);
        Append(hash, budgets.MaxChunks);
        Append(hash, budgets.TimeoutMilliseconds);
    }

    public static void Append(IncrementalHash hash, object? value)
    {
        string text = value switch
        {
            null => "null",
            DateTimeOffset timestamp => timestamp.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
            _ => value.ToString() ?? string.Empty
        };
        byte[] bytes = Encoding.UTF8.GetBytes(text);
        Span<byte> length = stackalloc byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(length, bytes.Length);
        hash.AppendData(length);
        hash.AppendData(bytes);
    }
}

public sealed class RevisionCompareContractException(string code) : Exception(code)
{
    public string Code { get; } = code;
}
