using System.Runtime.CompilerServices;

namespace FsusBlog.V2.Integration.Tests;

public sealed class LocalSearchCorpusReuseTests
{
    private const int DocumentsPerPage = WireLimits.SearchIndexPageSize;
    private static readonly DateTimeOffset Published = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_002_345);
    private static readonly WebPages EmptyPages = new("<html><body><!--fsus-public-content--></body></html>");
    private static readonly Article BaseArticle = new(
        1, 10, 100, 1, 1,
        "FsusBlog AEDS Guide",
        "PostgreSQL dotNet10 博客搜索的公开页 needle",
        Published, Published, Published,
        "Initial summary",
        new TaxonomyName(7, "Lab"),
        [new TaxonomyName(11, "雪"), new TaxonomyName(12, "Search")]);

    [Fact]
    public void CorpusRelevantFieldsInvalidateAffectedPageAndMatchFullEncoderByteForByte()
    {
        var initial = Enumerable.Range(1, DocumentsPerPage + 1).Select(MakeArticle).ToArray();
        var baseline = BuildCorpus(initial);
        AssertMatchesFullEncoder(initial, baseline);
        Assert.Equal((2, 0), (baseline.Pages.Count, baseline.ReusedPageCount));

        // Mutations on the last article (page 2) must invalidate ONLY page 2 while reusing page 1.
        var lastIndex = initial.Length - 1;
        (string Name, Func<Article, Article> Mutate)[] corpusMutations =
        [
            ("Title", a => a with { Title = "FsusBlog AEDS Revised" }),
            ("Title camelCase/case-only", a => a with { Title = "fsusblog aeds guide" }),
            ("Title NFKC", a => a with { Title = "ＦｓｕｓＢｌｏｇ AEDS Guide" }),
            ("Body", a => a with { Body = a.Body + " extra" }),
            ("Body camelCase/case-only", a => a with { Body = "postgresql dotnet10 博客搜索的公开页 needle" }),
            ("Summary text", a => a with { Summary = "Revised summary" }),
            ("Summary cleared to null", a => a with { Summary = null }),
            ("Summary cleared to empty", a => a with { Summary = "" }),
            ("Category removed", a => a with { Category = null }),
            ("Category id", a => a with { Category = new TaxonomyName(8, "Lab") }),
            ("Category renamed", a => a with { Category = new TaxonomyName(7, "Studio") }),
            ("Category empty name", a => a with { Category = new TaxonomyName(7, "") }),
            ("Tags removed", a => a with { Tags = null }),
            ("Tag added", a => a with { Tags = [.. a.Tags!, new TaxonomyName(13, "Extra")] }),
            ("Tag removed", a => a with { Tags = [a.Tags![0]] }),
            ("Tag id", a => a with { Tags = [new TaxonomyName(99, "雪"), a.Tags![1]] }),
            ("Tag renamed", a => a with { Tags = [new TaxonomyName(11, "霜"), a.Tags![1]] }),
            ("Tag order swapped", a => a with { Tags = [a.Tags![1], a.Tags![0]] }),
            ("Tag duplicated", a => a with { Tags = [a.Tags![0], a.Tags![0], a.Tags![1]] }),
            ("Revision", a => a with { Revision = a.Revision + 1 }),
            ("RevisionNo", a => a with { RevisionNo = a.RevisionNo + 1 }),
            ("Publication", a => a with { Publication = a.Publication + 1 }),
            ("PublicationNo", a => a with { PublicationNo = a.PublicationNo + 1 }),
            ("PublishedAt ms", a => a with { PublishedAt = a.PublishedAt.AddMilliseconds(1) }),
            ("Article Id", a => a with { Id = a.Id + 5 }),
        ];

        foreach (var (name, mutate) in corpusMutations)
        {
            var mutated = (Article[])initial.Clone();
            mutated[lastIndex] = mutate(mutated[lastIndex]);
            var next = BuildCorpus(mutated, baseline);
            AssertMatchesFullEncoder(mutated, next, name);
            Assert.Equal((1, 0, -1), (next.ReusedPageCount, next.ReusedFromPageIndex(0), next.ReusedFromPageIndex(1)));
            Assert.Same(baseline.Pages[0], next.Pages[0]);
            Assert.NotSame(baseline.Pages[1], next.Pages[1]);
        }

        // Category null vs empty-name category must never be treated as equal.
        var nullCat = (Article[])initial.Clone();
        nullCat[lastIndex] = nullCat[lastIndex] with { Category = null };
        var nullCatSnap = BuildCorpus(nullCat, baseline);
        var emptyNameCat = (Article[])initial.Clone();
        emptyNameCat[lastIndex] = emptyNameCat[lastIndex] with { Category = new TaxonomyName(7, "") };
        var emptyNameSnap = BuildCorpus(emptyNameCat, nullCatSnap);
        AssertMatchesFullEncoder(emptyNameCat, emptyNameSnap, "null category vs empty-name category");
        Assert.Equal(-1, emptyNameSnap.ReusedFromPageIndex(1));

        // Equivalent null vs empty representations and equivalent UTC instants must reuse all pages.
        var equivalent = (Article[])initial.Clone();
        equivalent[lastIndex] = equivalent[lastIndex] with { Summary = null, Tags = null };
        var eqBase = BuildCorpus(equivalent);
        var equivalent2 = (Article[])equivalent.Clone();
        equivalent2[lastIndex] = equivalent2[lastIndex] with
        {
            Summary = "",
            Tags = [],
            PublishedAt = equivalent2[lastIndex].PublishedAt.ToOffset(TimeSpan.FromHours(8)),
            CreatedAt = equivalent2[lastIndex].CreatedAt.AddDays(3),
            UpdatedAt = equivalent2[lastIndex].UpdatedAt.AddDays(4),
            CoverMediaDigest = new string('a', 64),
        };
        var eqNext = BuildCorpus(equivalent2, eqBase);
        AssertMatchesFullEncoder(equivalent2, eqNext, "equivalent normalized inputs");
        Assert.Equal(2, eqNext.ReusedPageCount);
        Assert.Same(eqBase.Pages[0], eqNext.Pages[0]);
        Assert.Same(eqBase.Pages[1], eqNext.Pages[1]);
    }

    [Fact]
    public void MutatingCallerTagListAfterBuildDoesNotCorruptSnapshotOrCauseFalseReuse()
    {
        var mutableTags = new List<TaxonomyName> { new(11, "Alpha"), new(12, "Beta") };
        var article = BaseArticle with { Id = 1, Tags = mutableTags };
        var snap1 = BuildCorpus([article]);
        var expectedBefore = LocalSearchCorpus.Build([article with { Tags = [new(11, "Alpha"), new(12, "Beta")] }])![0];
        Assert.Equal(expectedBefore, snap1.Pages[0]);

        mutableTags[0] = new TaxonomyName(11, "Gamma");
        var snap2 = BuildCorpus([article], snap1);
        Assert.Equal(0, snap2.ReusedPageCount);
        Assert.NotSame(snap1.Pages[0], snap2.Pages[0]);
        Assert.Equal(expectedBefore, snap1.Pages[0]);
        AssertMatchesFullEncoder([article], snap2, "mutated caller tag list");
    }

    [Fact]
    public void SixHundredOneArticleFourPageScenariosMatchFullEncoderAndReuseExpectedPages()
    {
        var initial = Enumerable.Range(1, 3 * DocumentsPerPage + 1).Select(MakeArticle).ToArray();
        var cursor = new PublicListCursor(TimeProvider.System);
        var snap0 = CreateSnapshot(1, initial, previous: null, cursor);
        AssertPageCounts(snap0, 4, 0);
        AssertSnapshotCorpusMatchesFullEncoder(initial, snap0);

        // 1. Edit last article (#601 on page 4): reuses pages 1..3 + ETags.
        var editLast = (Article[])initial.Clone();
        editLast[^1] = editLast[^1] with { Revision = 11, RevisionNo = 2, Publication = 200, PublicationNo = 2, Body = editLast[^1].Body + " updated601" };
        var snapEditLast = CheckScenario(2, editLast, snap0, 4, [1, 2, 3]);
        var fullEditLast = CreateSnapshot(2, editLast, previous: null, cursor);
        Assert.Equal(fullEditLast.Generation, snapEditLast.Generation);
        Assert.Equal(
            SearchCorpusPatch.TryCreate(snap0.Generation, fullEditLast.Generation, 4, snap0.Corpus(4)!, fullEditLast.Corpus(4)!,
                Convert.FromHexString(snap0.CorpusTag(4).Tag.ToString()[1..^1]),
                Convert.FromHexString(fullEditLast.CorpusTag(4).Tag.ToString()[1..^1]), CancellationToken.None),
            snapEditLast.CorpusPatch(4, snap0.GenerationHeader, snap0.CorpusTag(4).Tag.ToString()));

        // 2. Edit first article (#1 on page 1): rebuilds page 1, reuses pages 2..4 + ETags.
        var editFirst = (Article[])editLast.Clone();
        editFirst[0] = editFirst[0] with { Revision = 12, RevisionNo = 2, Publication = 201, PublicationNo = 2, Title = "Edited first article" };
        var snapEditFirst = CheckScenario(3, editFirst, snapEditLast, 4, [2, 3, 4]);

        // 3. Edit middle article (#250 on page 2): reuses pages 1, 3, 4 + ETags, emits FSPT patch for page 2.
        var editMiddle = (Article[])editFirst.Clone();
        editMiddle[249] = editMiddle[249] with { Revision = 13, RevisionNo = 2, Publication = 202, PublicationNo = 2, Body = editMiddle[249].Body + "!" };
        var snapEditMiddle = CheckScenario(4, editMiddle, snapEditFirst, 4, [1, 3, 4]);
        var patch2 = snapEditMiddle.CorpusPatch(2, snapEditFirst.GenerationHeader, snapEditFirst.CorpusTag(2).Tag.ToString());
        Assert.NotNull(patch2);
        Assert.True(patch2.AsSpan(0, 4).SequenceEqual("FSPT"u8));

        // 4. Rename category across all 601 articles: reuses 0 of 4 pages.
        var renamedCategory = editMiddle.Select(a => a with { Category = new TaxonomyName(7, "RenamedLab") }).ToArray();
        var snapRenamed = CheckScenario(5, renamedCategory, snapEditMiddle, 4, []);

        // 5. Withdraw middle article (#201): 600 articles -> 3 pages, page 1 reused, pages 2..3 shifted & rebuilt.
        var withdrawMid = renamedCategory.Where(a => a.Id != 201).ToArray();
        var snapWithdrawMid = CheckScenario(6, withdrawMid, snapRenamed, 3, [1]);
        Assert.False(snapWithdrawMid.HasArticle(201));

        // 6. Withdraw last article (#601 from 601-article set): 600 articles -> 3 pages, ALL 3 pages reused.
        CheckScenario(7, renamedCategory[..^1], snapRenamed, 3, [1, 2, 3]);

        // 7. Insert article #602: 602 articles -> 4 pages, pages 1..3 reused, page 4 rebuilt.
        CheckScenario(8, renamedCategory.Append(MakeArticle(602) with { Category = new TaxonomyName(7, "RenamedLab") }).ToArray(),
            snapRenamed, 4, [1, 2, 3]);

        PublicSnapshot CheckScenario(long watermark, Article[] rows, PublicSnapshot prev, int totalPages, int[] reusedPages)
        {
            var next = CreateSnapshot(watermark, rows, prev, cursor);
            AssertPageCounts(next, totalPages, reusedPages.Length);
            Assert.NotEqual(prev.Generation, next.Generation);
            for (var p = 1; p <= totalPages; p++)
            {
                if (reusedPages.Contains(p)) AssertReusedPage(prev, next, p);
                else Assert.NotSame(prev.Corpus(p), next.Corpus(p));
            }
            AssertSnapshotCorpusMatchesFullEncoder(rows, next);
            return next;
        }
    }

    [Fact]
    public void CoverAndTaxonomyEpochChangesReuseAllCorpusPagesWhileStillAdvancingSnapshotGeneration()
    {
        var initial = Enumerable.Range(1, 2 * DocumentsPerPage + 5).Select(MakeArticle).ToArray();
        var cursor = new PublicListCursor(TimeProvider.System);
        var snap1 = CreateSnapshot(1, initial, previous: null, cursor, taxonomyEpoch: 10);

        // Cover digest change does not alter corpus bytes, yet MUST advance PublicGeneration and snapshot state.
        var withCover = (Article[])initial.Clone();
        withCover[0] = withCover[0] with { CoverMediaDigest = new string('f', 64) };
        var snapCover = CreateSnapshot(2, withCover, snap1, cursor, taxonomyEpoch: 10);
        Assert.Equal(snap1.CorpusPageCount, snapCover.ReusedCorpusPageCount);
        Assert.NotEqual(snap1.Generation, snapCover.Generation);
        Assert.Equal(withCover[0].CoverMediaDigest, snapCover.Article(1)!.CoverMediaDigest);
        Assert.Null(snapCover.CorpusPatch(2, snap1.GenerationHeader, snap1.CorpusTag(2).Tag.ToString()));
        for (var p = 1; p <= snap1.CorpusPageCount; p++)
            AssertReusedPage(snap1, snapCover, p);
        AssertSnapshotCorpusMatchesFullEncoder(withCover, snapCover);

        // TaxonomyEpoch change without article changes also reuses all corpus pages while advancing Generation.
        var snapEpoch = CreateSnapshot(3, withCover, snapCover, cursor, taxonomyEpoch: 11);
        Assert.Equal((snapCover.CorpusPageCount, 11L), (snapEpoch.ReusedCorpusPageCount, snapEpoch.TaxonomyEpoch));
        Assert.NotEqual(snapCover.Generation, snapEpoch.Generation);
        for (var p = 1; p <= snapCover.CorpusPageCount; p++)
            AssertReusedPage(snapCover, snapEpoch, p);
    }

    [Fact]
    public void ByteEstimatePaginationBoundariesReuseWhenPreservedAndRebuildWhenMergedOrSplit()
    {
        // Build large unique-term bodies so EstimatedBytes is ~3.0 MiB each (2 docs fit per 8 MiB page, 3rd overflows!).
        var heavy = Enumerable.Range(1, 6).Select(id => MakeHeavyArticle(id, seed: id * 100)).ToArray();
        Article[] initial = heavy[..5];
        var snap0 = BuildCorpus(initial);
        AssertMatchesFullEncoder(initial, snap0, "byte-bounded initial");
        // Verify page 1 is byte-bounded (< 200 docs) and splits into 3 pages: [1,2], [3,4], [5].
        AssertPageDocumentCounts(snap0, [2, 2, 1]);

        // Cases A..D: edit page 3, edit page 2 boundary while heavy, shrink to merge, retract and absorb.
        CheckCase([heavy[0], heavy[1], heavy[2], heavy[3], heavy[4] with { Title = "Heavy 5 updated" }],
            snap0, "byte-bounded edit page 3", [2, 2, 1], [(0, 0), (1, 1)]);
        CheckCase([heavy[0], heavy[1], heavy[2] with { Title = "Heavy 3 revised" }, heavy[3], heavy[4]],
            snap0, "byte-bounded boundary holds on edited next", [2, 2, 1], [(0, 0), (2, 2)]);
        CheckCase([heavy[0], heavy[1], MakeArticle(3) with { Body = "tiny body" }, heavy[3], heavy[4]],
            snap0, "byte-bounded boundary merged on shrink", [3, 2], []);
        CheckCase([heavy[0], heavy[1], MakeArticle(4) with { Body = "small survivor" }, heavy[4]],
            snap0, "byte-bounded retract and absorb", [3, 1], [(1, 2)]);

        // Case E: Page 1 splits into 2 pages because tiny articles 3 & 4 grow heavy, shifting old page 2 ([5,6]) -> new page 3!
        Article[] startShift = [heavy[0], heavy[1], MakeArticle(3), MakeArticle(4), heavy[4], heavy[5]];
        var snapShift0 = BuildCorpus(startShift);
        AssertMatchesFullEncoder(startShift, snapShift0, "page split start");
        AssertPageDocumentCounts(snapShift0, [4, 2]);
        CheckCase(heavy, snapShift0, "page split shifts later unchanged page", [2, 2, 2], [(2, 1)]);

        static void CheckCase(Article[] rows, LocalSearchCorpusSnapshot prev, string context, int[] counts, (int NewIdx, int OldIdx)[] reused)
        {
            var next = BuildCorpus(rows, prev);
            AssertMatchesFullEncoder(rows, next, context);
            AssertPageDocumentCounts(next, counts);
            Assert.Equal(reused.Length, next.ReusedPageCount);
            var reusedMap = reused.ToDictionary(pair => pair.NewIdx, pair => pair.OldIdx);
            for (var i = 0; i < next.Pages.Count; i++)
            {
                if (reusedMap.TryGetValue(i, out var oldIdx))
                {
                    Assert.Equal(oldIdx, next.ReusedFromPageIndex(i));
                    Assert.Same(prev.Pages[oldIdx], next.Pages[i]);
                }
                else if (i < prev.Pages.Count) Assert.NotSame(prev.Pages[i], next.Pages[i]);
            }
        }
    }

    [Fact]
    public void OrderingEmptyDuplicatesBudgetsValidationAndCancellationMatchFullEncoder()
    {
        // Empty collection reuse and transitions.
        var empty1 = BuildCorpus([]);
        AssertMatchesFullEncoder([], empty1, "empty initial");
        var empty2 = BuildCorpus([], empty1);
        Assert.Equal(1, empty2.ReusedPageCount);
        Assert.Same(empty1.Pages[0], empty2.Pages[0]);
        var one = MakeArticle(10);
        var nonEmpty = BuildCorpus([one], empty2);
        Assert.Equal(0, nonEmpty.ReusedPageCount);
        AssertMatchesFullEncoder([one], nonEmpty, "empty -> non-empty");
        var backToEmpty = BuildCorpus([], nonEmpty);
        Assert.Equal(0, backToEmpty.ReusedPageCount);
        AssertMatchesFullEncoder([], backToEmpty, "non-empty -> empty");

        // Arbitrary input orders (ascending, descending, shuffled) reuse identical pages.
        var asc = Enumerable.Range(1, DocumentsPerPage + 5).Select(MakeArticle).ToArray();
        var shuffled = asc.OrderBy(a => (a.Id * 37) % 101).ToArray();
        var fromAsc = BuildCorpus(asc);
        var fromDesc = BuildCorpus(asc.Reverse().ToArray(), fromAsc);
        var fromShuffled = BuildCorpus(shuffled, fromDesc);
        foreach (var reordered in new[] { fromDesc, fromShuffled })
        {
            Assert.Equal(2, reordered.ReusedPageCount);
            Assert.Same(fromAsc.Pages[0], reordered.Pages[0]);
            Assert.Same(fromAsc.Pages[1], reordered.Pages[1]);
        }
        AssertMatchesFullEncoder(shuffled, fromShuffled, "shuffled order");

        // Duplicate IDs, non-positive IDs, and conflicting taxonomy names throw ProtocolException.
        var conflicting = (Article[])asc.Clone();
        conflicting[1] = conflicting[1] with { Category = new TaxonomyName(7, "DifferentLab") };
        foreach (var bad in new Article[][]
        {
            [MakeArticle(0)], [MakeArticle(-1)], [MakeArticle(1), MakeArticle(1)],
            [.. asc[..DocumentsPerPage], asc[DocumentsPerPage - 1]], [.. asc, asc[^1]], conflicting,
        })
            Assert.Throws<ProtocolException>(() => LocalSearchCorpus.BuildSnapshot(bad, fromAsc));

        // Aggregate byte budget and page budget bounds.
        var exactBytes = fromAsc.Pages.Sum(p => p.Length);
        var exactSnap = Assert.IsType<LocalSearchCorpusSnapshot>(LocalSearchCorpus.BuildSnapshot(asc, fromAsc, 2, exactBytes));
        Assert.Equal(2, exactSnap.ReusedPageCount);
        Assert.Null(LocalSearchCorpus.BuildSnapshot(asc, fromAsc, 2, exactBytes - 1));
        Assert.Null(LocalSearchCorpus.BuildSnapshot(asc, fromAsc, 1, exactBytes));
        Assert.Null(LocalSearchCorpus.BuildSnapshot([], empty1, 1, empty1.Pages[0].Length - 1));

        // Tight byte budget with an invalid article on page 2 must still throw ProtocolException like the full encoder.
        var invalidNext = (Article[])asc.Clone();
        invalidNext[DocumentsPerPage] = invalidNext[DocumentsPerPage] with { Title = "" };
        Assert.Throws<ProtocolException>(() => LocalSearchCorpus.Build(invalidNext));
        Assert.Throws<ProtocolException>(() => LocalSearchCorpus.BuildSnapshot(invalidNext, fromAsc, 2, fromAsc.Pages[0].Length - 1));

        // Out-of-range budgets throw ArgumentOutOfRangeException.
        Assert.Throws<ArgumentOutOfRangeException>(() => LocalSearchCorpus.BuildSnapshot([], null, 0, 1024));
        Assert.Throws<ArgumentOutOfRangeException>(() => LocalSearchCorpus.BuildSnapshot([], null, 1, 0));

        // Cancellation observed on empty, fresh, and reusable builds.
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        foreach (var (rows, prev) in new (Article[], LocalSearchCorpusSnapshot)[] { ([], empty1), (asc, fromAsc) })
            Assert.Equal(cancelled.Token, Assert.Throws<OperationCanceledException>(() =>
                LocalSearchCorpus.BuildSnapshot(rows, prev, cancelled.Token)).CancellationToken);
    }

    [Fact]
    public void FreshStringsFromDatabaseReusePageBytesWithoutRetainingPreviousBodyStrings()
    {
        var (nextSnapshot, oldBodyWeakRef, oldPage0) = BuildWithFreshStringsAndDropPrevious();
        for (var i = 0; i < 4 && oldBodyWeakRef.IsAlive; i++)
        {
            GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
        }

        Assert.Equal((3, 2), (nextSnapshot.Pages.Count, nextSnapshot.ReusedPageCount));
        Assert.Same(oldPage0, nextSnapshot.Pages[0]);
        Assert.False(oldBodyWeakRef.IsAlive,
            "Reusing immutable page bytes with fresh article strings must not pin previous snapshot Body strings.");
        GC.KeepAlive(nextSnapshot);

        [MethodImpl(MethodImplOptions.NoInlining)]
        static (LocalSearchCorpusSnapshot Next, WeakReference OldBody, byte[] OldPage0) BuildWithFreshStringsAndDropPrevious()
        {
            var source = Enumerable.Range(1, 2 * DocumentsPerPage + 1)
                .Select(id => MakeArticle(id) with { Body = $"Article {id} " + new string('x', 8_192) }).ToArray();
            var prev = BuildCorpus(source);
            var weak = new WeakReference(source[0].Body);
            var oldPage0 = prev.Pages[0];

            // Clone every string and taxonomy object to simulate fresh NpgsqlDataReader allocations.
            var reloaded = source.Select(CloneStrings).ToArray();
            reloaded[^1] = reloaded[^1] with { Body = reloaded[^1].Body + " edited" };
            var next = BuildCorpus(reloaded, prev);
            AssertMatchesFullEncoder(reloaded, next, "fresh strings from database");
            return (next, weak, oldPage0);
        }
    }

    [Fact]
    public async Task ConcurrentReadersAcrossOldAndNewSnapshotsObserveIsolatedGenerationAndWithdrawal()
    {
        var initial = Enumerable.Range(1, 3 * DocumentsPerPage + 1)
            .Select(id => MakeArticle(id) with
            {
                Body = id == 601 ? "unique_withdrawn_canary_601 body" :
                    id == 250 ? "unique_page2_before_250 body" :
                    $"shared corpus body {id}"
            }).ToArray();
        var cursor = new PublicListCursor(TimeProvider.System);
        var oldSnapshot = CreateSnapshot(1, initial, previous: null, cursor);

        var updated = initial[..^1].ToArray();
        updated[249] = updated[249] with
        {
            Revision = 11, RevisionNo = 2, Publication = 500, PublicationNo = 2, Body = "unique_page2_after_250 body"
        };
        var newSnapshot = CreateSnapshot(2, updated, oldSnapshot, cursor);

        Assert.Equal(4, oldSnapshot.CorpusPageCount);
        AssertPageCounts(newSnapshot, 3, 2);
        Assert.Same(oldSnapshot.Corpus(1), newSnapshot.Corpus(1));
        Assert.Same(oldSnapshot.Corpus(3), newSnapshot.Corpus(3));
        Assert.NotSame(oldSnapshot.Corpus(2), newSnapshot.Corpus(2));
        Assert.NotEqual(oldSnapshot.Generation, newSnapshot.Generation);

        var expectedOld = Enumerable.Range(1, 4).Select(p => oldSnapshot.Corpus(p)!.ToArray()).ToArray();
        var expectedNew = Enumerable.Range(1, 3).Select(p => newSnapshot.Corpus(p)!.ToArray()).ToArray();
        var expectedOldTags = Enumerable.Range(1, 4).Select(p => oldSnapshot.CorpusTag(p).ToString()).ToArray();
        var expectedNewTags = Enumerable.Range(1, 3).Select(p => newSnapshot.CorpusTag(p).ToString()).ToArray();

        using var barrier = new Barrier(8);
        var tasks = Enumerable.Range(0, 8).Select(worker => Task.Run(() =>
        {
            barrier.SignalAndWait();
            var isOld = (worker & 1) == 0;
            var (snap, pages, tags, queries) = isOld
                ? (oldSnapshot, expectedOld, expectedOldTags, new[] { ("unique_withdrawn_canary_601", 1) })
                : (newSnapshot, expectedNew, expectedNewTags, new[] { ("unique_withdrawn_canary_601", 0), ("unique_page2_after_250", 1) });
            for (var iter = 0; iter < 500; iter++)
            {
                Assert.Equal((pages.Length, isOld), (snap.CorpusPageCount, snap.HasArticle(601)));
                if (!isOld) Assert.Null(snap.Corpus(4));
                for (var p = 1; p <= pages.Length; p++)
                {
                    Assert.True(snap.Corpus(p).AsSpan().SequenceEqual(pages[p - 1]));
                    Assert.Equal(tags[p - 1], snap.CorpusTag(p).ToString());
                }
                foreach (var (term, count) in queries)
                    Assert.Equal(count, BinaryPrimitives.ReadInt32LittleEndian(Aeds.Decode(snap.Search(term, CancellationToken.None)!, FrameType.ArticleSearch)[8..]));
            }
        })).ToArray();
        await Task.WhenAll(tasks);
    }

    [Fact]
    public void ReusingUnchangedPagesSkipsEncodingAndReducesManagedAllocationsSubstantially()
    {
        var initial = Enumerable.Range(1, 3 * DocumentsPerPage + 1).Select(MakeRichArticle).ToArray();
        var edited = (Article[])initial.Clone();
        edited[^1] = edited[^1] with { Revision = 11, RevisionNo = 2, Publication = 999, PublicationNo = 2, Body = edited[^1].Body + " revision2" };
        var editedFreshStrings = edited.Select(CloneStrings).ToArray();

        // Warm JIT and lexicon tables before measuring allocations.
        var previous = BuildCorpus(initial);
        Assert.NotNull(LocalSearchCorpus.Build(edited));
        Assert.NotNull(LocalSearchCorpus.BuildSnapshot(edited, previous));
        Assert.NotNull(LocalSearchCorpus.BuildSnapshot(editedFreshStrings, previous));

        var fullAlloc = MeasureAlloc(() => { _ = LocalSearchCorpus.Build(edited); });
        foreach (var (label, rows) in new[] { ("shared refs", edited), ("fresh DB strings", editedFreshStrings) })
        {
            var alloc = MeasureAlloc(() => { _ = LocalSearchCorpus.BuildSnapshot(rows, previous); });
            Assert.True(alloc * 10 < fullAlloc,
                $"Expected reusing 3 of 4 pages ({label}) to allocate <10% of full build, got {alloc:N0} vs {fullAlloc:N0} bytes.");
        }

        static long MeasureAlloc(Action action)
        {
            var before = GC.GetAllocatedBytesForCurrentThread();
            action();
            return GC.GetAllocatedBytesForCurrentThread() - before;
        }
    }

    [PostgresFact]
    public async Task PublicCorpusHttpPreservesEtagsPatchAndGenerationFenceAcrossEditAndRetract()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        var (author, token, _) = await fixture.SignIn("Corpus reuse author", ct, canAuthor: true, minutes: 2);
        await fixture.InTx(async (db, tx) =>
        {
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article (id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at)
                overriding system value
                select id,$1,1,'Corpus article ' || id,repeat('a', 200) || ' Shared needle body content for article ' || id,1,1,false,
                       timestamptz '2024-01-01 UTC' + id * interval '1 minute',timestamptz '2024-01-01 UTC' + id * interval '1 minute'
                from generate_series(1, 220) id
                """, author);
            await FixtureSql.ExecuteAsync(db, tx, ct, PublicationFixture.AllCurrentArticlesWithDefaultRights);
        }, ct);

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var client = server.Client;

        // Initial 2 pages: [1..200], [201..220].
        var (gen1, page1Bytes1, page1Etag1, pages1) = await FetchPage(client, 1, null, ct);
        Assert.Equal(2, pages1);
        var (_, page2Bytes1, page2Etag1, _) = await FetchPage(client, 2, gen1, ct);

        // Edit and republish article 220 (page 2 only, compact coordinate/body delta past summary slice that fits FSPT v4).
        var saved = await SiteAedsFixture.SaveDraft(client, token, null, 220, 1, "Corpus article 220",
            new string('a', 200) + " Shared needle body content for article 220!", ct);
        var published = await SiteAedsFixture.ChangePublication(client, WireRoutes.Publish, token, saved.Id, saved.Revision, ct);
        Assert.True(published.Published);

        var gen2 = await AssertGenerationFenceAndPage1Reuse(gen1, checkPagesHeader: true);

        // Page 2 full bytes & FSPT patch must match and reconstruct target page bytes exactly!
        var (_, page2Bytes2, page2Etag2, _) = await FetchPage(client, 2, gen2, ct);
        Assert.NotEqual(page2Etag1, page2Etag2);
        using (var patchReq = new HttpRequestMessage(HttpMethod.Get,
            $"{WireRoutes.PublicSearchCorpus}?page=2&generation={gen2}&baseGeneration={gen1}"))
        {
            Assert.True(patchReq.Headers.TryAddWithoutValidation("Accept", SearchCorpusPatch.Accept));
            Assert.True(patchReq.Headers.TryAddWithoutValidation("If-None-Match", page2Etag1));
            using var patchResp = Ok(await client.SendAsync(patchReq, ct));
            Assert.Equal(SearchCorpusPatch.ContentType, patchResp.Content.Headers.ContentType?.MediaType);
            Assert.Equal(page2Etag2[1..^1], Assert.Single(patchResp.Headers.GetValues(WireHeaders.SearchCorpusTargetDigest)));
            var patchBytes = await patchResp.Content.ReadAsByteArrayAsync(ct);
            Assert.True(patchBytes.AsSpan(0, 4).SequenceEqual("FSPT"u8));
            var prefix = BinaryPrimitives.ReadInt32LittleEndian(patchBytes.AsSpan(36));
            var suffix = BinaryPrimitives.ReadInt32LittleEndian(patchBytes.AsSpan(40));
            Assert.Equal<byte[]>(page2Bytes2, [.. page2Bytes1[..prefix], .. patchBytes[WireLayouts.SearchCorpusPatchHeaderSize..], .. page2Bytes1[^suffix..]]);
        }

        // Retract article 220 -> old gen2 rejected with 409, page 1 STILL 304 with same ETag, page 2 updated without 220.
        var retracted = await SiteAedsFixture.ChangePublication(client, WireRoutes.Retract, token, published.Id, published.Revision, ct);
        Assert.False(retracted.Published);

        var gen3 = await AssertGenerationFenceAndPage1Reuse(gen2, checkPagesHeader: false);
        var (_, page2Bytes3, _, _) = await FetchPage(client, 2, gen3, ct);
        Assert.Equal(19, DocumentCountOf(page2Bytes3));
        Assert.Equal(page1Bytes1.Length, (await FetchPage(client, 1, gen3, ct)).Bytes.Length);

        async Task<string> AssertGenerationFenceAndPage1Reuse(string priorGen, bool checkPagesHeader)
        {
            using (var staleHead = new HttpRequestMessage(HttpMethod.Head, $"{WireRoutes.PublicSearchCorpus}?generation={priorGen}"))
                await CheckStatusAsync(Conflict, client.SendAsync(staleHead, ct));
            using var conditional = new HttpRequestMessage(HttpMethod.Get, WireRoutes.PublicSearchCorpus);
            Assert.True(conditional.Headers.TryAddWithoutValidation("If-None-Match", page1Etag1));
            using var notModified = Expect(NotModified, await client.SendAsync(conditional, ct));
            var nextGen = Assert.Single(notModified.Headers.GetValues(WireHeaders.SearchIndexGeneration));
            Assert.NotEqual(priorGen, nextGen);
            Assert.Equal(page1Etag1, notModified.Headers.ETag?.ToString());
            if (checkPagesHeader) Assert.Equal("2", Assert.Single(notModified.Headers.GetValues(WireHeaders.SearchIndexPages)));
            return nextGen;
        }
    }

    private static Article MakeArticle(int id) => BaseArticle with
    {
        Id = id, Publication = 100 + id, Title = $"FsusBlog AEDS Guide {id}",
        Body = $"PostgreSQL dotNet10 博客搜索的公开页 needle article{id}", Summary = $"Summary {id}", PublishedAt = Published.AddMinutes(id),
    };

    private static Article MakeRichArticle(int id) => BaseArticle with
    {
        Id = id, Publication = 100 + id, Title = $"FsusBlog Architecture Note {id} CamelCaseHandler",
        Summary = $"Summary for article {id} covering FsusUI PostgreSQL and AEDS binary framing",
        Body = string.Join(' ', Enumerable.Range(0, 120).Select(word =>
            $"section{word} FsusBlog{id % 17} PostgreSQL{word % 23} 博客搜索公开页架构分析{(id + word) % 29}")),
        PublishedAt = Published.AddMinutes(id),
    };

    private static Article MakeHeavyArticle(int id, int seed)
    {
        // 13,000 unique 9-letter lowercase words -> ~7 unique prefixes per word -> ~3.6 MiB estimated bytes (<130 KB body).
        // Two heavy articles (~7.2 MiB) fit on one 8 MiB page; a third (~10.8 MiB) overflows to the next page.
        var sb = new System.Text.StringBuilder(13_000 * 10);
        for (var i = 0; i < 13_000; i++)
        {
            if (i > 0) sb.Append(' ');
            var v = (uint)(seed * 100_003 + i * 2_654_435_761u);
            for (var c = 0; c < 9; c++)
            {
                sb.Append((char)('a' + ((v + (uint)(c * 7)) % 26)));
                v = (v >> 3) ^ (v * 33 + (uint)i + (uint)c);
            }
        }
        return MakeArticle(id) with { Title = $"Heavy {id}", Body = sb.ToString() };
    }

    private static Article CloneStrings(Article article) => article with
    {
        Title = new string(article.Title.AsSpan()),
        Body = new string(article.Body.AsSpan()),
        Summary = article.Summary is null ? null : new string(article.Summary.AsSpan()),
        Category = article.Category is null ? null : new TaxonomyName(article.Category.Id, new string(article.Category.Name.AsSpan())),
        Tags = article.Tags?.Select(tag => new TaxonomyName(tag.Id, new string(tag.Name.AsSpan()))).ToArray(),
    };

    private static PublicSnapshot CreateSnapshot(long watermark, IReadOnlyList<Article> articles,
        PublicSnapshot? previous, PublicListCursor cursor, long taxonomyEpoch = 0) =>
        new(watermark, articles, new([], [], []), EmptyPages, cursor, previous, NullLogger.Instance,
            null, null, CancellationToken.None, taxonomyEpoch);

    private static LocalSearchCorpusSnapshot BuildCorpus(IReadOnlyList<Article> articles, LocalSearchCorpusSnapshot? previous = null) =>
        Assert.IsType<LocalSearchCorpusSnapshot>(LocalSearchCorpus.BuildSnapshot(articles, previous));

    private static void AssertReusedPage(PublicSnapshot previous, PublicSnapshot current, int page)
    {
        Assert.Same(previous.Corpus(page), current.Corpus(page));
        Assert.Same(previous.CorpusTag(page), current.CorpusTag(page));
    }

    private static void AssertPageCounts(PublicSnapshot snapshot, int total, int reused) =>
        Assert.Equal((total, reused), (snapshot.CorpusPageCount, snapshot.ReusedCorpusPageCount));

    private static void AssertPageDocumentCounts(LocalSearchCorpusSnapshot snapshot, ReadOnlySpan<int> counts)
    {
        Assert.Equal(counts.Length, snapshot.Pages.Count);
        for (var i = 0; i < counts.Length; i++)
            Assert.Equal(counts[i], DocumentCountOf(snapshot.Pages[i]));
    }

    private static void AssertMatchesFullEncoder(IReadOnlyList<Article> articles, LocalSearchCorpusSnapshot actual, string? context = null)
    {
        var expected = Assert.IsAssignableFrom<IReadOnlyList<byte[]>>(LocalSearchCorpus.Build(articles));
        Assert.True(expected.Count == actual.Pages.Count, $"{context}: expected {expected.Count} pages, got {actual.Pages.Count}");
        for (var i = 0; i < expected.Count; i++)
            Assert.True(expected[i].AsSpan().SequenceEqual(actual.Pages[i]), $"{context}: page {i + 1} bytes differ from full encoder.");
    }

    private static void AssertSnapshotCorpusMatchesFullEncoder(IReadOnlyList<Article> articles, PublicSnapshot snapshot)
    {
        var expected = Assert.IsAssignableFrom<IReadOnlyList<byte[]>>(LocalSearchCorpus.Build(articles));
        Assert.Equal(expected.Count, snapshot.CorpusPageCount);
        for (var i = 0; i < expected.Count; i++)
        {
            var actualBytes = Assert.IsType<byte[]>(snapshot.Corpus(i + 1));
            Assert.True(expected[i].AsSpan().SequenceEqual(actualBytes));
            Assert.Equal($"\"{Convert.ToHexStringLower(SHA256.HashData(expected[i]))}\"", snapshot.CorpusTag(i + 1).ToString());
        }
    }

    private static int DocumentCountOf(byte[] pageBytes) =>
        BinaryPrimitives.ReadInt32LittleEndian(pageBytes.AsSpan(WireLayouts.SearchPackagePayloadOffset + 20));

    private static async Task<(string Generation, byte[] Bytes, string ETag, int Pages)> FetchPage(
        HttpClient client, int page, string? generation, CancellationToken ct)
    {
        var url = $"{WireRoutes.PublicSearchCorpus}?page={page}" + (generation is null ? "" : $"&generation={generation}");
        using var response = Ok(await client.GetAsync(url, ct));
        var bytes = await response.Content.ReadAsByteArrayAsync(ct);
        var etag = Assert.IsType<EntityTagHeaderValue>(response.Headers.ETag).ToString();
        Assert.Equal($"\"{Convert.ToHexStringLower(SHA256.HashData(bytes))}\"", etag);
        return (Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration)), bytes, etag,
            int.Parse(Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexPages))));
    }
}
