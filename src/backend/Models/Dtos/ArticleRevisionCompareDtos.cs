using System.Globalization;
using System.Text.Json.Serialization;

using FsusBlog.Core.Services.Articles;

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
    RevisionSourceDiffResult SourceDiff);

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
