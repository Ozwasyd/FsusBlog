using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json.Serialization;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Models.Dtos;

// The transport accepts selectors, never a client-provided read context or plan.
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleRevisionCompareRequest(
    ArticleRevisionCompareSelector Base,
    ArticleRevisionCompareSelector Compare,
    ArticleRevisionCompareOptions Options,
    RevisionCompareBudgets Budgets,
    string CancellationIdentity);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleRevisionCompareOptions(
    RevisionCompareViewMode ViewMode,
    RevisionCompareWordSegmentation WordSegmentation,
    int ContextLineCount,
    bool HeadingNavigation,
    IReadOnlyList<string> MetadataFieldIds)
{
    public RevisionCompareOptions ToOptions()
        => new(ViewMode, WordSegmentation, ContextLineCount, HeadingNavigation, MetadataFieldIds);
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleRevisionCompareSelector(
    RevisionCompareSourceKind Kind,
    string? RevisionId = null,
    string? DraftKey = null,
    string? ExpectedServerRevision = null,
    string? DocumentEpoch = null,
    string? ExpectedSourceDigest = null)
{
    public RevisionCompareSourceSelector ToSelector()
        => new(Kind, ParseCoordinate(RevisionId), DraftKey,
            ParseCoordinate(ExpectedServerRevision), DocumentEpoch, ExpectedSourceDigest);

    internal static long? ParseCoordinate(string? value)
    {
        if (value is null)
        {
            return null;
        }
        if (value.Length == 0 || value[0] == '0'
            || value.Any(static character => character is < '0' or > '9')
            || !long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long coordinate))
        {
            throw new RevisionCompareContractException("revision_compare_selector_invalid");
        }
        return coordinate;
    }
}

public sealed record ArticleRevisionComparePackageReference(
    RevisionCompareSourceKind SourceKind,
    string SourceIdentity,
    string? RevisionId,
    int? RevisionNo,
    string? ServerRevision,
    string? DocumentEpoch,
    string SourceDigest,
    string PackageDigest,
    int SourceByteLength)
{
    public static ArticleRevisionComparePackageReference? From(RevisionComparePackageReference? value)
        => value is null ? null : new(value.SourceKind, value.SourceIdentity,
            value.RevisionId?.ToString(CultureInfo.InvariantCulture), value.RevisionNo,
            value.ServerRevision?.ToString(CultureInfo.InvariantCulture), value.DocumentEpoch,
            value.SourceDigest, value.PackageDigest, value.SourceByteLength);
}

public sealed record ArticleRevisionComparePlanReceipt(
    int SchemaVersion,
    Guid RequestId,
    RevisionComparePlanStatus Status,
    string ReasonCode,
    string? PlanDigest,
    string? BasePackageDigest,
    string? ComparePackageDigest,
    ArticleRevisionComparePackageReference? BasePackageReference,
    ArticleRevisionComparePackageReference? ComparePackageReference,
    string PermissionScopeDigest,
    string MetadataSchemaDigest,
    string OptionsDigest,
    string BudgetDigest,
    string? AdmissionDigest,
    string CancellationIdentity,
    string ContentDigest)
{
    public static ArticleRevisionComparePlanReceipt From(RevisionComparePlanReceipt receipt)
        => new(receipt.SchemaVersion, receipt.RequestId, receipt.Status, receipt.ReasonCode,
            receipt.PlanDigest, receipt.BasePackageDigest, receipt.ComparePackageDigest,
            ArticleRevisionComparePackageReference.From(receipt.BasePackageReference),
            ArticleRevisionComparePackageReference.From(receipt.ComparePackageReference),
            receipt.PermissionScopeDigest, receipt.MetadataSchemaDigest, receipt.OptionsDigest,
            receipt.BudgetDigest, receipt.AdmissionDigest, receipt.CancellationIdentity, receipt.ContentDigest);
}

public sealed record ArticleRevisionCompareResponse(
    ArticleRevisionComparePlanReceipt PlanReceipt,
    RevisionSourceDiffResult SourceDiff,
    ArticleRevisionMetadataDiffResponse? MetadataDiff = null)
{
    public static ArticleRevisionCompareResponse From(ArticleRevisionComparePlanReceipt receipt,
        RevisionSourceDiffResult source, RevisionMetadataDiffResult? metadata)
        => new(receipt, source, ArticleRevisionMetadataDiffResponse.From(metadata));
}

// Semantic receipts stay unchanged. Only transport values that exceed JavaScript's
// exact integer range become decimal strings; raw packages and readers stay private.
public sealed record ArticleRevisionMetadataDiffValue(
    RevisionMetadataDiffValueKind Kind,
    string? Text,
    string? Number,
    bool? Boolean,
    ImmutableArray<int> Ids)
{
    public static ArticleRevisionMetadataDiffValue From(RevisionMetadataDiffValue value)
        => new(value.Kind, value.Text, value.Number?.ToString(CultureInfo.InvariantCulture), value.Boolean, value.Ids);
}

public sealed record ArticleRevisionMetadataDiffField(
    string FieldId,
    string BeforePackageDigest,
    string AfterPackageDigest,
    string Authority,
    string Normalization,
    string DisplayFormat,
    bool Sensitive,
    ArticleRevisionMetadataDiffValue Before,
    ArticleRevisionMetadataDiffValue After,
    RevisionMetadataDiffChangeKind Change,
    ImmutableArray<int> AddedIds,
    ImmutableArray<int> RemovedIds)
{
    public static ArticleRevisionMetadataDiffField From(RevisionMetadataDiffField value)
        => new(value.FieldId, value.BeforePackageDigest, value.AfterPackageDigest, value.Authority,
            value.Normalization, value.DisplayFormat, value.Sensitive,
            ArticleRevisionMetadataDiffValue.From(value.Before), ArticleRevisionMetadataDiffValue.From(value.After),
            value.Change, value.AddedIds, value.RemovedIds);
}

public sealed record ArticleRevisionMetadataDiffTiming(string ElapsedTicks, string Frequency);

public sealed record ArticleRevisionMetadataDiffResponse(
    RevisionMetadataDiffReceipt Receipt,
    ImmutableArray<ArticleRevisionMetadataDiffField> Fields,
    ArticleRevisionMetadataDiffTiming Timing,
    bool IsSuccess,
    bool IsReviewable)
{
    public static ArticleRevisionMetadataDiffResponse? From(RevisionMetadataDiffResult? result)
        => result is null ? null : new(result.Receipt,
            [.. result.Fields.Select(ArticleRevisionMetadataDiffField.From)],
            new(result.Timing.ElapsedTicks.ToString(CultureInfo.InvariantCulture), result.Timing.Frequency.ToString(CultureInfo.InvariantCulture)),
            result.IsSuccess, result.IsReviewable);
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleRevisionCompareDraftCoordinateRequest(
    string DraftKey,
    string ExpectedServerRevision);

public sealed record ArticleRevisionCompareDraftCoordinateResponse(
    string DraftKey,
    int ArticleId,
    string ServerRevision,
    string DocumentEpoch,
    string SourceDigest);
