using System.Buffers.Binary;
using System.Net;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using Microsoft.Extensions.Logging.Abstractions;

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
        var initial = Enumerable.Range(1, DocumentsPerPage + 1)
            .Select(id => MakeArticle(id))
            .ToArray();
        var baseline = BuildCorpus(initial);
        AssertMatchesFullEncoder(initial, baseline);
        Assert.Equal(2, baseline.Pages.Count);
        Assert.Equal(0, baseline.ReusedPageCount);

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
            Assert.Equal(1, next.ReusedPageCount);
            Assert.Equal(0, next.ReusedFromPageIndex(0));
            Assert.Equal(-1, next.ReusedFromPageIndex(1));
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
        var initial = Enumerable.Range(1, 3 * DocumentsPerPage + 1)
            .Select(id => MakeArticle(id))
            .ToArray();
        var cursor = new PublicListCursor(TimeProvider.System);
        var snap0 = CreateSnapshot(1, initial, previous: null, cursor);
        AssertPageCounts(snap0, 4, 0);
        AssertSnapshotCorpusMatchesFullEncoder(initial, snap0);

        // 1. Edit last article (#601 on page 4): reuses pages 1..3 + ETags.
        var editLast = (Article[])initial.Clone();
        editLast[^1] = editLast[^1] with { Revision = 11, RevisionNo = 2, Publication = 200, PublicationNo = 2, Body = editLast[^1].Body + " updated601" };
        var snapEditLast = CreateSnapshot(2, editLast, snap0, cursor);
        AssertPageCounts(snapEditLast, 4, 3);
        for (var p = 1; p <= 3; p++)
            AssertReusedPage(snap0, snapEditLast, p);
        Assert.NotSame(snap0.Corpus(4), snapEditLast.Corpus(4));
        Assert.NotEqual(snap0.Generation, snapEditLast.Generation);
        AssertSnapshotCorpusMatchesFullEncoder(editLast, snapEditLast);
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
        var snapEditFirst = CreateSnapshot(3, editFirst, snapEditLast, cursor);
        AssertPageCounts(snapEditFirst, 4, 3);
        Assert.NotSame(snapEditLast.Corpus(1), snapEditFirst.Corpus(1));
        for (var p = 2; p <= 4; p++)
            AssertReusedPage(snapEditLast, snapEditFirst, p);
        AssertSnapshotCorpusMatchesFullEncoder(editFirst, snapEditFirst);

        // 3. Edit middle article (#250 on page 2): reuses pages 1, 3, 4 + ETags, emits FSPT patch for page 2.
        var editMiddle = (Article[])editFirst.Clone();
        editMiddle[249] = editMiddle[249] with { Revision = 13, RevisionNo = 2, Publication = 202, PublicationNo = 2, Body = editMiddle[249].Body + "!" };
        var snapEditMiddle = CreateSnapshot(4, editMiddle, snapEditFirst, cursor);
        AssertPageCounts(snapEditMiddle, 4, 3);
        Assert.Same(snapEditFirst.Corpus(1), snapEditMiddle.Corpus(1));
        Assert.NotSame(snapEditFirst.Corpus(2), snapEditMiddle.Corpus(2));
        Assert.Same(snapEditFirst.Corpus(3), snapEditMiddle.Corpus(3));
        Assert.Same(snapEditFirst.Corpus(4), snapEditMiddle.Corpus(4));
        AssertSnapshotCorpusMatchesFullEncoder(editMiddle, snapEditMiddle);
        var patch2 = snapEditMiddle.CorpusPatch(2, snapEditFirst.GenerationHeader, snapEditFirst.CorpusTag(2).Tag.ToString());
        Assert.NotNull(patch2);
        Assert.True(patch2.AsSpan(0, 4).SequenceEqual("FSPT"u8));

        // 4. Rename category across all 601 articles: reuses 0 of 4 pages.
        var renamedCategory = editMiddle.Select(a => a with { Category = new TaxonomyName(7, "RenamedLab") }).ToArray();
        var snapRenamed = CreateSnapshot(5, renamedCategory, snapEditMiddle, cursor);
        AssertPageCounts(snapRenamed, 4, 0);
        for (var p = 1; p <= 4; p++)
            Assert.NotSame(snapEditMiddle.Corpus(p), snapRenamed.Corpus(p));
        AssertSnapshotCorpusMatchesFullEncoder(renamedCategory, snapRenamed);

        // 5. Withdraw middle article (#201): 600 articles -> 3 pages, page 1 reused, pages 2..3 shifted & rebuilt.
        var withdrawMid = renamedCategory.Where(a => a.Id != 201).ToArray();
        var snapWithdrawMid = CreateSnapshot(6, withdrawMid, snapRenamed, cursor);
        AssertPageCounts(snapWithdrawMid, 3, 1);
        AssertReusedPage(snapRenamed, snapWithdrawMid, 1);
        Assert.NotSame(snapRenamed.Corpus(2), snapWithdrawMid.Corpus(2));
        Assert.NotSame(snapRenamed.Corpus(3), snapWithdrawMid.Corpus(3));
        Assert.False(snapWithdrawMid.HasArticle(201));
        AssertSnapshotCorpusMatchesFullEncoder(withdrawMid, snapWithdrawMid);

        // 6. Withdraw last article (#601 from 601-article set): 600 articles -> 3 pages, ALL 3 pages reused.
        var withdrawLast = renamedCategory[..^1];
        var snapWithdrawLast = CreateSnapshot(7, withdrawLast, snapRenamed, cursor);
        AssertPageCounts(snapWithdrawLast, 3, 3);
        for (var p = 1; p <= 3; p++)
            AssertReusedPage(snapRenamed, snapWithdrawLast, p);
        Assert.NotEqual(snapRenamed.Generation, snapWithdrawLast.Generation);
        AssertSnapshotCorpusMatchesFullEncoder(withdrawLast, snapWithdrawLast);

        // 7. Insert article #602: 602 articles -> 4 pages, pages 1..3 reused, page 4 rebuilt.
        var inserted = renamedCategory.Append(MakeArticle(602) with { Category = new TaxonomyName(7, "RenamedLab") }).ToArray();
        var snapInserted = CreateSnapshot(8, inserted, snapRenamed, cursor);
        AssertPageCounts(snapInserted, 4, 3);
        for (var p = 1; p <= 3; p++)
            Assert.Same(snapRenamed.Corpus(p), snapInserted.Corpus(p));
        Assert.NotSame(snapRenamed.Corpus(4), snapInserted.Corpus(4));
        AssertSnapshotCorpusMatchesFullEncoder(inserted, snapInserted);
    }

    [Fact]
    public void CoverAndTaxonomyEpochChangesReuseAllCorpusPagesWhileStillAdvancingSnapshotGeneration()
    {
        var initial = Enumerable.Range(1, 2 * DocumentsPerPage + 5)
            .Select(id => MakeArticle(id))
            .ToArray();
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
        Assert.Equal(snapCover.CorpusPageCount, snapEpoch.ReusedCorpusPageCount);
        Assert.NotEqual(snapCover.Generation, snapEpoch.Generation);
        Assert.Equal(11, snapEpoch.TaxonomyEpoch);
        for (var p = 1; p <= snapCover.CorpusPageCount; p++)
            AssertReusedPage(snapCover, snapEpoch, p);
    }

    [Fact]
    public void ByteEstimatePaginationBoundariesReuseWhenPreservedAndRebuildWhenMergedOrSplit()
    {
        // Build large unique-term bodies so EstimatedBytes is ~3.0 MiB each (2 docs fit per 8 MiB page, 3rd overflows!).
        var heavy1 = MakeHeavyArticle(1, seed: 100);
        var heavy2 = MakeHeavyArticle(2, seed: 200);
        var heavy3 = MakeHeavyArticle(3, seed: 300);
        var heavy4 = MakeHeavyArticle(4, seed: 400);
        var heavy5 = MakeHeavyArticle(5, seed: 500);
        Article[] initial = [heavy1, heavy2, heavy3, heavy4, heavy5];

        var snap0 = BuildCorpus(initial);
        AssertMatchesFullEncoder(initial, snap0, "byte-bounded initial");
        // Verify page 1 is byte-bounded (< 200 docs) and splits into 3 pages: [1,2], [3,4], [5].
        AssertPageDocumentCounts(snap0, [2, 2, 1]);

        // Case A: Edit article 5 on page 3 -> byte-bounded pages 1 and 2 are BOTH reused!
        Article[] editPage3 = [heavy1, heavy2, heavy3, heavy4, heavy5 with { Title = "Heavy 5 updated" }];
        var snapA = BuildCorpus(editPage3, snap0);
        AssertMatchesFullEncoder(editPage3, snapA, "byte-bounded edit page 3");
        Assert.Equal(3, snapA.Pages.Count);
        Assert.Equal(2, snapA.ReusedPageCount);
        Assert.Same(snap0.Pages[0], snapA.Pages[0]);
        Assert.Same(snap0.Pages[1], snapA.Pages[1]);
        Assert.NotSame(snap0.Pages[2], snapA.Pages[2]);

        // Case B: Edit article 3 (first of page 2) while keeping it heavy so it STILL overflows page 1 -> page 1 reused!
        var heavy3Edited = heavy3 with { Title = "Heavy 3 revised" };
        Article[] editBoundaryStillSplits = [heavy1, heavy2, heavy3Edited, heavy4, heavy5];
        var snapB = BuildCorpus(editBoundaryStillSplits, snap0);
        AssertMatchesFullEncoder(editBoundaryStillSplits, snapB, "byte-bounded boundary holds on edited next");
        Assert.Equal(3, snapB.Pages.Count);
        Assert.Equal(2, snapB.ReusedPageCount);
        Assert.Same(snap0.Pages[0], snapB.Pages[0]);
        Assert.NotSame(snap0.Pages[1], snapB.Pages[1]);
        Assert.Same(snap0.Pages[2], snapB.Pages[2]);

        // Case C: Shrink article 3 so it NOW fits on page 1 -> page 1 MUST NOT be reused, absorbs article 3!
        var tiny3 = MakeArticle(3) with { Body = "tiny body" };
        Article[] boundaryMerged = [heavy1, heavy2, tiny3, heavy4, heavy5];
        var snapC = BuildCorpus(boundaryMerged, snap0);
        AssertMatchesFullEncoder(boundaryMerged, snapC, "byte-bounded boundary merged on shrink");
        AssertPageDocumentCounts(snapC, [3, 2]); // [1, 2, 3], [4, 5]
        Assert.Equal(0, snapC.ReusedPageCount);

        // Case D: Retract article 3 and replace with tiny article 3b (id=4 tiny) -> page 1 absorbs tiny surviving article!
        var tiny4 = MakeArticle(4) with { Body = "small survivor" };
        Article[] withdrawAndAbsorb = [heavy1, heavy2, tiny4, heavy5];
        var snapD = BuildCorpus(withdrawAndAbsorb, snap0);
        AssertMatchesFullEncoder(withdrawAndAbsorb, snapD, "byte-bounded retract and absorb");
        AssertPageDocumentCounts(snapD, [3, 1]); // [1, 2, 4], [5]
        Assert.Equal(1, snapD.ReusedPageCount);
        Assert.Equal(2, snapD.ReusedFromPageIndex(1));
        Assert.Same(snap0.Pages[2], snapD.Pages[1]);

        // Case E: Page 1 splits into 2 pages because tiny articles 3 & 4 grow heavy, shifting old page 2 ([5,6]) -> new page 3!
        var heavy6 = MakeHeavyArticle(6, seed: 600);
        Article[] startShift = [heavy1, heavy2, MakeArticle(3), MakeArticle(4), heavy5, heavy6];
        var snapShift0 = BuildCorpus(startShift);
        AssertMatchesFullEncoder(startShift, snapShift0, "page split start");
        AssertPageDocumentCounts(snapShift0, [4, 2]); // [1, 2, 3, 4], [5, 6]

        Article[] afterShift = [heavy1, heavy2, heavy3, heavy4, heavy5, heavy6];
        var snapShift1 = BuildCorpus(afterShift, snapShift0);
        AssertMatchesFullEncoder(afterShift, snapShift1, "page split shifts later unchanged page");
        AssertPageDocumentCounts(snapShift1, [2, 2, 2]); // [1, 2], [3, 4], [5, 6]
        Assert.Equal(1, snapShift1.ReusedPageCount);
        Assert.Equal(1, snapShift1.ReusedFromPageIndex(2));
        Assert.Same(snapShift0.Pages[1], snapShift1.Pages[2]);
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
        var asc = Enumerable.Range(1, DocumentsPerPage + 5).Select(id => MakeArticle(id)).ToArray();
        var desc = asc.Reverse().ToArray();
        var shuffled = asc.OrderBy(a => (a.Id * 37) % 101).ToArray();
        var fromAsc = BuildCorpus(asc);
        var fromDesc = BuildCorpus(desc, fromAsc);
        var fromShuffled = BuildCorpus(shuffled, fromDesc);
        Assert.Equal(2, fromDesc.ReusedPageCount);
        Assert.Equal(2, fromShuffled.ReusedPageCount);
        Assert.Same(fromAsc.Pages[0], fromDesc.Pages[0]);
        Assert.Same(fromAsc.Pages[1], fromDesc.Pages[1]);
        Assert.Same(fromAsc.Pages[0], fromShuffled.Pages[0]);
        Assert.Same(fromAsc.Pages[1], fromShuffled.Pages[1]);
        AssertMatchesFullEncoder(shuffled, fromShuffled, "shuffled order");

        // Duplicate IDs and non-positive IDs throw ProtocolException with and without previous snapshot.
        Assert.Throws<ProtocolException>(() => LocalSearchCorpus.BuildSnapshot([MakeArticle(0)], fromAsc));
        Assert.Throws<ProtocolException>(() => LocalSearchCorpus.BuildSnapshot([MakeArticle(-1)], fromAsc));
        Assert.Throws<ProtocolException>(() => LocalSearchCorpus.BuildSnapshot([MakeArticle(1), MakeArticle(1)], fromAsc));
        Assert.Throws<ProtocolException>(() => LocalSearchCorpus.BuildSnapshot([.. asc[..DocumentsPerPage], asc[DocumentsPerPage - 1]], fromAsc));
        Assert.Throws<ProtocolException>(() => LocalSearchCorpus.BuildSnapshot([.. asc, asc[^1]], fromAsc));

        // Conflicting taxonomy names within a page throw ProtocolException.
        var conflicting = (Article[])asc.Clone();
        conflicting[1] = conflicting[1] with { Category = new TaxonomyName(7, "DifferentLab") };
        Assert.Throws<ProtocolException>(() => LocalSearchCorpus.BuildSnapshot(conflicting, fromAsc));

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
        var ex1 = Assert.Throws<OperationCanceledException>(() => LocalSearchCorpus.BuildSnapshot([], empty1, cancelled.Token));
        Assert.Equal(cancelled.Token, ex1.CancellationToken);
        var ex2 = Assert.Throws<OperationCanceledException>(() => LocalSearchCorpus.BuildSnapshot(asc, fromAsc, cancelled.Token));
        Assert.Equal(cancelled.Token, ex2.CancellationToken);
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

        Assert.Equal(3, nextSnapshot.Pages.Count);
        Assert.Equal(2, nextSnapshot.ReusedPageCount);
        Assert.Same(oldPage0, nextSnapshot.Pages[0]);
        Assert.False(oldBodyWeakRef.IsAlive,
            "Reusing immutable page bytes with fresh article strings must not pin previous snapshot Body strings.");
        GC.KeepAlive(nextSnapshot);

        [MethodImpl(MethodImplOptions.NoInlining)]
        static (LocalSearchCorpusSnapshot Next, WeakReference OldBody, byte[] OldPage0) BuildWithFreshStringsAndDropPrevious()
        {
            var source = Enumerable.Range(1, 2 * DocumentsPerPage + 1)
                .Select(id => MakeArticle(id) with { Body = $"Article {id} " + new string('x', 8_192) })
                .ToArray();
            var prev = Assert.IsType<LocalSearchCorpusSnapshot>(LocalSearchCorpus.BuildSnapshot(source));
            var weak = new WeakReference(source[0].Body);
            var oldPage0 = prev.Pages[0];

            // Clone every string and taxonomy object to simulate fresh NpgsqlDataReader allocations.
            var reloaded = source.Select(CloneStrings).ToArray();
            reloaded[^1] = reloaded[^1] with { Body = reloaded[^1].Body + " edited" };
            var next = Assert.IsType<LocalSearchCorpusSnapshot>(LocalSearchCorpus.BuildSnapshot(reloaded, prev));
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
            })
            .ToArray();
        var cursor = new PublicListCursor(TimeProvider.System);
        var oldSnapshot = CreateSnapshot(1, initial, previous: null, cursor);

        var updated = initial[..^1].ToArray();
        updated[249] = updated[249] with
        {
            Revision = 11,
            RevisionNo = 2,
            Publication = 500,
            PublicationNo = 2,
            Body = "unique_page2_after_250 body"
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
            for (var iter = 0; iter < 500; iter++)
            {
                if ((worker & 1) == 0)
                {
                    Assert.Equal(4, oldSnapshot.CorpusPageCount);
                    Assert.True(oldSnapshot.HasArticle(601));
                    for (var p = 1; p <= 4; p++)
                    {
                        Assert.True(oldSnapshot.Corpus(p).AsSpan().SequenceEqual(expectedOld[p - 1]));
                        Assert.Equal(expectedOldTags[p - 1], oldSnapshot.CorpusTag(p).ToString());
                    }
                    var hit = Aeds.Decode(oldSnapshot.Search("unique_withdrawn_canary_601", CancellationToken.None)!, FrameType.ArticleSearch);
                    Assert.Equal(1, BinaryPrimitives.ReadInt32LittleEndian(hit[8..]));
                }
                else
                {
                    Assert.Equal(3, newSnapshot.CorpusPageCount);
                    Assert.False(newSnapshot.HasArticle(601));
                    Assert.Null(newSnapshot.Corpus(4));
                    for (var p = 1; p <= 3; p++)
                    {
                        Assert.True(newSnapshot.Corpus(p).AsSpan().SequenceEqual(expectedNew[p - 1]));
                        Assert.Equal(expectedNewTags[p - 1], newSnapshot.CorpusTag(p).ToString());
                    }
                    var withdrawn = Aeds.Decode(newSnapshot.Search("unique_withdrawn_canary_601", CancellationToken.None)!, FrameType.ArticleSearch);
                    Assert.Equal(0, BinaryPrimitives.ReadInt32LittleEndian(withdrawn[8..]));
                    var updatedHit = Aeds.Decode(newSnapshot.Search("unique_page2_after_250", CancellationToken.None)!, FrameType.ArticleSearch);
                    Assert.Equal(1, BinaryPrimitives.ReadInt32LittleEndian(updatedHit[8..]));
                }
            }
        })).ToArray();
        await Task.WhenAll(tasks);
    }

    [Fact]
    public void ReusingUnchangedPagesSkipsEncodingAndReducesManagedAllocationsSubstantially()
    {
        var initial = Enumerable.Range(1, 3 * DocumentsPerPage + 1)
            .Select(id => MakeRichArticle(id))
            .ToArray();
        var edited = (Article[])initial.Clone();
        edited[^1] = edited[^1] with { Revision = 11, RevisionNo = 2, Publication = 999, PublicationNo = 2, Body = edited[^1].Body + " revision2" };
        var editedFreshStrings = edited.Select(CloneStrings).ToArray();

        // Warm JIT and lexicon tables before measuring allocations.
        var previous = Assert.IsType<LocalSearchCorpusSnapshot>(LocalSearchCorpus.BuildSnapshot(initial));
        Assert.NotNull(LocalSearchCorpus.Build(edited));
        Assert.NotNull(LocalSearchCorpus.BuildSnapshot(edited, previous));
        Assert.NotNull(LocalSearchCorpus.BuildSnapshot(editedFreshStrings, previous));

        var fullAlloc = MeasureAlloc(() => { _ = LocalSearchCorpus.Build(edited); });
        var reuseSameRefAlloc = MeasureAlloc(() => { _ = LocalSearchCorpus.BuildSnapshot(edited, previous); });
        var reuseFreshRefAlloc = MeasureAlloc(() => { _ = LocalSearchCorpus.BuildSnapshot(editedFreshStrings, previous); });

        Assert.True(reuseSameRefAlloc * 10 < fullAlloc,
            $"Expected reusing 3 of 4 pages (shared refs) to allocate <10% of full build, got {reuseSameRefAlloc:N0} vs {fullAlloc:N0} bytes.");
        Assert.True(reuseFreshRefAlloc * 10 < fullAlloc,
            $"Expected reusing 3 of 4 pages (fresh DB strings) to allocate <10% of full build, got {reuseFreshRefAlloc:N0} vs {fullAlloc:N0} bytes.");

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
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (author, token, _) = await fixture.SignIn("Corpus reuse author", ct, canAuthor: true, minutes: 2);

        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article (id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at)
                overriding system value
                select id,$1,1,'Corpus article ' || id,repeat('a', 200) || ' Shared needle body content for article ' || id,1,1,false,
                       timestamptz '2024-01-01 UTC' + id * interval '1 minute',timestamptz '2024-01-01 UTC' + id * interval '1 minute'
                from generate_series(1, 220) id
                """, author);
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article_revision(article_id,revision,title,body,happened_at)
                    select id,revision,title,body,created_at from public.article;
                insert into public.article_publication(article_id,revision,publication_id,published_at)
                    select id,revision,10000+id,created_at from public.article;
                insert into public.article_revision_rights (
                    article_id,revision,enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template,
                    copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled)
                    select article_id,revision,true,'all-rights-reserved','',0,'','','append-attribution',300,true,true,true
                    from public.article_publication;
                insert into public.article_publication_rights (article_id,publication_id,revision)
                    select article_id,publication_id,revision from public.article_publication;
                """);
            await tx.CommitAsync(ct);
        }

        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var client = server.Client;

        // Initial 2 pages: [1..200], [201..220].
        var (gen1, page1Bytes1, page1Etag1, pages1) = await FetchPage(client, 1, null, ct);
        Assert.Equal(2, pages1);
        var (_, page2Bytes1, page2Etag1, _) = await FetchPage(client, 2, gen1, ct);

        // Edit and republish article 220 (page 2 only, compact coordinate/body delta past summary slice that fits FSPT v4).
        var saved = Wire.DecodeDraft(await WriteCommand(client, token, WireRoutes.Save,
            new(220, 1, Guid.NewGuid(), "Corpus article 220", new string('a', 200) + " Shared needle body content for article 220!"), ct));
        var published = Wire.DecodeDraft(await WriteCommand(client, token, WireRoutes.Publish,
            new(saved.Id, saved.Revision, Guid.NewGuid(), "", ""), ct));
        Assert.True(published.Published);

        // Old generation HEAD must now fail with 409.
        using (var staleHead = new HttpRequestMessage(HttpMethod.Head, $"{WireRoutes.PublicSearchCorpus}?generation={gen1}"))
        using (var staleResp = await client.SendAsync(staleHead, ct))
            Assert.Equal(HttpStatusCode.Conflict, staleResp.StatusCode);

        // Page 1 must return 304 NotModified with exact same ETag and new generation!
        using var conditionalPage1 = new HttpRequestMessage(HttpMethod.Get, WireRoutes.PublicSearchCorpus);
        Assert.True(conditionalPage1.Headers.TryAddWithoutValidation("If-None-Match", page1Etag1));
        using var notModified = await client.SendAsync(conditionalPage1, ct);
        Assert.Equal(HttpStatusCode.NotModified, notModified.StatusCode);
        var gen2 = Assert.Single(notModified.Headers.GetValues(WireHeaders.SearchIndexGeneration));
        Assert.NotEqual(gen1, gen2);
        Assert.Equal(page1Etag1, notModified.Headers.ETag?.ToString());
        Assert.Equal("2", Assert.Single(notModified.Headers.GetValues(WireHeaders.SearchIndexPages)));

        // Page 2 full bytes & FSPT patch must match and reconstruct target page bytes exactly!
        var (_, page2Bytes2, page2Etag2, _) = await FetchPage(client, 2, gen2, ct);
        Assert.NotEqual(page2Etag1, page2Etag2);
        using var patchReq = new HttpRequestMessage(HttpMethod.Get,
            $"{WireRoutes.PublicSearchCorpus}?page=2&generation={gen2}&baseGeneration={gen1}");
        Assert.True(patchReq.Headers.TryAddWithoutValidation("Accept", SearchCorpusPatch.Accept));
        Assert.True(patchReq.Headers.TryAddWithoutValidation("If-None-Match", page2Etag1));
        using var patchResp = await client.SendAsync(patchReq, ct);
        Assert.Equal(HttpStatusCode.OK, patchResp.StatusCode);
        Assert.Equal(SearchCorpusPatch.ContentType, patchResp.Content.Headers.ContentType?.MediaType);
        Assert.Equal(page2Etag2[1..^1], Assert.Single(patchResp.Headers.GetValues(WireHeaders.SearchCorpusTargetDigest)));
        var patchBytes = await patchResp.Content.ReadAsByteArrayAsync(ct);
        Assert.True(patchBytes.AsSpan(0, 4).SequenceEqual("FSPT"u8));
        var prefix = BinaryPrimitives.ReadInt32LittleEndian(patchBytes.AsSpan(36));
        var suffix = BinaryPrimitives.ReadInt32LittleEndian(patchBytes.AsSpan(40));
        var reconstructed = page2Bytes1[..prefix]
            .Concat(patchBytes[WireLayouts.SearchCorpusPatchHeaderSize..])
            .Concat(page2Bytes1[^suffix..])
            .ToArray();
        Assert.Equal(page2Bytes2, reconstructed);

        // Retract article 220 -> old gen2 rejected with 409, page 1 STILL 304 with same ETag, page 2 updated without 220.
        var retracted = Wire.DecodeDraft(await WriteCommand(client, token, WireRoutes.Retract,
            new(published.Id, published.Revision, Guid.NewGuid(), "", ""), ct));
        Assert.False(retracted.Published);

        using (var staleHead2 = new HttpRequestMessage(HttpMethod.Head, $"{WireRoutes.PublicSearchCorpus}?generation={gen2}"))
        using (var staleResp2 = await client.SendAsync(staleHead2, ct))
            Assert.Equal(HttpStatusCode.Conflict, staleResp2.StatusCode);

        using var conditionalAfterRetract = new HttpRequestMessage(HttpMethod.Get, WireRoutes.PublicSearchCorpus);
        Assert.True(conditionalAfterRetract.Headers.TryAddWithoutValidation("If-None-Match", page1Etag1));
        using var notModified2 = await client.SendAsync(conditionalAfterRetract, ct);
        Assert.Equal(HttpStatusCode.NotModified, notModified2.StatusCode);
        var gen3 = Assert.Single(notModified2.Headers.GetValues(WireHeaders.SearchIndexGeneration));
        Assert.NotEqual(gen2, gen3);
        Assert.Equal(page1Etag1, notModified2.Headers.ETag?.ToString());

        var (_, page2Bytes3, _, _) = await FetchPage(client, 2, gen3, ct);
        Assert.Equal(19, DocumentCountOf(page2Bytes3));
        Assert.Equal(page1Bytes1.Length, (await FetchPage(client, 1, gen3, ct)).Bytes.Length);
    }

    private static Article MakeArticle(int id) => BaseArticle with
    {
        Id = id,
        Publication = 100 + id,
        Title = $"FsusBlog AEDS Guide {id}",
        Body = $"PostgreSQL dotNet10 博客搜索的公开页 needle article{id}",
        Summary = $"Summary {id}",
        PublishedAt = Published.AddMinutes(id),
    };

    private static Article MakeRichArticle(int id) => BaseArticle with
    {
        Id = id,
        Publication = 100 + id,
        Title = $"FsusBlog Architecture Note {id} CamelCaseHandler",
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

    private static void AssertPageCounts(PublicSnapshot snapshot, int total, int reused)
    {
        Assert.Equal(total, snapshot.CorpusPageCount);
        Assert.Equal(reused, snapshot.ReusedCorpusPageCount);
    }

    private static void AssertPageDocumentCounts(LocalSearchCorpusSnapshot snapshot, ReadOnlySpan<int> counts)
    {
        Assert.Equal(counts.Length, snapshot.Pages.Count);
        for (var i = 0; i < counts.Length; i++)
            Assert.Equal(counts[i], DocumentCountOf(snapshot.Pages[i]));
    }

    private static void AssertMatchesFullEncoder(IReadOnlyList<Article> articles, LocalSearchCorpusSnapshot actual, string? context = null)
    {
        var expected = Assert.IsAssignableFrom<IReadOnlyList<byte[]>>(LocalSearchCorpus.Build(articles));
        Assert.True(expected.Count == actual.Pages.Count,
            $"{context}: expected {expected.Count} pages, got {actual.Pages.Count}");
        for (var i = 0; i < expected.Count; i++)
        {
            Assert.True(expected[i].AsSpan().SequenceEqual(actual.Pages[i]),
                $"{context}: page {i + 1} bytes differ from full encoder.");
        }
    }

    private static void AssertSnapshotCorpusMatchesFullEncoder(IReadOnlyList<Article> articles, PublicSnapshot snapshot)
    {
        var expected = Assert.IsAssignableFrom<IReadOnlyList<byte[]>>(LocalSearchCorpus.Build(articles));
        Assert.Equal(expected.Count, snapshot.CorpusPageCount);
        for (var i = 0; i < expected.Count; i++)
        {
            var actualBytes = Assert.IsType<byte[]>(snapshot.Corpus(i + 1));
            Assert.True(expected[i].AsSpan().SequenceEqual(actualBytes));
            var expectedTag = $"\"{Convert.ToHexStringLower(SHA256.HashData(expected[i]))}\"";
            Assert.Equal(expectedTag, snapshot.CorpusTag(i + 1).ToString());
        }
    }

    private static int DocumentCountOf(byte[] pageBytes) =>
        BinaryPrimitives.ReadInt32LittleEndian(pageBytes.AsSpan(WireLayouts.SearchPackagePayloadOffset + 20));

    private static async Task<(string Generation, byte[] Bytes, string ETag, int Pages)> FetchPage(
        HttpClient client, int page, string? generation, CancellationToken ct)
    {
        var url = generation is null
            ? $"{WireRoutes.PublicSearchCorpus}?page={page}"
            : $"{WireRoutes.PublicSearchCorpus}?page={page}&generation={generation}";
        using var response = await client.GetAsync(url, ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var bytes = await response.Content.ReadAsByteArrayAsync(ct);
        Assert.NotNull(response.Headers.ETag);
        var etag = response.Headers.ETag.ToString();
        Assert.Equal($"\"{Convert.ToHexStringLower(SHA256.HashData(bytes))}\"", etag);
        return (
            Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration)),
            bytes,
            etag,
            int.Parse(Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexPages))));
    }

    private static async Task<byte[]> WriteCommand(HttpClient client, string token, string route, ArticleCommand command, CancellationToken ct)
    {
        using var request = SiteAedsFixture.Request(HttpMethod.Post, route, Wire.EncodeArticleCommand(command), token, handle: null);
        using var response = await client.SendAsync(request, ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }
}
