using System.Collections.Immutable;
using System.Text;

using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class RevisionSourceDiffTests
{
    [Fact]
    public async Task ComputeAsync_HeadingNavigationConsumesCanonicalSourceNodesAndBindsSectionChanges()
    {
        byte[] baseline = [
            0xef, 0xbb, 0xbf,
            .. Encoding.UTF8.GetBytes("# Real\nold\n```md\n# Not heading\n```not-close\n# Also not heading\n```\nSection\n---\ntail\n")
        ];
        byte[] compare = [
            0xef, 0xbb, 0xbf,
            .. Encoding.UTF8.GetBytes("# Real\nnew\n```md\n# Still not heading\n```not-close\n# Still fenced\n```\nSection\n---\ntail\n")
        ];
        RevisionMarkdownStructureSnapshot baselineStructure = Structure(
            baseline,
            (1, 0, LineRange(baseline, 0, 1)),
            (2, 7, LineRange(baseline, 7, 2)));
        RevisionMarkdownStructureSnapshot compareStructure = Structure(
            compare,
            (1, 0, LineRange(compare, 0, 1)),
            (2, 7, LineRange(compare, 7, 2)));
        var provider = new FixedStructureProvider(baselineStructure, compareStructure);
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            headingNavigation: true,
            structureProvider: provider);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.Equal(2, result.BaseHeadings.Length);
        Assert.Equal([1, 2], result.BaseHeadings.Select(static heading => heading.Level));
        RevisionDiffHunk changed = result.Chunks.SelectMany(static chunk => chunk.Hunks)
            .First(static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.NotEmpty(changed.HeadingIdentities);
        Assert.DoesNotContain(result.BaseHeadings, heading => heading.LineIndex is 3 or 5);
        Assert.Equal("canonical-markdown-test-v1", result.Receipt.StructureParserVersion);
        Assert.True(await new RevisionSourceDiffResultVerifier(
            new RevisionMarkdownStructureAuthority([provider])).VerifyAsync(plan, result));
    }

    [Fact]
    public async Task ComputeAsync_HeadingNavigationFailsClosedWithoutCanonicalAuthority()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("# Old\nbody\n");
        byte[] compare = Encoding.UTF8.GetBytes("# New\nbody\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            headingNavigation: true);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.Equal(RevisionComparePlanStatus.Unavailable, result.Status);
        Assert.Equal("revision_diff_structure_unavailable", result.Receipt.ReasonCode);
        Assert.Empty(result.Chunks);
    }

    [Fact]
    public async Task IndependentVerifier_RejectsResealedHeadingSubstitution()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("# Old\nbody\n");
        byte[] compare = Encoding.UTF8.GetBytes("# New\nbody\n");
        RevisionMarkdownStructureSnapshot baselineStructure = Structure(
            baseline,
            (1, 0, LineRange(baseline, 0, 1)));
        RevisionMarkdownStructureSnapshot compareStructure = Structure(
            compare,
            (1, 0, LineRange(compare, 0, 1)));
        var provider = new FixedStructureProvider(baselineStructure, compareStructure);
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            headingNavigation: true,
            structureProvider: provider);
        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        ImmutableArray<RevisionDiffHeading> tamperedHeadings = [result.BaseHeadings[0] with { Level = 6 }];
        RevisionSourceDiffResult tampered = Reseal(
            plan,
            result,
            result.Chunks,
            baseHeadings: tamperedHeadings);

        Assert.True(RevisionSourceDiffVerifier.Verify(plan, tampered));
        Assert.False(await new RevisionSourceDiffResultVerifier(
            new RevisionMarkdownStructureAuthority([provider])).VerifyAsync(plan, tampered));
    }

    [Fact]
    public async Task StructureAuthority_RejectsAmbiguousOrTamperedProviderSnapshots()
    {
        byte[] source = Encoding.UTF8.GetBytes("# Heading\nbody\n");
        RevisionMarkdownStructureSnapshot snapshot = Structure(
            source,
            (1, 0, LineRange(source, 0, 1)));
        var provider = new FixedStructureProvider(snapshot);
        var request = new RevisionMarkdownStructureRequest(snapshot.SourceDigest, [.. source]);

        RevisionMarkdownStructureReadResult ambiguous = await new RevisionMarkdownStructureAuthority(
            [provider, provider]).ReadAsync(request);
        RevisionMarkdownStructureReadResult tampered = await new RevisionMarkdownStructureAuthority(
            [new FixedStructureProvider(snapshot with { ContentDigest = new string('0', 64) })]).ReadAsync(request);

        Assert.Equal(RevisionMarkdownStructureReadStatus.Invalid, ambiguous.Status);
        Assert.Equal(RevisionMarkdownStructureReadStatus.Invalid, tampered.Status);
        Assert.Null(ambiguous.Snapshot);
        Assert.Null(tampered.Snapshot);
    }

    [Fact]
    public async Task CanonicalStructureProvider_ProjectsByteExactAtxAndSetextRanges()
    {
        byte[] source = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("# Top\r\nbody\r\nSetext\r\n===\r\n")];
        var provider = new CanonicalRevisionMarkdownStructureProvider();
        var request = new RevisionMarkdownStructureRequest(
            RevisionCompareCanonical.Sha256(source),
            [.. source]);

        RevisionMarkdownStructureReadResult result = await provider.ReadAsync(request);

        Assert.Equal(RevisionMarkdownStructureReadStatus.Available, result.Status);
        Assert.Equal(CanonicalRevisionMarkdownStructureProvider.ParserVersion, result.Snapshot!.ParserVersion);
        Assert.Collection(
            result.Snapshot.Headings,
            heading =>
            {
                Assert.Equal(1, heading.Level);
                Assert.Equal(0, heading.LineIndex);
                Assert.Equal(source.AsSpan(heading.Source.Offset, heading.Source.Length).ToArray(), source[..10]);
            },
            heading =>
            {
                Assert.Equal(1, heading.Level);
                Assert.Equal(2, heading.LineIndex);
                Assert.Equal(
                    Encoding.UTF8.GetBytes("Setext\r\n===\r\n"),
                    source.AsSpan(heading.Source.Offset, heading.Source.Length).ToArray());
            });
        Assert.True(RevisionMarkdownStructureSnapshotSeal.Verify(request, result.Snapshot));
    }

    [Fact]
    public async Task CanonicalStructureProvider_ExcludesHtmlCodeQuoteAndListContainers()
    {
        byte[] source = Encoding.UTF8.GetBytes(
            "<div>\n# html\n</div>\n\n```markdown\n# fenced\n```\n    # indented\n> # quoted\n- item\n  # nested\n# Top\n");
        var provider = new CanonicalRevisionMarkdownStructureProvider();
        var request = new RevisionMarkdownStructureRequest(
            RevisionCompareCanonical.Sha256(source),
            [.. source]);

        RevisionMarkdownStructureReadResult result = await provider.ReadAsync(request);

        RevisionMarkdownHeadingNode heading = Assert.Single(result.Snapshot!.Headings);
        Assert.Equal(1, heading.Level);
        Assert.Equal(11, heading.LineIndex);
        Assert.Equal(
            Encoding.UTF8.GetBytes("# Top\n"),
            source.AsSpan(heading.Source.Offset, heading.Source.Length).ToArray());
    }

    [Fact]
    public async Task CanonicalStructureProvider_RejectsSourceDigestSubstitution()
    {
        byte[] source = Encoding.UTF8.GetBytes("# Heading\n");
        var provider = new CanonicalRevisionMarkdownStructureProvider();

        RevisionMarkdownStructureReadResult result = await provider.ReadAsync(
            new RevisionMarkdownStructureRequest(new string('0', 64), [.. source]));

        Assert.Equal(RevisionMarkdownStructureReadStatus.Invalid, result.Status);
        Assert.Null(result.Snapshot);
    }
}
