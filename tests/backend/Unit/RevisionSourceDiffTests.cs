using System.Collections.Immutable;
using System.Text;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RevisionSourceDiffTests
{
    [Fact]
    public async Task ComputeAsync_PreservesBomLineEndingsWhitespaceAndFinalNewlineAsBytes()
    {
        byte[] baseline = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("alpha\r\nbeta  \n")];
        byte[] compare = Encoding.UTF8.GetBytes("alpha\nbeta\r");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
        Assert.Equal(baseline.Length, result.Chunks.SelectMany(static chunk => chunk.Hunks).Sum(static hunk => hunk.Base.Length));
        Assert.Equal(compare.Length, result.Chunks.SelectMany(static chunk => chunk.Hunks).Sum(static hunk => hunk.Compare.Length));
        Assert.Contains(result.Chunks.SelectMany(static chunk => chunk.Hunks), static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.Equal(
            [RevisionLineTerminator.CarriageReturnLineFeed, RevisionLineTerminator.LineFeed],
            result.BaseLines.Select(static line => line.TerminatorKind));
        Assert.Equal(
            [RevisionLineTerminator.LineFeed, RevisionLineTerminator.CarriageReturn],
            result.CompareLines.Select(static line => line.TerminatorKind));
        Assert.Equal(RevisionSourceDiffEngine.SegmenterVersion, result.Receipt.SegmenterVersion);
        Assert.Equal(baseline.Length, result.Receipt.BaseSourceByteCount);
        Assert.Equal(compare.Length, result.Receipt.CompareSourceByteCount);
        Assert.Equal(result.BaseLines.Length, result.Receipt.BaseLineCount);
        Assert.Equal(result.CompareLines.Length, result.Receipt.CompareLineCount);
        Assert.Equal(result.Receipt.ContentDigest, result.AttemptReceipt.SemanticContentDigest);
        Assert.True(result.Receipt.EstimatedMemoryBytes > 0);
        Assert.True(result.Receipt.EstimatedOutputBytes > 0);
    }

    [Fact]
    public async Task ComputeAsync_IdenticalSourceProducesOneExactEqualHunk()
    {
        byte[] source = Encoding.UTF8.GetBytes("same\r\ncontent without final newline");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(source, source);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk hunk = Assert.Single(Assert.Single(result.Chunks).Hunks);
        Assert.Equal(RevisionDiffKind.Equal, hunk.Kind);
        Assert.Equal(new RevisionByteRange(0, source.Length), hunk.Base);
        Assert.Equal(new RevisionByteRange(0, source.Length), hunk.Compare);
        Assert.Empty(hunk.WordEdits);
    }

    [Fact]
    public async Task ComputeAsync_WordRefinementUsesExactUnicodeGraphemeByteRanges()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("前言 emoji 👩‍💻 cafe\u0301 مرحبا https://a.test/路径\n");
        byte[] compare = Encoding.UTF8.GetBytes("前言 emoji 👩‍🔬 café مرحبتين https://b.test/路径\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk replacement = Assert.Single(
            result.Chunks.SelectMany(static chunk => chunk.Hunks),
            static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.Equal(2, replacement.WordEdits.Length);
        Assert.All(replacement.WordEdits, edit =>
        {
            Assert.True(edit.Base.Offset >= 0 && edit.Base.End <= baseline.Length);
            Assert.True(edit.Compare.Offset >= 0 && edit.Compare.End <= compare.Length);
            Assert.NotEqual(
                baseline.AsSpan(edit.Base.Offset, edit.Base.Length).ToArray(),
                compare.AsSpan(edit.Compare.Offset, edit.Compare.Length).ToArray());
        });
        Assert.True(result.Receipt.TokenCount > 0);
    }

    [Fact]
    public async Task ComputeAsync_WordRefinementPreservesStableMiddleAnchors()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("alpha old middle bad omega\n");
        byte[] compare = Encoding.UTF8.GetBytes("alpha new middle good omega\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk replacement = Assert.Single(
            result.Chunks.SelectMany(static chunk => chunk.Hunks),
            static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.Equal(2, replacement.WordEdits.Length);
        Assert.All(replacement.WordEdits, static edit => Assert.Equal(RevisionDiffKind.Replace, edit.Kind));
        Assert.Equal("old", Encoding.UTF8.GetString(
            baseline.AsSpan(replacement.WordEdits[0].Base.Offset, replacement.WordEdits[0].Base.Length)));
        Assert.Equal("new", Encoding.UTF8.GetString(
            compare.AsSpan(replacement.WordEdits[0].Compare.Offset, replacement.WordEdits[0].Compare.Length)));
    }

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

    [Fact]
    public async Task ComputeAsync_ChunksClosedHunksAndRemainsDeterministic()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("a\nkeep-1\nb\nkeep-2\nc\n");
        byte[] compare = Encoding.UTF8.GetBytes("x\nkeep-1\ny\nkeep-2\nz\n");
        RevisionCompareBudgets budgets = Budgets() with
        {
            MaxHunksPerChunk = 1,
            MaxChunks = 16
        };
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare, budgets);

        RevisionSourceDiffResult first = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        RevisionSourceDiffResult second = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(first.Chunks.Length > 1);
        Assert.All(first.Chunks, static chunk => Assert.Single(chunk.Hunks));
        Assert.Equal(first.Receipt, second.Receipt);
        Assert.Equal(first.Receipt.ContentDigest, second.Receipt.ContentDigest);
        Assert.Equal(first.Chunks.Select(static chunk => chunk.ContentDigest), second.Chunks.Select(static chunk => chunk.ContentDigest));
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, first));
    }

    [Fact]
    public async Task ComputeAsync_EnforcesAdmittedHunkAndChunkCapacityBeforeMaterializingOutput()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("one\nkeep-a\ntwo\nkeep-b\nthree\n");
        byte[] compare = Encoding.UTF8.GetBytes("first\nkeep-a\nsecond\nkeep-b\nthird\n");
        RevisionCompareBudgets budgets = Budgets() with
        {
            MaxHunksPerChunk = 1,
            MaxChunks = 2
        };
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            budgets);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.Equal(2, plan.Plan.Admission.HunkLimit);
        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, result.Status);
        Assert.Equal("revision_diff_chunk_budget_exceeded", result.Receipt.ReasonCode);
        Assert.Empty(result.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_ContextGroupsUseStablePlanOwnedLineWindows()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(
            "start\nold-a\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nkeep-6\nold-b\nend\n");
        byte[] compare = Encoding.UTF8.GetBytes(
            "start\nnew-a\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nkeep-6\nnew-b\nend\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            contextLineCount: 1);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffContextGroup collapsed = Assert.Single(
            result.ContextGroups,
            static group => group.Collapsed && group.BaseLineCount == 4);
        Assert.Equal(3, collapsed.BaseStartLine);
        Assert.Equal(3, collapsed.CompareStartLine);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));

        RevisionDiffContextGroup substituted = collapsed with
        {
            Collapsed = false,
            ContentDigest = RevisionSourceDiffEngine.CreateContextGroupDigest(
                collapsed.Index,
                false,
                collapsed.BaseStartLine,
                collapsed.BaseLineCount,
                collapsed.CompareStartLine,
                collapsed.CompareLineCount,
                collapsed.Base,
                collapsed.Compare)
        };
        ImmutableArray<RevisionDiffContextGroup> contextGroups =
        [.. result.ContextGroups.Select(group => group == collapsed ? substituted : group)];
        Assert.False(RevisionSourceDiffVerifier.Verify(
            plan,
            Reseal(plan, result, result.Chunks, contextGroups: contextGroups)));
    }

    [Fact]
    public async Task ComputeAsync_HandlesOneHundredThousandLinesWithinLinearAdmissionEnvelope()
    {
        string[] lines = Enumerable.Range(0, 100_001).Select(static index => $"line-{index:D6}\n").ToArray();
        byte[] baseline = Encoding.UTF8.GetBytes(string.Concat(lines));
        lines[50_000] = "line-changed\n";
        byte[] compare = Encoding.UTF8.GetBytes(string.Concat(lines));
        RevisionCompareBudgets budgets = Budgets() with
        {
            MaxSourceBytes = 2_000_000,
            MaxLineCount = 110_000,
            MaxMemoryBytes = 64 * 1024 * 1024,
            MaxOutputBytes = 16 * 1024 * 1024,
            MaxTokenCount = 10_000,
            TimeoutMilliseconds = 20_000
        };
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare, budgets);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        Assert.Contains(result.Chunks.SelectMany(static chunk => chunk.Hunks), static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
    }

    [Fact]
    public async Task ComputeAsync_FullRewriteRemainsOneClosedReplaceWithoutMoveInference()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(string.Concat(
            Enumerable.Range(0, 64).Select(static index => $"old-{index:D2}\n")));
        byte[] compare = Encoding.UTF8.GetBytes(string.Concat(
            Enumerable.Range(0, 64).Select(static index => $"new-{index:D2}\n")));
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk hunk = Assert.Single(result.Chunks.SelectMany(static chunk => chunk.Hunks));
        Assert.Equal(RevisionDiffKind.Replace, hunk.Kind);
        Assert.DoesNotContain("Move", Enum.GetNames<RevisionDiffKind>());
        Assert.Equal(compare, Apply(result, baseline, compare, forward: true));
        Assert.Equal(baseline, Apply(result, baseline, compare, forward: false));
    }

    [Fact]
    public async Task ComputeAsync_FailsClosedForTokenBudgetAndCancellation()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("abcdefghij\n");
        byte[] compare = Encoding.UTF8.GetBytes("0123456789\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            Budgets() with
            {
                MaxTokenCount = 3
            });

        RevisionSourceDiffResult budget = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        RevisionSourceDiffResult cancellation = await engine.ComputeAsync(
            plan,
            DateTimeOffset.UtcNow,
            cancelled.Token);

        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, budget.Status);
        Assert.Equal("revision_diff_token_budget_exceeded", budget.Receipt.ReasonCode);
        Assert.Equal(RevisionComparePlanStatus.Cancelled, cancellation.Status);
        Assert.Empty(cancellation.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_CoalescesLongSingleTokensWithoutQuadraticRebuilding()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(new string('a', 500_000));
        byte[] compare = Encoding.UTF8.GetBytes(new string('b', 500_000));
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            Budgets() with
            {
                MaxTokenCount = 2
            });

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        Assert.Equal(2, result.Receipt.TokenCount);
        Assert.Equal(compare, Apply(result, baseline, compare, forward: true));
        Assert.Equal(baseline, Apply(result, baseline, compare, forward: false));
    }

    [Fact]
    public async Task ComputeAsync_StopsLargeSymbolTokenizationAtIncrementalBudget()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(new string('!', 250_000));
        byte[] compare = Encoding.UTF8.GetBytes(new string('?', 250_000));
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            Budgets() with
            {
                MaxTokenCount = 32
            });

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, result.Status);
        Assert.Equal("revision_diff_token_budget_exceeded", result.Receipt.ReasonCode);
        Assert.Empty(result.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_CancelsWhileScanningLargeSingleToken()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(new string('a', 1_500_000));
        byte[] compare = Encoding.UTF8.GetBytes(new string('b', 1_500_000));
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            Budgets() with
            {
                MaxSourceBytes = 1_600_000,
                MaxTokenCount = 2,
                TimeoutMilliseconds = 10_000
            });
        using var cancellation = new CancellationTokenSource();

        Task<RevisionSourceDiffResult> pending = engine.ComputeAsync(
            plan,
            DateTimeOffset.UtcNow,
            cancellation.Token);
        await Task.Delay(10);
        cancellation.Cancel();
        RevisionSourceDiffResult result = await pending;

        Assert.Equal(RevisionComparePlanStatus.Cancelled, result.Status);
        Assert.Equal("revision_diff_cancelled", result.Receipt.ReasonCode);
        Assert.Empty(result.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_RejectsDraftEpochDriftDuringExactPackageReread()
    {
        RevisionComparePackage draft = DraftPackage("epoch-a", 4, "draft\n");
        RevisionComparePackage historical = Package(
            RevisionCompareSourceKind.HistoricalRevision,
            11,
            1,
            Encoding.UTF8.GetBytes("history\n"));
        var reader = new MutableReader(draft, historical);
        var request = new RevisionComparePlanRequest(
            7,
            new RevisionCompareReadContext(5, "primary", Guid.Parse("f6cc3f8c-b06f-437c-8c0f-91da744ad783")),
            new RevisionCompareSourceSelector(
                RevisionCompareSourceKind.CurrentDraft,
                DraftKey: "draft-key",
                ExpectedServerRevision: 4,
                DocumentEpoch: "epoch-a"),
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11),
            new RevisionCompareOptions(
                RevisionCompareViewMode.Unified,
                RevisionCompareWordSegmentation.UnicodeTextElementsV1,
                3,
                false,
                ["title"]),
            Budgets(),
            "diff:7:draft:11",
            DateTimeOffset.UtcNow.AddMinutes(5));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(request);
        Assert.True(planned.IsSuccess, planned.Receipt.ReasonCode);
        reader.Baseline = DraftPackage("epoch-b", 5, "changed\n");
        var engine = new RevisionSourceDiffEngine(
            new RevisionComparePlanVerifier(reader),
            new RevisionMarkdownStructureAuthority([]));

        RevisionSourceDiffResult result = await engine.ComputeAsync(planned.Bundle!, DateTimeOffset.UtcNow);

        Assert.Equal(RevisionComparePlanStatus.Stale, result.Status);
        Assert.Equal("revision_compare_source_stale", result.Receipt.ReasonCode);
        Assert.Empty(result.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_RejectsDraftDriftWhileCanonicalStructureReadIsInFlight()
    {
        RevisionComparePackage draft = DraftPackage("epoch-a", 4, "# Draft\nbody\n");
        RevisionComparePackage historical = Package(
            RevisionCompareSourceKind.HistoricalRevision,
            11,
            1,
            Encoding.UTF8.GetBytes("# History\nbody\n"));
        var reader = new MutableReader(draft, historical);
        var request = new RevisionComparePlanRequest(
            7,
            new RevisionCompareReadContext(5, "primary", Guid.Parse("f6cc3f8c-b06f-437c-8c0f-91da744ad783")),
            new RevisionCompareSourceSelector(
                RevisionCompareSourceKind.CurrentDraft,
                DraftKey: "draft-key",
                ExpectedServerRevision: 4,
                DocumentEpoch: "epoch-a"),
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11),
            new RevisionCompareOptions(
                RevisionCompareViewMode.Unified,
                RevisionCompareWordSegmentation.UnicodeTextElementsV1,
                3,
                true,
                ["title"]),
            Budgets(),
            "diff:7:draft:11",
            DateTimeOffset.UtcNow.AddMinutes(5));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(request);
        Assert.True(planned.IsSuccess, planned.Receipt.ReasonCode);
        var provider = new CoordinatedStructureProvider(
            Structure(draft.RawMarkdown.ToArray(), (1, 0, LineRange(draft.RawMarkdown.ToArray(), 0, 1))),
            Structure(historical.RawMarkdown.ToArray(), (1, 0, LineRange(historical.RawMarkdown.ToArray(), 0, 1))));
        var engine = new RevisionSourceDiffEngine(
            new RevisionComparePlanVerifier(reader),
            new RevisionMarkdownStructureAuthority([provider]));

        Task<RevisionSourceDiffResult> pending = engine.ComputeAsync(planned.Bundle!, DateTimeOffset.UtcNow);
        await provider.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        reader.Baseline = DraftPackage("epoch-b", 5, "# Changed\nbody\n");
        provider.Release.TrySetResult();
        RevisionSourceDiffResult result = await pending;

        Assert.Equal(RevisionComparePlanStatus.Stale, result.Status);
        Assert.Equal("revision_compare_source_stale", result.Receipt.ReasonCode);
        Assert.Empty(result.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_RejectsLateStructureResponseAfterRequestCancellation()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("# Old\nbody\n");
        byte[] compare = Encoding.UTF8.GetBytes("# New\nbody\n");
        var provider = new LateStructureProvider(
            TimeSpan.FromMilliseconds(30),
            Structure(baseline, (1, 0, LineRange(baseline, 0, 1))),
            Structure(compare, (1, 0, LineRange(compare, 0, 1))));
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            headingNavigation: true,
            structureProvider: provider);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(5));

        RevisionSourceDiffResult result = await engine.ComputeAsync(
            plan,
            DateTimeOffset.UtcNow,
            cancellation.Token);

        Assert.Equal(RevisionComparePlanStatus.Cancelled, result.Status);
        Assert.Equal("revision_diff_cancelled", result.Receipt.ReasonCode);
        Assert.Empty(result.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_FailsClosedForStructureTimeoutAndWorkerMemoryBudget()
    {
        byte[] headingBase = Encoding.UTF8.GetBytes("# Old\nbody\n");
        byte[] headingCompare = Encoding.UTF8.GetBytes("# New\nbody\n");
        var slowProvider = new LateStructureProvider(
            TimeSpan.FromMilliseconds(30),
            Structure(headingBase, (1, 0, LineRange(headingBase, 0, 1))),
            Structure(headingCompare, (1, 0, LineRange(headingCompare, 0, 1))));
        (RevisionSourceDiffEngine timeoutEngine, RevisionComparePlanBundle timeoutPlan) = await SetupAsync(
            headingBase,
            headingCompare,
            Budgets() with
            {
                TimeoutMilliseconds = 10
            },
            headingNavigation: true,
            structureProvider: slowProvider);

        RevisionSourceDiffResult timeout = await timeoutEngine.ComputeAsync(timeoutPlan, DateTimeOffset.UtcNow);

        Assert.Equal(RevisionComparePlanStatus.Cancelled, timeout.Status);
        Assert.Equal("revision_diff_timeout", timeout.Receipt.ReasonCode);
        Assert.Empty(timeout.Chunks);

        byte[] baseline = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("x\n", 100)));
        byte[] compare = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("y\n", 100)));
        (RevisionSourceDiffEngine memoryEngine, RevisionComparePlanBundle memoryPlan) = await SetupAsync(
            baseline,
            compare,
            Budgets() with
            {
                MaxMemoryBytes = 20_000
            });

        RevisionSourceDiffResult memory = await memoryEngine.ComputeAsync(memoryPlan, DateTimeOffset.UtcNow);

        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, memory.Status);
        Assert.Equal("revision_diff_memory_budget_exceeded", memory.Receipt.ReasonCode);
        Assert.Empty(memory.Chunks);
    }

    [Fact]
    public async Task Verify_RejectsMutatedClosedRange()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("one\n");
        byte[] compare = Encoding.UTF8.GetBytes("two\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);
        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        RevisionDiffChunk chunk = Assert.Single(result.Chunks);
        RevisionDiffHunk hunk = Assert.Single(chunk.Hunks);
        RevisionSourceDiffResult tampered = result with
        {
            Chunks = [chunk with { Hunks = [hunk with { Base = new RevisionByteRange(1, hunk.Base.Length) }] }]
        };

        Assert.False(RevisionSourceDiffVerifier.Verify(plan, tampered));
    }

    [Fact]
    public async Task Verify_RejectsOverflowingLineCoordinatesWithoutThrowing()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("one\n");
        byte[] compare = Encoding.UTF8.GetBytes("two\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);
        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        RevisionDiffLine line = Assert.Single(result.BaseLines);
        RevisionSourceDiffResult tampered = result with
        {
            BaseLines = [line with
            {
                Content = new RevisionByteRange(0, int.MaxValue),
                Terminator = new RevisionByteRange(int.MaxValue, 1)
            }]
        };

        Assert.False(RevisionSourceDiffVerifier.Verify(plan, tampered));
    }

    [Fact]
    public async Task Verify_RejectsResealedWordKindAndOrderingTamper()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("alpha old middle bad omega\n");
        byte[] compare = Encoding.UTF8.GetBytes("alpha new middle good omega\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);
        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        RevisionDiffChunk chunk = Assert.Single(result.Chunks);
        RevisionDiffHunk hunk = Assert.Single(chunk.Hunks, static candidate => candidate.Kind == RevisionDiffKind.Replace);
        RevisionDiffWordEdit first = hunk.WordEdits[0] with
        {
            Kind = RevisionDiffKind.Insert
        };
        RevisionDiffHunk tamperedHunk = hunk with
        {
            WordEdits = [hunk.WordEdits[1], first]
        };
        ImmutableArray<RevisionDiffHunk> hunks = [.. chunk.Hunks.Select(item => item == hunk ? tamperedHunk : item)];
        RevisionDiffChunk tamperedChunk = chunk with
        {
            Hunks = hunks,
            ContentDigest = RevisionSourceDiffEngine.CreateChunkDigest(chunk.Index, hunks)
        };
        RevisionSourceDiffResult tampered = Reseal(plan, result, [tamperedChunk]);

        Assert.False(RevisionSourceDiffVerifier.Verify(plan, tampered));
    }

    [Fact]
    public async Task ComputeAsync_TreatsStructuredMarkdownAsRawSourceWithoutHtmlOrRegexSubstitution()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(
            "| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```\n\n$x^2$\n![alt](a.png) [link](https://a.test/x?q=1)\n");
        byte[] compare = Encoding.UTF8.GetBytes(
            "| a | b |\n|---|---|\n| 1 | 3 |\n\n```mermaid\ngraph TD; A-->C\n```\n\n$x^3$\n![alt](b.png) [link](https://a.test/x?q=2)\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        byte[] reconstructedCompare = result.Chunks
            .SelectMany(static chunk => chunk.Hunks)
            .SelectMany(hunk => compare.AsSpan(hunk.Compare.Offset, hunk.Compare.Length).ToArray())
            .ToArray();
        Assert.Equal(compare, reconstructedCompare);
        Assert.Empty(result.CompareHeadings);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
    }

    [Theory]
    [InlineData("", "insert\n", RevisionDiffKind.Insert)]
    [InlineData("delete\n", "", RevisionDiffKind.Delete)]
    [InlineData("", "", RevisionDiffKind.Equal)]
    public async Task ComputeAsync_ClosesEmptyAndOneSidedInputs(
        string baselineText,
        string compareText,
        RevisionDiffKind expected)
    {
        byte[] baseline = Encoding.UTF8.GetBytes(baselineText);
        byte[] compare = Encoding.UTF8.GetBytes(compareText);
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        RevisionDiffHunk[] hunks = [.. result.Chunks.SelectMany(static chunk => chunk.Hunks)];
        if (expected == RevisionDiffKind.Equal && baseline.Length == 0)
        {
            Assert.Empty(hunks);
        }
        else
        {
            Assert.Equal(expected, Assert.Single(hunks).Kind);
        }
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
    }

    [Fact]
    public async Task ComputeAsync_InvalidUtf8SkipsOnlyWordRefinement()
    {
        byte[] baseline = [0x66, 0x6f, 0x80, 0x0a];
        byte[] compare = [0x66, 0x6f, 0x81, 0x0a];
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk replacement = Assert.Single(
            result.Chunks.SelectMany(static chunk => chunk.Hunks),
            static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.Empty(replacement.WordEdits);
        Assert.Equal(baseline.Length, replacement.Base.Length);
        Assert.Equal(compare.Length, replacement.Compare.Length);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
    }

    [Fact]
    public async Task ComputeAsync_RepresentativeAndSeededRandomCorpusAppliesForwardAndReverse()
    {
        var corpus = new List<(byte[] Base, byte[] Compare)>
        {
            ([], []),
            (Encoding.UTF8.GetBytes("same\n"), Encoding.UTF8.GetBytes("same\n")),
            (Encoding.UTF8.GetBytes("a"), Encoding.UTF8.GetBytes("b")),
            (Encoding.UTF8.GetBytes("delete\r\n"), []),
            ([], Encoding.UTF8.GetBytes("insert\r")),
            (
                [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("CJK 中文\r\nemoji 👩‍💻  \n")],
                Encoding.UTF8.GetBytes("CJK 漢字\nemoji 👩‍🔬\r")),
            (
                Encoding.UTF8.GetBytes("```mermaid\ngraph TD; A-->B\n```\n$x^2$ [link](https://a.test/long/path?q=1)\n"),
                Encoding.UTF8.GetBytes("```mermaid\ngraph TD; A-->C\n```\n$x^3$ [link](https://b.test/long/path?q=2)\n"))
        };
        var random = new Random(2270);
        for (int sample = 0; sample < 32; sample++)
        {
            corpus.Add((RandomSource(random), RandomSource(random)));
        }

        foreach ((byte[] baseline, byte[] compare) in corpus)
        {
            (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);
            RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

            Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
            Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
            Assert.Equal(compare, Apply(result, baseline, compare, forward: true));
            Assert.Equal(baseline, Apply(result, baseline, compare, forward: false));
        }
    }

    [Fact]
    public void EngineSource_HasNoHtmlRegexDraftMutationOrFragmentInsertionAuthority()
    {
        string source = File.ReadAllText(Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "src",
            "core",
            "Services",
            "Articles",
            "RevisionSourceDiff.cs"));

        Assert.DoesNotContain("Regex", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Html", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("CurrentDraft", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Fragment", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("MarkdownContent", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ParseHeadings", source, StringComparison.Ordinal);
        Assert.DoesNotContain("AtxLevel", source, StringComparison.Ordinal);
        Assert.DoesNotContain("SetextLevel", source, StringComparison.Ordinal);
        Assert.DoesNotContain("TryFence", source, StringComparison.Ordinal);
        Assert.DoesNotContain("AiSummary", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("QualityScore", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(".Trim(", source, StringComparison.Ordinal);
        Assert.Contains("IRevisionMarkdownStructureAuthority", source, StringComparison.Ordinal);
        Assert.Contains("Task.Run(", source, StringComparison.Ordinal);
        Assert.Equal(1, Directory.EnumerateFiles(
                Path.Combine(BackendTestPaths.RepositoryRoot, "src"),
                "*.cs",
                SearchOption.AllDirectories)
            .Count(path => File.ReadAllText(path).Contains(
                "class RevisionSourceDiffEngine",
                StringComparison.Ordinal)));
    }

    [Fact]
    public async Task ComputeAsync_RejectsExpiredPlanAndBoundedOutput()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("one\nkeep\ntwo\n");
        byte[] compare = Encoding.UTF8.GetBytes("first\nkeep\nsecond\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            Budgets() with
            {
                MaxOutputBytes = 400
            });

        RevisionSourceDiffResult expired = await engine.ComputeAsync(
            plan,
            plan.Plan.ExpiresAtUtc.AddTicks(1));
        RevisionSourceDiffResult bounded = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.Equal(RevisionComparePlanStatus.Stale, expired.Status);
        Assert.Equal("revision_compare_plan_expired", expired.Receipt.ReasonCode);
        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, bounded.Status);
        Assert.Equal("revision_diff_output_budget_exceeded", bounded.Receipt.ReasonCode);
        Assert.Empty(bounded.Chunks);
    }

    private static async Task<(RevisionSourceDiffEngine Engine, RevisionComparePlanBundle Bundle)> SetupAsync(
        byte[] baseline,
        byte[] compare,
        RevisionCompareBudgets? budgets = null,
        int contextLineCount = 3,
        bool headingNavigation = false,
        IRevisionMarkdownStructureProvider? structureProvider = null)
    {
        RevisionComparePackage basePackage = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, baseline);
        RevisionComparePackage comparePackage = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, compare);
        var reader = new FixedReader(basePackage, comparePackage);
        RevisionComparePlanRequest request = new(
            7,
            new RevisionCompareReadContext(5, "primary", Guid.Parse("f6cc3f8c-b06f-437c-8c0f-91da744ad783")),
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11),
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.CurrentRevision, RevisionId: 12),
            new RevisionCompareOptions(
                RevisionCompareViewMode.Unified,
                RevisionCompareWordSegmentation.UnicodeTextElementsV1,
                contextLineCount,
                headingNavigation,
                ["title"]),
            budgets ?? Budgets(),
            "diff:7:11:12",
            DateTimeOffset.UtcNow.AddMinutes(5));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(request);
        Assert.True(planned.IsSuccess, planned.Receipt.ReasonCode);
        return (
            new RevisionSourceDiffEngine(
                new RevisionComparePlanVerifier(reader),
                new RevisionMarkdownStructureAuthority(
                    structureProvider is null ? [] : [structureProvider])),
            planned.Bundle!);
    }

    private static RevisionMarkdownStructureSnapshot Structure(
        byte[] source,
        params (int Level, int LineIndex, RevisionByteRange Range)[] headings)
    {
        string sourceDigest = RevisionCompareCanonical.Sha256(source);
        var request = new RevisionMarkdownStructureRequest(sourceDigest, [.. source]);
        return RevisionMarkdownStructureSnapshotSeal.Create(
            request,
            "canonical-markdown-test-v1",
            headings.Select(heading => new RevisionMarkdownHeadingNode(
                heading.Level,
                heading.LineIndex,
                heading.Range,
                RevisionCompareCanonical.Sha256(source.AsSpan(heading.Range.Offset, heading.Range.Length)))));
    }

    private static RevisionByteRange LineRange(byte[] source, int startLine, int lineCount)
    {
        int line = 0;
        int start = 0;
        for (int index = 0; index < source.Length && line < startLine; index++)
        {
            if (source[index] == (byte)'\n')
            {
                line++;
                start = index + 1;
            }
        }
        int end = start;
        for (int index = start; index < source.Length && line < startLine + lineCount; index++)
        {
            end = index + 1;
            if (source[index] == (byte)'\n')
            {
                line++;
            }
        }
        return new RevisionByteRange(start, end - start);
    }

    private static RevisionCompareBudgets Budgets()
        => new(2_000_000, 110_000, 100_000, 8 * 1024 * 1024, 64 * 1024 * 1024, 1_000, 64, 10_000);

    private static RevisionSourceDiffResult Reseal(
        RevisionComparePlanBundle bundle,
        RevisionSourceDiffResult source,
        ImmutableArray<RevisionDiffChunk> chunks,
        ImmutableArray<RevisionDiffHeading>? baseHeadings = null,
        ImmutableArray<RevisionDiffHeading>? compareHeadings = null,
        ImmutableArray<RevisionDiffContextGroup>? contextGroups = null)
    {
        ImmutableArray<RevisionDiffHeading> resolvedBaseHeadings = baseHeadings ?? source.BaseHeadings;
        ImmutableArray<RevisionDiffHeading> resolvedCompareHeadings = compareHeadings ?? source.CompareHeadings;
        ImmutableArray<RevisionDiffContextGroup> resolvedContextGroups = contextGroups ?? source.ContextGroups;
        long estimatedOutput = chunks.Sum(static chunk => chunk.Hunks.Length) * 192L
            + chunks.Sum(static chunk => chunk.Hunks.Sum(static hunk =>
                (long)hunk.WordEdits.Length * 80L + hunk.HeadingIdentities.Length * 72L))
            + (resolvedBaseHeadings.Length + resolvedCompareHeadings.Length) * 96L
            + resolvedContextGroups.Length * 128L
            + ((long)source.BaseLines.Length + source.CompareLines.Length) * 48L;
        RevisionSourceDiffReceipt receipt = RevisionSourceDiffEngine.CreateReceipt(
            bundle,
            source.Status,
            source.Receipt.ReasonCode,
            source.Receipt.StructureParserVersion,
            source.Receipt.BaseStructureDigest,
            source.Receipt.CompareStructureDigest,
            source.BaseLines,
            source.CompareLines,
            resolvedBaseHeadings,
            resolvedCompareHeadings,
            resolvedContextGroups,
            source.Receipt.EstimatedMemoryBytes,
            estimatedOutput,
            source.Receipt.TokenCount,
            chunks);
        return source with
        {
            Chunks = chunks,
            BaseHeadings = resolvedBaseHeadings,
            CompareHeadings = resolvedCompareHeadings,
            ContextGroups = resolvedContextGroups,
            Receipt = receipt,
            AttemptReceipt = RevisionSourceDiffEngine.CreateAttemptReceipt(
                receipt,
                source.AttemptReceipt.ElapsedMilliseconds)
        };
    }

    private static byte[] Apply(
        RevisionSourceDiffResult result,
        byte[] baseline,
        byte[] compare,
        bool forward)
    {
        var output = new List<byte>();
        foreach (RevisionDiffHunk hunk in result.Chunks.SelectMany(static chunk => chunk.Hunks))
        {
            if (forward)
            {
                if (hunk.Kind == RevisionDiffKind.Equal)
                {
                    output.AddRange(baseline.AsSpan(hunk.Base.Offset, hunk.Base.Length).ToArray());
                }
                else if (hunk.Kind is RevisionDiffKind.Insert or RevisionDiffKind.Replace)
                {
                    output.AddRange(compare.AsSpan(hunk.Compare.Offset, hunk.Compare.Length).ToArray());
                }
            }
            else if (hunk.Kind == RevisionDiffKind.Equal)
            {
                output.AddRange(compare.AsSpan(hunk.Compare.Offset, hunk.Compare.Length).ToArray());
            }
            else if (hunk.Kind is RevisionDiffKind.Delete or RevisionDiffKind.Replace)
            {
                output.AddRange(baseline.AsSpan(hunk.Base.Offset, hunk.Base.Length).ToArray());
            }
        }
        return [.. output];
    }

    private static byte[] RandomSource(Random random)
    {
        string[] fragments =
        [
            "alpha",
            "中文",
            "مرحبا",
            "emoji 👩‍💻",
            "cafe\u0301",
            "https://example.test/a/very/long/path?q=1",
            "| a | b |",
            "$x^2$",
            "  trailing  "
        ];
        string[] terminators = ["\n", "\r\n", "\r"];
        var source = new StringBuilder();
        int lineCount = random.Next(0, 40);
        for (int index = 0; index < lineCount; index++)
        {
            source.Append(fragments[random.Next(fragments.Length)]);
            if (index + 1 < lineCount || random.Next(2) == 0)
            {
                source.Append(terminators[random.Next(terminators.Length)]);
            }
        }
        return Encoding.UTF8.GetBytes(source.ToString());
    }

    private static RevisionComparePackage Package(
        RevisionCompareSourceKind kind,
        long revisionId,
        int revisionNo,
        byte[] markdown)
        => RevisionComparePackageSeal.Create(
            7,
            kind,
            $"revision:{revisionId}",
            revisionId,
            revisionNo,
            null,
            null,
            markdown,
            [RevisionCompareMetadataRegistry.String("title", "Title")],
            [
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Rights),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
            ]);

    private static RevisionComparePackage DraftPackage(
        string documentEpoch,
        long serverRevision,
        string markdown)
        => RevisionComparePackageSeal.Create(
            7,
            RevisionCompareSourceKind.CurrentDraft,
            $"draft:5:draft-key:{serverRevision}:{documentEpoch}",
            null,
            null,
            serverRevision,
            documentEpoch,
            Encoding.UTF8.GetBytes(markdown),
            [RevisionCompareMetadataRegistry.String("title", "Title")],
            [
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Rights),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
            ]);

    private sealed class FixedReader(
        RevisionComparePackage baseline,
        RevisionComparePackage compare) : IRevisionComparePackageReader
    {
        public Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(
            RevisionCompareReadContext context,
            int articleId,
            RevisionCompareSourceSelector selector,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(RevisionComparePackageReadResult.Available(
                selector.RevisionId == baseline.RevisionId ? baseline : compare));
        }
    }

    private sealed class MutableReader(
        RevisionComparePackage baseline,
        RevisionComparePackage compare) : IRevisionComparePackageReader
    {
        public RevisionComparePackage Baseline { get; set; } = baseline;

        public RevisionComparePackage Compare { get; set; } = compare;

        public Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(
            RevisionCompareReadContext context,
            int articleId,
            RevisionCompareSourceSelector selector,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(RevisionComparePackageReadResult.Available(
                selector.Kind == RevisionCompareSourceKind.CurrentDraft ? Baseline : Compare));
        }
    }

    private sealed class FixedStructureProvider(
        params RevisionMarkdownStructureSnapshot[] snapshots) : IRevisionMarkdownStructureProvider
    {
        private readonly IReadOnlyDictionary<string, RevisionMarkdownStructureSnapshot> _snapshots = snapshots
            .ToDictionary(static snapshot => snapshot.SourceDigest, StringComparer.Ordinal);

        public Task<RevisionMarkdownStructureReadResult> ReadAsync(
            RevisionMarkdownStructureRequest request,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(_snapshots.TryGetValue(request.SourceDigest, out RevisionMarkdownStructureSnapshot? snapshot)
                ? RevisionMarkdownStructureReadResult.Available(snapshot)
                : RevisionMarkdownStructureReadResult.Unavailable());
        }
    }

    private sealed class LateStructureProvider(
        TimeSpan delay,
        params RevisionMarkdownStructureSnapshot[] snapshots) : IRevisionMarkdownStructureProvider
    {
        private readonly IReadOnlyDictionary<string, RevisionMarkdownStructureSnapshot> _snapshots = snapshots
            .ToDictionary(static snapshot => snapshot.SourceDigest, StringComparer.Ordinal);

        public async Task<RevisionMarkdownStructureReadResult> ReadAsync(
            RevisionMarkdownStructureRequest request,
            CancellationToken cancellationToken = default)
        {
            await Task.Delay(delay);
            return _snapshots.TryGetValue(request.SourceDigest, out RevisionMarkdownStructureSnapshot? snapshot)
                ? RevisionMarkdownStructureReadResult.Available(snapshot)
                : RevisionMarkdownStructureReadResult.Unavailable();
        }
    }

    private sealed class CoordinatedStructureProvider(
        params RevisionMarkdownStructureSnapshot[] snapshots) : IRevisionMarkdownStructureProvider
    {
        private readonly IReadOnlyDictionary<string, RevisionMarkdownStructureSnapshot> _snapshots = snapshots
            .ToDictionary(static snapshot => snapshot.SourceDigest, StringComparer.Ordinal);
        private int _readCount;

        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task<RevisionMarkdownStructureReadResult> ReadAsync(
            RevisionMarkdownStructureRequest request,
            CancellationToken cancellationToken = default)
        {
            if (Interlocked.Increment(ref _readCount) == 1)
            {
                Started.TrySetResult();
                await Release.Task.WaitAsync(cancellationToken);
            }
            cancellationToken.ThrowIfCancellationRequested();
            return _snapshots.TryGetValue(request.SourceDigest, out RevisionMarkdownStructureSnapshot? snapshot)
                ? RevisionMarkdownStructureReadResult.Available(snapshot)
                : RevisionMarkdownStructureReadResult.Unavailable();
        }
    }
}
