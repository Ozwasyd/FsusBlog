using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public static class RevisionCompareContract
{
    public const int SchemaVersion = 1;
    public const string PlannerVersion = "revision-compare-plan-v1";
    public const string DiffEngineVersion = "revision-source-diff-v1";
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
            if (!RevisionCompareMetadataRegistry.ValidValue(value))
            {
                throw new RevisionCompareContractException("revision_compare_metadata_invalid");
            }
        }

        if (snapshots.IsDefault
            || snapshots.Length != Enum.GetValues<RevisionCompareSnapshotKind>().Length
            || snapshots.Any(static item => !Enum.IsDefined(item.Kind))
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

public sealed class RevisionCompareContractException(string code) : Exception(code)
{
    public string Code { get; } = code;
}
