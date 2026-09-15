using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public sealed class RevisionSourceDiffResultVerifier(
    IRevisionMarkdownStructureAuthority structureAuthority)
{
    public async Task<bool> VerifyAsync(
        RevisionComparePlanBundle bundle,
        RevisionSourceDiffResult result,
        CancellationToken cancellationToken = default)
    {
        if (!RevisionSourceDiffVerifier.Verify(bundle, result))
        {
            return false;
        }
        if (!bundle.Plan.Options.HeadingNavigation)
        {
            return true;
        }

        RevisionMarkdownStructureReadResult baseRead = await structureAuthority.ReadAsync(
                new RevisionMarkdownStructureRequest(
                    bundle.BasePackage.SourceDigest,
                    bundle.BasePackage.RawMarkdown),
                cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        RevisionMarkdownStructureReadResult compareRead = await structureAuthority.ReadAsync(
                new RevisionMarkdownStructureRequest(
                    bundle.ComparePackage.SourceDigest,
                    bundle.ComparePackage.RawMarkdown),
                cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (baseRead.Status != RevisionMarkdownStructureReadStatus.Available
            || compareRead.Status != RevisionMarkdownStructureReadStatus.Available
            || baseRead.Snapshot is null
            || compareRead.Snapshot is null
            || !string.Equals(
                baseRead.Snapshot.ParserVersion,
                result.Receipt.StructureParserVersion,
                StringComparison.Ordinal)
            || !string.Equals(
                compareRead.Snapshot.ParserVersion,
                result.Receipt.StructureParserVersion,
                StringComparison.Ordinal)
            || !string.Equals(
                baseRead.Snapshot.ContentDigest,
                result.Receipt.BaseStructureDigest,
                StringComparison.Ordinal)
            || !string.Equals(
                compareRead.Snapshot.ContentDigest,
                result.Receipt.CompareStructureDigest,
                StringComparison.Ordinal))
        {
            return false;
        }

        return Project(baseRead.Snapshot.Headings).SequenceEqual(result.BaseHeadings)
            && Project(compareRead.Snapshot.Headings).SequenceEqual(result.CompareHeadings);
    }

    private static IEnumerable<RevisionDiffHeading> Project(
        ImmutableArray<RevisionMarkdownHeadingNode> headings)
        => headings.Select(static heading => new RevisionDiffHeading(
            heading.Level,
            heading.LineIndex,
            heading.Source,
            heading.IdentityDigest));
}
