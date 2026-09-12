using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

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
