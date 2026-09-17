using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

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
