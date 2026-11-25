using System.Numerics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace FsusBlog.V2.Contracts;

/// <summary>
/// Thresholds and work budget governing incremental segment compaction (#51).
/// Compaction is strictly physical: it purges tombstones and merges segments without
/// re-analyzing documents and never alters semantic matching, counts, or ranking.
/// </summary>
public sealed record SearchIndexCompactionPolicy(
    int MaxSegmentsBeforeCompact = 8,
    double MaxDeletionRatioBeforeCompact = 0.25,
    int MinDeadDocsToCompact = 16,
    int MaxCompactionWorkDocs = 8_000)
{
    public static readonly SearchIndexCompactionPolicy Default = new();
}

/// <summary>
/// Per-build instrumentation proving unchanged documents skip analysis/encoding and reporting
/// segment reuse, tombstone counts, compaction work, and retained memory estimates (#51).
/// </summary>
public readonly record struct SearchIndexBuildStats(
    int TotalLiveDocuments,
    int AnalyzedDocuments,
    int ReindexedDocuments,
    int RemovedDocuments,
    int SkippedAnalysisDocuments,
    int ReusedSegments,
    int TotalSegments,
    int DeadDocumentSlots,
    bool Compacted,
    int CompactedSegments,
    long BytesRewritten,
    long TotalRetainedBytesEstimate,
    string BuildMode);

public sealed partial class ArticleSearchIndex
{
    internal readonly record struct SearchDocFingerprint(ulong W0, ulong W1, ulong W2, ulong W3)
    {
        internal static SearchDocFingerprint FromHash(ReadOnlySpan<byte> sha256) => new(
            BinaryPrimitives.ReadUInt64LittleEndian(sha256),
            BinaryPrimitives.ReadUInt64LittleEndian(sha256[8..]),
            BinaryPrimitives.ReadUInt64LittleEndian(sha256[16..]),
            BinaryPrimitives.ReadUInt64LittleEndian(sha256[24..]));
    }

    private readonly record struct DocumentMeta(
        int ArticleId,
        int TitleLen,
        int HeadingLen,
        int SummaryLen,
        int TaxonomyLen,
        int BodyLen,
        long PublishedAtTicks,
        long CreatedAtTicks,
        long ScannedChars,
        SearchDocFingerprint Fingerprint)
    {
        internal void CopyLengths(Span<int> target)
        {
            target[0] = TitleLen;
            target[1] = HeadingLen;
            target[2] = SummaryLen;
            target[3] = TaxonomyLen;
            target[4] = BodyLen;
        }
    }

    /// <summary>
    /// Immutable server-index segment shared safely across publication generations (#51).
    /// Holds only unmanaged document metadata, sorted term/posting/position tables, and
    /// generation-independent 64-doc primitive block bounds — zero <see cref="Article"/> or
    /// body string references are retained inside segments.
    /// </summary>
    private sealed class SearchSegment
    {
        internal readonly DocumentMeta[] Documents;
        internal readonly Term[] Terms;
        internal readonly Posting[] Postings;
        internal readonly SearchPostingBlockMeta[] Blocks;
        internal readonly uint[] Positions;
        internal readonly ShortPrefixTerm[] ShortPrefixTerms;
        internal readonly ShortPrefixPosting[] ShortPrefixPostings;
        internal readonly ShortPrefixBlockMeta[] ShortPrefixBlocks;
        internal readonly long[] FieldLengthTotals;
        internal readonly long ScannedChars;
        internal readonly long EstimatedBytes;
        internal readonly int AnalyzerVersion;
        internal readonly int ProfileVersion;

        internal SearchSegment(
            DocumentMeta[] documents,
            Term[] terms,
            Posting[] postings,
            SearchPostingBlockMeta[] blocks,
            uint[] positions,
            ShortPrefixTerm[] shortPrefixTerms,
            ShortPrefixPosting[] shortPrefixPostings,
            ShortPrefixBlockMeta[] shortPrefixBlocks,
            long[] fieldLengthTotals,
            long scannedChars,
            int analyzerVersion,
            int profileVersion)
        {
            Documents = documents;
            Terms = terms;
            Postings = postings;
            Blocks = blocks;
            Positions = positions;
            ShortPrefixTerms = shortPrefixTerms;
            ShortPrefixPostings = shortPrefixPostings;
            ShortPrefixBlocks = shortPrefixBlocks;
            FieldLengthTotals = fieldLengthTotals;
            ScannedChars = scannedChars;
            AnalyzerVersion = analyzerVersion;
            ProfileVersion = profileVersion;
            EstimatedBytes = EstimateBytes(documents, terms, postings, blocks, positions,
                shortPrefixTerms, shortPrefixPostings, shortPrefixBlocks);
        }

        private static long EstimateBytes(
            DocumentMeta[] documents,
            Term[] terms,
            Posting[] postings,
            SearchPostingBlockMeta[] blocks,
            uint[] positions,
            ShortPrefixTerm[] spTerms,
            ShortPrefixPosting[] spPostings,
            ShortPrefixBlockMeta[] spBlocks)
        {
            long termStringBytes = 0;
            for (var i = 0; i < terms.Length; i++)
                termStringBytes += 24 + (long)terms[i].Key.Term.Length * sizeof(char);

            return (long)documents.Length * Unsafe.SizeOf<DocumentMeta>()
                + (long)terms.Length * Unsafe.SizeOf<Term>() + termStringBytes
                + (long)postings.Length * Unsafe.SizeOf<Posting>()
                + (long)blocks.Length * Unsafe.SizeOf<SearchPostingBlockMeta>()
                + (long)positions.Length * sizeof(uint)
                + (long)spTerms.Length * Unsafe.SizeOf<ShortPrefixTerm>()
                + (long)spPostings.Length * Unsafe.SizeOf<ShortPrefixPosting>()
                + (long)spBlocks.Length * Unsafe.SizeOf<ShortPrefixBlockMeta>();
        }
    }

    /// <summary>
    /// Computes the 32-byte SHA-256 fingerprint covering every search-relevant input of <paramref name="article"/>
    /// (article ID, revision/publication coordinates, publish/create timestamps, title, summary, body,
    /// category, ordered tags, analyzer version, and scoring profile version).
    /// </summary>
    public static void ComputeArticleFingerprint(Article article, Span<byte> destination)
    {
        ArgumentNullException.ThrowIfNull(article);
        if (destination.Length < 32)
            throw new ArgumentException("Destination must be at least 32 bytes.", nameof(destination));
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        ComputeArticleFingerprintCore(hash, article, SearchTextAnalyzer.Version, SearchScoringProfile.ProfileVersion, destination);
    }

    private static SearchDocFingerprint ComputeDocumentFingerprint(
        IncrementalHash hash,
        Article article,
        int analyzerVersion,
        int profileVersion)
    {
        Span<byte> digest = stackalloc byte[32];
        ComputeArticleFingerprintCore(hash, article, analyzerVersion, profileVersion, digest);
        return SearchDocFingerprint.FromHash(digest);
    }

    private static void ComputeArticleFingerprintCore(
        IncrementalHash hash,
        Article article,
        int analyzerVersion,
        int profileVersion,
        Span<byte> destination)
    {
        Span<byte> fixedBuf = stackalloc byte[52];
        hash.AppendData("fsus-search-doc-fp-v1\0"u8);
        BinaryPrimitives.WriteInt32LittleEndian(fixedBuf, analyzerVersion);
        BinaryPrimitives.WriteInt32LittleEndian(fixedBuf[4..], profileVersion);
        BinaryPrimitives.WriteInt32LittleEndian(fixedBuf[8..], article.Id);
        BinaryPrimitives.WriteInt64LittleEndian(fixedBuf[12..], article.Revision);
        BinaryPrimitives.WriteInt32LittleEndian(fixedBuf[20..], article.RevisionNo);
        BinaryPrimitives.WriteInt64LittleEndian(fixedBuf[24..], article.Publication);
        BinaryPrimitives.WriteInt32LittleEndian(fixedBuf[32..], article.PublicationNo);
        BinaryPrimitives.WriteInt64LittleEndian(fixedBuf[36..], article.PublishedAt.UtcTicks);
        BinaryPrimitives.WriteInt64LittleEndian(fixedBuf[44..], article.CreatedAt.UtcTicks);
        hash.AppendData(fixedBuf);

        AppendString(hash, article.Title);
        AppendString(hash, article.Summary ?? string.Empty);
        AppendString(hash, article.Body ?? string.Empty);

        if (article.Category is { } cat)
        {
            Span<byte> catHeader = stackalloc byte[5];
            catHeader[0] = 1;
            BinaryPrimitives.WriteInt32LittleEndian(catHeader[1..], cat.Id);
            hash.AppendData(catHeader);
            AppendString(hash, cat.Name ?? string.Empty);
        }
        else
        {
            Span<byte> none = [0];
            hash.AppendData(none);
        }

        var tags = article.Tags;
        var tagCount = tags?.Count ?? 0;
        Span<byte> intBuf = stackalloc byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(intBuf, tagCount);
        hash.AppendData(intBuf);
        if (tags is not null)
        {
            for (var i = 0; i < tagCount; i++)
            {
                var tag = tags[i];
                BinaryPrimitives.WriteInt32LittleEndian(intBuf, tag.Id);
                hash.AppendData(intBuf);
                AppendString(hash, tag.Name ?? string.Empty);
            }
        }

        hash.TryGetHashAndReset(destination, out _);

        static void AppendString(IncrementalHash h, string text)
        {
            Span<byte> len = stackalloc byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(len, text.Length);
            h.AppendData(len);
            if (text.Length > 0)
                h.AppendData(MemoryMarshal.AsBytes(text.AsSpan()));
        }
    }

    public static ArticleSearchIndex? BuildIncremental(
        IReadOnlyList<Article> articles,
        ArticleSearchIndex? previous,
        CancellationToken ct,
        out SearchIndexBuildStats buildStats,
        SearchIndexCompactionPolicy? compactionPolicy = null)
    {
        ArgumentNullException.ThrowIfNull(articles);
        ct.ThrowIfCancellationRequested();

        if (articles.Count == 0)
        {
            var removed = previous?.DocumentCount ?? 0;
            buildStats = new SearchIndexBuildStats(
                TotalLiveDocuments: 0,
                AnalyzedDocuments: 0,
                ReindexedDocuments: 0,
                RemovedDocuments: removed,
                SkippedAnalysisDocuments: 0,
                ReusedSegments: 0,
                TotalSegments: 0,
                DeadDocumentSlots: 0,
                Compacted: false,
                CompactedSegments: 0,
                BytesRewritten: 0,
                TotalRetainedBytesEstimate: 0,
                BuildMode: "full-empty");
            return CreateEmpty(SearchTextAnalyzer.Version, SearchScoringProfile.ProfileVersion);
        }

        if (articles.Count > CompactMaxDocuments)
        {
            var wide = BuildWide(articles, ct);
            buildStats = new SearchIndexBuildStats(
                TotalLiveDocuments: wide?.DocumentCount ?? 0,
                AnalyzedDocuments: articles.Count,
                ReindexedDocuments: articles.Count,
                RemovedDocuments: previous?.DocumentCount ?? 0,
                SkippedAnalysisDocuments: 0,
                ReusedSegments: 0,
                TotalSegments: wide is null ? 0 : 1,
                DeadDocumentSlots: 0,
                Compacted: false,
                CompactedSegments: 0,
                BytesRewritten: wide?.EstimatedRetainedBytes ?? 0,
                TotalRetainedBytesEstimate: wide?.EstimatedRetainedBytes ?? 0,
                BuildMode: "full-wide");
            return wide;
        }

        if (previous is null || previous.UsesWideProfile || previous._segments.Length == 0 || previous._duplicateIdsFallback)
        {
            var mode = previous is null ? "full-cold"
                : previous.UsesWideProfile ? "full-from-wide"
                : previous._segments.Length == 0 ? "full-from-empty"
                : "full-duplicate-fallback";
            return BuildSingleSegmentIndex(articles, mode, previous?.DocumentCount ?? 0, ct, out buildStats);
        }

        if (previous.AnalyzerVersion != SearchTextAnalyzer.Version ||
            previous.ProfileVersion != SearchScoringProfile.ProfileVersion)
        {
            return BuildSingleSegmentIndex(articles, "full-version-change", previous.DocumentCount, ct, out buildStats);
        }

        var policy = compactionPolicy ?? SearchIndexCompactionPolicy.Default;
        var prevSegs = previous._segments;
        var prevSegCount = prevSegs.Length;

        // 1. Fingerprint incoming articles and classify unchanged vs added/modified against active live locator
        var incomingById = new Dictionary<int, Article>(articles.Count);
        var stillLiveMasks = new ulong[prevSegCount][];
        for (var s = 0; s < prevSegCount; s++)
            stillLiveMasks[s] = new ulong[WordCount(prevSegs[s].Documents.Length)];

        var toIndexArticles = new List<Article>();
        var toIndexFingerprints = new List<SearchDocFingerprint>();
        var skippedAnalysis = 0;

        using (var fpHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
        {
            for (var i = 0; i < articles.Count; i++)
            {
                if ((i & 63) == 0) ct.ThrowIfCancellationRequested();
                var article = articles[i];
                if (!incomingById.TryAdd(article.Id, article))
                {
                    // Duplicate article IDs (never present in PostgreSQL primary-key projections) fall back safely to full build.
                    return BuildSingleSegmentIndex(articles, "full-duplicate-id", previous.DocumentCount, ct, out buildStats);
                }

                var fp = ComputeDocumentFingerprint(fpHash, article, SearchTextAnalyzer.Version, SearchScoringProfile.ProfileVersion);
                if (previous._liveLocator.TryGetValue(article.Id, out var loc) &&
                    prevSegs[loc.SegmentIndex].Documents[loc.LocalOrdinal].Fingerprint == fp)
                {
                    SetBit(stillLiveMasks[loc.SegmentIndex], loc.LocalOrdinal);
                    skippedAnalysis++;
                }
                else
                {
                    toIndexArticles.Add(article);
                    toIndexFingerprints.Add(fp);
                }
            }
        }

        // 2. Compute exact newly-dead masks and surviving live counts per existing segment
        var newlyDeadMasks = new ulong[]?[prevSegCount];
        var newlyDeadCounts = new int[prevSegCount];
        var newSegLiveCounts = new int[prevSegCount];
        var totalRemoved = 0;

        for (var s = 0; s < prevSegCount; s++)
        {
            ct.ThrowIfCancellationRequested();
            var docCount = prevSegs[s].Documents.Length;
            var prevMask = previous._liveMasks[s];
            var stillMask = stillLiveMasks[s];
            var words = stillMask.Length;
            ulong[]? deadMask = null;
            var deadCount = 0;
            var liveCount = 0;

            for (var w = 0; w < words; w++)
            {
                var prevWord = prevMask is null ? FullWordMask(w, docCount) : prevMask[w];
                var stillWord = stillMask[w];
                var deadWord = prevWord & ~stillWord;
                liveCount += BitOperations.PopCount(stillWord);
                if (deadWord != 0)
                {
                    deadMask ??= new ulong[words];
                    deadMask[w] = deadWord;
                    deadCount += BitOperations.PopCount(deadWord);
                }
            }

            newlyDeadMasks[s] = deadMask;
            newlyDeadCounts[s] = deadCount;
            newSegLiveCounts[s] = liveCount;
            totalRemoved += deadCount;
        }

        // 3. Zero-change fast path: reuse every segment, mask, locator, and global statistic untouched,
        // binding only the current generation's Article map (so obsolete Article objects are never pinned).
        if (toIndexArticles.Count == 0 && totalRemoved == 0)
        {
            var noopIndex = new ArticleSearchIndex(
                prevSegs,
                previous._liveMasks,
                previous._segmentLiveCounts,
                previous._liveLocator,
                incomingById,
                fallbackArticles: null,
                previous._liveDocumentCount,
                previous._deadDocumentSlots,
                previous._totalFieldLengths,
                previous._avgFieldLengths,
                previous._liveScannedChars,
                previous._globalLiveDf,
                previous._globalShortPrefixLiveDf,
                SearchTextAnalyzer.Version,
                SearchScoringProfile.ProfileVersion);

            buildStats = new SearchIndexBuildStats(
                TotalLiveDocuments: articles.Count,
                AnalyzedDocuments: 0,
                ReindexedDocuments: 0,
                RemovedDocuments: 0,
                SkippedAnalysisDocuments: skippedAnalysis,
                ReusedSegments: prevSegCount,
                TotalSegments: prevSegCount,
                DeadDocumentSlots: previous._deadDocumentSlots,
                Compacted: false,
                CompactedSegments: 0,
                BytesRewritten: 0,
                TotalRetainedBytesEstimate: noopIndex.EstimatedRetainedBytes,
                BuildMode: "incremental-noop");
            return noopIndex;
        }

        // 4. Update exact global live statistics ONCE per newly-dead and newly-indexed document
        var totalFieldLengths = (long[])previous._totalFieldLengths.Clone();
        var liveScannedChars = previous._liveScannedChars;
        var globalLiveDf = CloneOrMaterializeGlobalDf(previous, ct);
        var globalSpLiveDf = CloneOrMaterializeGlobalShortPrefixDf(previous, ct);

        for (var s = 0; s < prevSegCount; s++)
        {
            var deadCount = newlyDeadCounts[s];
            if (deadCount == 0) continue;
            ct.ThrowIfCancellationRequested();
            SubtractDeadSegmentContributions(
                prevSegs[s],
                previous._liveMasks[s],
                newlyDeadMasks[s]!,
                deadCount,
                newSegLiveCounts[s],
                totalFieldLengths,
                ref liveScannedChars,
                globalLiveDf,
                globalSpLiveDf,
                ct);
        }

        long bytesRewritten = 0;
        var analyzedDocs = 0;
        SearchSegment? deltaSegment = null;
        if (toIndexArticles.Count > 0)
        {
            var remainingChars = MaxScannedChars - liveScannedChars;
            if (remainingChars < 0)
            {
                buildStats = FailedBuildStats("incremental-budget-chars");
                return null;
            }
            deltaSegment = BuildSegment(
                toIndexArticles,
                toIndexFingerprints,
                remainingChars,
                MaxTerms,
                MaxPostings,
                ct,
                out analyzedDocs);
            if (deltaSegment is null)
            {
                buildStats = FailedBuildStats("incremental-budget-segment");
                return null;
            }
            bytesRewritten += deltaSegment.EstimatedBytes;

            for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                totalFieldLengths[f] += deltaSegment.FieldLengthTotals[f];
            liveScannedChars += deltaSegment.ScannedChars;

            AddSegmentToGlobalDf(deltaSegment, globalLiveDf, globalSpLiveDf, ct);
        }

        if (globalLiveDf.Count > MaxTerms || liveScannedChars > MaxScannedChars)
        {
            buildStats = FailedBuildStats("incremental-budget-global");
            return null;
        }

        // 5. Assemble active surviving segments (immediately dropping completely dead old segments)
        var activeSegments = new List<SearchSegment>(prevSegCount + 1);
        var activeMasks = new List<ulong[]?>(prevSegCount + 1);
        var activeLiveCounts = new List<int>(prevSegCount + 1);
        var reusedSegments = 0;

        for (var s = 0; s < prevSegCount; s++)
        {
            var liveInSeg = newSegLiveCounts[s];
            if (liveInSeg == 0) continue;
            var seg = prevSegs[s];
            activeSegments.Add(seg);
            activeLiveCounts.Add(liveInSeg);
            reusedSegments++;
            if (liveInSeg == seg.Documents.Length)
                activeMasks.Add(null);
            else if (newlyDeadCounts[s] == 0)
                activeMasks.Add(previous._liveMasks[s]);
            else
                activeMasks.Add(stillLiveMasks[s]);
        }

        if (deltaSegment is not null)
        {
            activeSegments.Add(deltaSegment);
            activeMasks.Add(null);
            activeLiveCounts.Add(deltaSegment.Documents.Length);
        }

        // 6. Thresholded, work-budgeted physical compaction (zero reanalysis!)
        var compacted = false;
        var compactedSegmentsCount = 0;
        var totalSlots = 0;
        long totalPhysicalPostings = 0;
        for (var i = 0; i < activeSegments.Count; i++)
        {
            totalSlots += activeSegments[i].Documents.Length;
            totalPhysicalPostings += activeSegments[i].Postings.Length;
        }
        var deadSlots = totalSlots - articles.Count;
        var deletionRatio = totalSlots > 0 ? (double)deadSlots / totalSlots : 0.0;
        var postingPressure = totalPhysicalPostings > MaxPostings;

        var shouldCompact = postingPressure
            || activeSegments.Count >= Math.Max(2, policy.MaxSegmentsBeforeCompact)
            || (deadSlots >= Math.Max(1, policy.MinDeadDocsToCompact) && deletionRatio >= policy.MaxDeletionRatioBeforeCompact);

        if (shouldCompact && activeSegments.Count > 0)
        {
            var selectedIndices = SelectSegmentsForCompaction(
                activeSegments, activeLiveCounts, policy, postingPressure);
            if (selectedIndices.Count > 0)
            {
                var toMergeSegs = new SearchSegment[selectedIndices.Count];
                var toMergeMasks = new ulong[]?[selectedIndices.Count];
                var selectedSet = new HashSet<int>(selectedIndices);
                for (var i = 0; i < selectedIndices.Count; i++)
                {
                    var idx = selectedIndices[i];
                    toMergeSegs[i] = activeSegments[idx];
                    toMergeMasks[i] = activeMasks[idx];
                }

                var merged = MergeSegments(toMergeSegs, toMergeMasks, ct);
                bytesRewritten += merged.EstimatedBytes;
                compacted = true;
                compactedSegmentsCount = selectedIndices.Count;

                // Keep unselected segments untouched, append the clean compacted segment
                var nextSegs = new List<SearchSegment>(activeSegments.Count - selectedIndices.Count + 1);
                var nextMasks = new List<ulong[]?>(nextSegs.Capacity);
                var nextLive = new List<int>(nextSegs.Capacity);
                var survivingReused = 0;
                for (var i = 0; i < activeSegments.Count; i++)
                {
                    if (selectedSet.Contains(i)) continue;
                    nextSegs.Add(activeSegments[i]);
                    nextMasks.Add(activeMasks[i]);
                    nextLive.Add(activeLiveCounts[i]);
                    if (!ReferenceEquals(activeSegments[i], deltaSegment)) survivingReused++;
                }
                nextSegs.Add(merged);
                nextMasks.Add(null);
                nextLive.Add(merged.Documents.Length);

                activeSegments = nextSegs;
                activeMasks = nextMasks;
                activeLiveCounts = nextLive;
                reusedSegments = survivingReused;
            }
        }

        // 7. Enforce final physical posting budget after any compaction
        long finalPhysicalPostings = 0;
        var finalDeadSlots = 0;
        for (var i = 0; i < activeSegments.Count; i++)
        {
            finalPhysicalPostings += activeSegments[i].Postings.Length;
            finalDeadSlots += activeSegments[i].Documents.Length - activeLiveCounts[i];
        }
        if (finalPhysicalPostings > MaxPostings)
        {
            buildStats = FailedBuildStats("incremental-budget-postings");
            return null;
        }

        // 8. Finalize immutable active-generation manifest
        var segArray = activeSegments.ToArray();
        var maskArray = activeMasks.ToArray();
        var liveArray = activeLiveCounts.ToArray();
        var liveLocator = BuildLiveLocator(segArray, maskArray, articles.Count, ct);
        var avgFieldLengths = ComputeAvgFieldLengths(totalFieldLengths, articles.Count);

        // When collapsed cleanly into one unmasked segment, drop global DF dictionaries to keep retained RAM minimal!
        var isSingleClean = segArray.Length == 1 && maskArray[0] is null;
        var index = new ArticleSearchIndex(
            segArray,
            maskArray,
            liveArray,
            liveLocator,
            incomingById,
            fallbackArticles: null,
            articles.Count,
            finalDeadSlots,
            totalFieldLengths,
            avgFieldLengths,
            liveScannedChars,
            isSingleClean ? null : globalLiveDf,
            isSingleClean ? null : globalSpLiveDf,
            SearchTextAnalyzer.Version,
            SearchScoringProfile.ProfileVersion);

        buildStats = new SearchIndexBuildStats(
            TotalLiveDocuments: articles.Count,
            AnalyzedDocuments: analyzedDocs,
            ReindexedDocuments: toIndexArticles.Count,
            RemovedDocuments: totalRemoved,
            SkippedAnalysisDocuments: skippedAnalysis,
            ReusedSegments: reusedSegments,
            TotalSegments: segArray.Length,
            DeadDocumentSlots: finalDeadSlots,
            Compacted: compacted,
            CompactedSegments: compactedSegmentsCount,
            BytesRewritten: bytesRewritten,
            TotalRetainedBytesEstimate: index.EstimatedRetainedBytes,
            BuildMode: compacted ? "incremental-compacted" : "incremental");
        return index;

        SearchIndexBuildStats FailedBuildStats(string mode) => new(
            TotalLiveDocuments: 0,
            AnalyzedDocuments: analyzedDocs,
            ReindexedDocuments: toIndexArticles.Count,
            RemovedDocuments: totalRemoved,
            SkippedAnalysisDocuments: skippedAnalysis,
            ReusedSegments: 0,
            TotalSegments: 0,
            DeadDocumentSlots: 0,
            Compacted: false,
            CompactedSegments: 0,
            BytesRewritten: bytesRewritten,
            TotalRetainedBytesEstimate: 0,
            BuildMode: mode);
    }

    private static ArticleSearchIndex? BuildSingleSegmentIndex(
        IReadOnlyList<Article> articles,
        string buildMode,
        int previousDocCount,
        CancellationToken ct,
        out SearchIndexBuildStats buildStats)
    {
        var fingerprints = new SearchDocFingerprint[articles.Count];
        var byId = new Dictionary<int, Article>(articles.Count);
        var duplicateIds = false;
        using (var fpHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
        {
            for (var i = 0; i < articles.Count; i++)
            {
                if ((i & 63) == 0) ct.ThrowIfCancellationRequested();
                var article = articles[i];
                if (!byId.TryAdd(article.Id, article)) duplicateIds = true;
                fingerprints[i] = ComputeDocumentFingerprint(
                    fpHash, article, SearchTextAnalyzer.Version, SearchScoringProfile.ProfileVersion);
            }
        }

        var segment = BuildSegment(articles, fingerprints, MaxScannedChars, MaxTerms, MaxPostings, ct, out var analyzedDocs);
        if (segment is null)
        {
            buildStats = new SearchIndexBuildStats(
                0, analyzedDocs, articles.Count, previousDocCount, 0, 0, 0, 0, false, 0, 0, 0, buildMode + "-budget-failed");
            return null;
        }

        var segArray = new[] { segment };
        var maskArray = new ulong[]?[] { null };
        var liveArray = new[] { articles.Count };
        var liveLocator = duplicateIds
            ? new Dictionary<int, (int SegmentIndex, int LocalOrdinal)>(0)
            : BuildLiveLocator(segArray, maskArray, articles.Count, ct);
        Article[]? fallback = duplicateIds ? [.. articles] : null;
        var totals = (long[])segment.FieldLengthTotals.Clone();
        var avgs = ComputeAvgFieldLengths(totals, articles.Count);

        var index = new ArticleSearchIndex(
            segArray,
            maskArray,
            liveArray,
            liveLocator,
            duplicateIds ? new Dictionary<int, Article>(0) : byId,
            fallback,
            articles.Count,
            deadDocumentSlots: 0,
            totals,
            avgs,
            segment.ScannedChars,
            globalLiveDf: null,
            globalShortPrefixLiveDf: null,
            SearchTextAnalyzer.Version,
            SearchScoringProfile.ProfileVersion);

        buildStats = new SearchIndexBuildStats(
            TotalLiveDocuments: articles.Count,
            AnalyzedDocuments: analyzedDocs,
            ReindexedDocuments: articles.Count,
            RemovedDocuments: previousDocCount,
            SkippedAnalysisDocuments: 0,
            ReusedSegments: 0,
            TotalSegments: 1,
            DeadDocumentSlots: 0,
            Compacted: false,
            CompactedSegments: 0,
            BytesRewritten: segment.EstimatedBytes,
            TotalRetainedBytesEstimate: index.EstimatedRetainedBytes,
            BuildMode: buildMode);
        return index;
    }

    private static SearchSegment? BuildSegment(
        IReadOnlyList<Article> articles,
        IReadOnlyList<SearchDocFingerprint> fingerprints,
        long remainingChars,
        int termLimit,
        int postingLimit,
        CancellationToken ct,
        out int analyzedDocuments)
    {
        var documents = new DocumentMeta[articles.Count];
        var totalFieldLengths = new long[SearchScoringProfile.FieldCount];
        var builder = new PostingBuilder(remainingChars);
        var ok = builder.Collect(articles, fingerprints, documents, totalFieldLengths, termLimit, postingLimit, ct);
        analyzedDocuments = builder.AnalyzedDocuments;
        if (!ok) return null;

        var totalBlocks = 0;
        foreach (var bucket in builder.Heads.Values)
            totalBlocks += (bucket.Count + PostingBlockSize - 1) / PostingBlockSize;

        var terms = new Term[builder.Heads.Count];
        var postings = new Posting[builder.Pending.Count];
        var blocks = new SearchPostingBlockMeta[totalBlocks];
        var termIndex = 0;
        var start = 0;
        var blockCursor = 0;

        foreach (var (key, bucket) in builder.Heads)
        {
            ct.ThrowIfCancellationRequested();
            var bCount = (bucket.Count + PostingBlockSize - 1) / PostingBlockSize;
            terms[termIndex++] = new Term(key, start, bucket.Count, blockCursor, bCount);

            var write = start + bucket.Count - 1;
            for (var entry = bucket.Head; entry >= 0; entry = builder.Pending[entry].Previous)
                postings[write--] = builder.Pending[entry].Value;

            BuildPostingBlocks(documents, postings, start, bucket.Count, blocks, ref blockCursor);
            start += bucket.Count;
        }
        Array.Sort(terms, Term.ByKey);

        var totalSpBlocks = 0;
        foreach (var bucket in builder.ShortPrefixHeads.Values)
            totalSpBlocks += (bucket.Count + PostingBlockSize - 1) / PostingBlockSize;

        var spTerms = new ShortPrefixTerm[builder.ShortPrefixHeads.Count];
        var spPostings = new ShortPrefixPosting[builder.PendingShortPrefixes.Count];
        var spBlocks = new ShortPrefixBlockMeta[totalSpBlocks];
        var spTermIndex = 0;
        var spStart = 0;
        var spBlockCursor = 0;

        foreach (var (spKey, bucket) in builder.ShortPrefixHeads)
        {
            ct.ThrowIfCancellationRequested();
            var bCount = (bucket.Count + PostingBlockSize - 1) / PostingBlockSize;
            spTerms[spTermIndex++] = new ShortPrefixTerm(spKey, spStart, bucket.Count, spBlockCursor, bCount);

            var write = spStart + bucket.Count - 1;
            for (var entry = bucket.Head; entry >= 0; entry = builder.PendingShortPrefixes[entry].Previous)
                spPostings[write--] = builder.PendingShortPrefixes[entry].Value;

            BuildShortPrefixBlocks(documents, spPostings, spStart, bucket.Count, spBlocks, ref spBlockCursor);
            spStart += bucket.Count;
        }
        Array.Sort(spTerms, ShortPrefixTerm.ByKey);

        return new SearchSegment(
            documents,
            terms,
            postings,
            blocks,
            [.. builder.Positions],
            spTerms,
            spPostings,
            spBlocks,
            totalFieldLengths,
            builder.TotalScannedChars,
            SearchTextAnalyzer.Version,
            SearchScoringProfile.ProfileVersion);
    }

    private static void BuildPostingBlocks(
        DocumentMeta[] documents,
        Posting[] postings,
        int start,
        int count,
        SearchPostingBlockMeta[] blocks,
        ref int blockCursor)
    {
        var bCount = (count + PostingBlockSize - 1) / PostingBlockSize;
        for (var b = 0; b < bCount; b++)
        {
            var bStart = start + b * PostingBlockSize;
            var bEnd = Math.Min(start + count, bStart + PostingBlockSize);
            byte mTf0 = 0, mTf1 = 0, mTf2 = 0, mTf3 = 0, mTf4 = 0, anyExact = 0;
            ushort minL0 = ushort.MaxValue, minL1 = ushort.MaxValue, minL2 = ushort.MaxValue,
                   minL3 = ushort.MaxValue, minL4 = ushort.MaxValue;
            var maxPub = long.MinValue;
            var minPub = long.MaxValue;

            for (var i = bStart; i < bEnd; i++)
            {
                var p = postings[i];
                if (p.Tf0 > mTf0) mTf0 = p.Tf0;
                if (p.Tf1 > mTf1) mTf1 = p.Tf1;
                if (p.Tf2 > mTf2) mTf2 = p.Tf2;
                if (p.Tf3 > mTf3) mTf3 = p.Tf3;
                if (p.Tf4 > mTf4) mTf4 = p.Tf4;
                anyExact |= (byte)(p.ExactFlags & ExactFlagBit);

                var d = documents[p.Ordinal];
                var l0 = (ushort)Math.Min(ushort.MaxValue, d.TitleLen);
                var l1 = (ushort)Math.Min(ushort.MaxValue, d.HeadingLen);
                var l2 = (ushort)Math.Min(ushort.MaxValue, d.SummaryLen);
                var l3 = (ushort)Math.Min(ushort.MaxValue, d.TaxonomyLen);
                var l4 = (ushort)Math.Min(ushort.MaxValue, d.BodyLen);
                if (l0 < minL0) minL0 = l0;
                if (l1 < minL1) minL1 = l1;
                if (l2 < minL2) minL2 = l2;
                if (l3 < minL3) minL3 = l3;
                if (l4 < minL4) minL4 = l4;

                var pub = d.PublishedAtTicks;
                if (pub > maxPub) maxPub = pub;
                if (pub < minPub) minPub = pub;
            }

            blocks[blockCursor++] = new SearchPostingBlockMeta(
                postings[bEnd - 1].Ordinal,
                mTf0, mTf1, mTf2, mTf3, mTf4,
                anyExact,
                minL0, minL1, minL2, minL3, minL4,
                maxPub, minPub);
        }
    }

    private static void BuildShortPrefixBlocks(
        DocumentMeta[] documents,
        ShortPrefixPosting[] spPostings,
        int spStart,
        int count,
        ShortPrefixBlockMeta[] spBlocks,
        ref int spBlockCursor)
    {
        var bCount = (count + PostingBlockSize - 1) / PostingBlockSize;
        for (var b = 0; b < bCount; b++)
        {
            var bStart = spStart + b * PostingBlockSize;
            var bEnd = Math.Min(spStart + count, bStart + PostingBlockSize);
            ushort maxT = 0, maxS = 0, maxX = 0;
            ushort minL0 = ushort.MaxValue, minL2 = ushort.MaxValue, minL3 = ushort.MaxValue;
            var maxPub = long.MinValue;
            var minPub = long.MaxValue;

            for (var i = bStart; i < bEnd; i++)
            {
                var sp = spPostings[i];
                var tHits = (ushort)((sp.Packed >> 20) & 1023);
                var sHits = (ushort)((sp.Packed >> 10) & 1023);
                var xHits = (ushort)(sp.Packed & 1023);
                if (tHits > maxT) maxT = tHits;
                if (sHits > maxS) maxS = sHits;
                if (xHits > maxX) maxX = xHits;

                var d = documents[sp.Ordinal];
                var l0 = (ushort)Math.Min(ushort.MaxValue, d.TitleLen);
                var l2 = (ushort)Math.Min(ushort.MaxValue, d.SummaryLen);
                var l3 = (ushort)Math.Min(ushort.MaxValue, d.TaxonomyLen);
                if (l0 < minL0) minL0 = l0;
                if (l2 < minL2) minL2 = l2;
                if (l3 < minL3) minL3 = l3;

                var pub = d.PublishedAtTicks;
                if (pub > maxPub) maxPub = pub;
                if (pub < minPub) minPub = pub;
            }

            spBlocks[spBlockCursor++] = new ShortPrefixBlockMeta(
                spPostings[bEnd - 1].Ordinal,
                maxT, maxS, maxX,
                minL0, minL2, minL3,
                maxPub, minPub);
        }
    }

    /// <summary>
    /// Zero-reanalysis physical k-way merge of live documents, postings, positions, and short-prefix postings
    /// across selected segments (#51). Preserves every pre-analyzed token, TF, exact flag, and position byte-for-byte
    /// while purging dead slots and computing fresh generation-independent 64-doc block metadata.
    /// </summary>
    private static SearchSegment MergeSegments(
        SearchSegment[] segments,
        ulong[]?[] liveMasks,
        CancellationToken ct)
    {
        var k = segments.Length;
        var totalLive = 0;
        var estPostings = 0;
        var estPositions = 0;
        var estSpPostings = 0;

        for (var s = 0; s < k; s++)
        {
            ct.ThrowIfCancellationRequested();
            var seg = segments[s];
            var mask = liveMasks[s];
            totalLive += mask is null ? seg.Documents.Length : CountBits(mask);
            estPostings += seg.Postings.Length;
            estPositions += seg.Positions.Length;
            estSpPostings += seg.ShortPrefixPostings.Length;
        }

        // 1. Copy live DocumentMeta entries into dense 0..totalLive-1 ordinals
        var mergedDocs = new DocumentMeta[totalLive];
        var ordinalRemap = new int[k][];
        var fieldTotals = new long[SearchScoringProfile.FieldCount];
        long scannedChars = 0;
        var nextOrd = 0;

        for (var s = 0; s < k; s++)
        {
            var seg = segments[s];
            var mask = liveMasks[s];
            var map = new int[seg.Documents.Length];
            for (var ord = 0; ord < seg.Documents.Length; ord++)
            {
                if (mask is not null && !IsLive(mask, ord))
                {
                    map[ord] = -1;
                    continue;
                }
                var d = seg.Documents[ord];
                map[ord] = nextOrd;
                mergedDocs[nextOrd++] = d;
                fieldTotals[0] += d.TitleLen;
                fieldTotals[1] += d.HeadingLen;
                fieldTotals[2] += d.SummaryLen;
                fieldTotals[3] += d.TaxonomyLen;
                fieldTotals[4] += d.BodyLen;
                scannedChars += d.ScannedChars;
            }
            ordinalRemap[s] = map;
        }

        // 2. K-way merge over already-sorted Term[] tables (zero dictionary hashing, zero sorting!)
        var cursors = new int[k];
        var mergedTerms = new List<Term>(segments[0].Terms.Length);
        var mergedPostings = new List<Posting>(Math.Min(estPostings, MaxPostings));
        var mergedPositions = new List<uint>(estPositions);
        var mergedBlocks = new List<SearchPostingBlockMeta>((estPostings + PostingBlockSize - 1) / PostingBlockSize);

        var termLoop = 0;
        while (true)
        {
            if ((++termLoop & 1023) == 0) ct.ThrowIfCancellationRequested();

            var minIdx = -1;
            SearchTermKey minKey = default;
            for (var s = 0; s < k; s++)
            {
                var c = cursors[s];
                if (c >= segments[s].Terms.Length) continue;
                var candidateKey = segments[s].Terms[c].Key;
                if (minIdx < 0 || candidateKey.CompareTo(minKey) < 0)
                {
                    minIdx = s;
                    minKey = candidateKey;
                }
            }
            if (minIdx < 0) break;

            var startPosting = mergedPostings.Count;
            for (var s = minIdx; s < k; s++)
            {
                var c = cursors[s];
                if (c >= segments[s].Terms.Length) continue;
                var term = segments[s].Terms[c];
                if (!term.Key.Equals(minKey)) continue;
                cursors[s] = c + 1;

                var seg = segments[s];
                var map = ordinalRemap[s];
                var segPostings = seg.Postings;
                var segPositions = seg.Positions;
                var end = term.Start + term.Count;
                for (var i = term.Start; i < end; i++)
                {
                    var p = segPostings[i];
                    var mappedOrd = map[p.Ordinal];
                    if (mappedOrd < 0) continue;

                    var posStart = 0;
                    if (p.PosCount > 0)
                    {
                        posStart = mergedPositions.Count;
                        var posSpan = segPositions.AsSpan(p.PosStart, p.PosCount);
                        for (var j = 0; j < posSpan.Length; j++)
                            mergedPositions.Add(posSpan[j]);
                    }
                    mergedPostings.Add(new Posting(
                        mappedOrd, p.Tf0, p.Tf1, p.Tf2, p.Tf3, p.Tf4, p.ExactFlags, posStart, p.PosCount));
                }
            }

            var liveTermCount = mergedPostings.Count - startPosting;
            if (liveTermCount == 0) continue;

            var blockStart = mergedBlocks.Count;
            var bCount = (liveTermCount + PostingBlockSize - 1) / PostingBlockSize;
            var postingSpan = CollectionsMarshal.AsSpan(mergedPostings);
            for (var b = 0; b < bCount; b++)
            {
                var bStart = startPosting + b * PostingBlockSize;
                var bEnd = Math.Min(startPosting + liveTermCount, bStart + PostingBlockSize);
                byte mTf0 = 0, mTf1 = 0, mTf2 = 0, mTf3 = 0, mTf4 = 0, anyExact = 0;
                ushort minL0 = ushort.MaxValue, minL1 = ushort.MaxValue, minL2 = ushort.MaxValue,
                       minL3 = ushort.MaxValue, minL4 = ushort.MaxValue;
                var maxPub = long.MinValue;
                var minPub = long.MaxValue;

                for (var i = bStart; i < bEnd; i++)
                {
                    var p = postingSpan[i];
                    if (p.Tf0 > mTf0) mTf0 = p.Tf0;
                    if (p.Tf1 > mTf1) mTf1 = p.Tf1;
                    if (p.Tf2 > mTf2) mTf2 = p.Tf2;
                    if (p.Tf3 > mTf3) mTf3 = p.Tf3;
                    if (p.Tf4 > mTf4) mTf4 = p.Tf4;
                    anyExact |= (byte)(p.ExactFlags & ExactFlagBit);

                    var d = mergedDocs[p.Ordinal];
                    var l0 = (ushort)Math.Min(ushort.MaxValue, d.TitleLen);
                    var l1 = (ushort)Math.Min(ushort.MaxValue, d.HeadingLen);
                    var l2 = (ushort)Math.Min(ushort.MaxValue, d.SummaryLen);
                    var l3 = (ushort)Math.Min(ushort.MaxValue, d.TaxonomyLen);
                    var l4 = (ushort)Math.Min(ushort.MaxValue, d.BodyLen);
                    if (l0 < minL0) minL0 = l0;
                    if (l1 < minL1) minL1 = l1;
                    if (l2 < minL2) minL2 = l2;
                    if (l3 < minL3) minL3 = l3;
                    if (l4 < minL4) minL4 = l4;

                    var pub = d.PublishedAtTicks;
                    if (pub > maxPub) maxPub = pub;
                    if (pub < minPub) minPub = pub;
                }

                mergedBlocks.Add(new SearchPostingBlockMeta(
                    postingSpan[bEnd - 1].Ordinal,
                    mTf0, mTf1, mTf2, mTf3, mTf4,
                    anyExact,
                    minL0, minL1, minL2, minL3, minL4,
                    maxPub, minPub));
            }
            mergedTerms.Add(new Term(minKey, startPosting, liveTermCount, blockStart, bCount));
        }

        // 3. K-way merge over already-sorted ShortPrefixTerm[] tables
        Array.Clear(cursors);
        var mergedSpTerms = new List<ShortPrefixTerm>(segments[0].ShortPrefixTerms.Length);
        var mergedSpPostings = new List<ShortPrefixPosting>(estSpPostings);
        var mergedSpBlocks = new List<ShortPrefixBlockMeta>((estSpPostings + PostingBlockSize - 1) / PostingBlockSize);

        while (true)
        {
            ct.ThrowIfCancellationRequested();
            var minIdx = -1;
            ushort minSpKey = 0;
            for (var s = 0; s < k; s++)
            {
                var c = cursors[s];
                if (c >= segments[s].ShortPrefixTerms.Length) continue;
                var candidateKey = segments[s].ShortPrefixTerms[c].Key;
                if (minIdx < 0 || candidateKey < minSpKey)
                {
                    minIdx = s;
                    minSpKey = candidateKey;
                }
            }
            if (minIdx < 0) break;

            var startSp = mergedSpPostings.Count;
            for (var s = minIdx; s < k; s++)
            {
                var c = cursors[s];
                if (c >= segments[s].ShortPrefixTerms.Length) continue;
                var spTerm = segments[s].ShortPrefixTerms[c];
                if (spTerm.Key != minSpKey) continue;
                cursors[s] = c + 1;

                var segSp = segments[s].ShortPrefixPostings;
                var map = ordinalRemap[s];
                var end = spTerm.Start + spTerm.Count;
                for (var i = spTerm.Start; i < end; i++)
                {
                    var p = segSp[i];
                    var mappedOrd = map[p.Ordinal];
                    if (mappedOrd < 0) continue;
                    mergedSpPostings.Add(new ShortPrefixPosting(mappedOrd, p.Packed));
                }
            }

            var liveSpCount = mergedSpPostings.Count - startSp;
            if (liveSpCount == 0) continue;

            var blockStart = mergedSpBlocks.Count;
            var bCount = (liveSpCount + PostingBlockSize - 1) / PostingBlockSize;
            var spSpan = CollectionsMarshal.AsSpan(mergedSpPostings);
            for (var b = 0; b < bCount; b++)
            {
                var bStart = startSp + b * PostingBlockSize;
                var bEnd = Math.Min(startSp + liveSpCount, bStart + PostingBlockSize);
                ushort maxT = 0, maxS = 0, maxX = 0;
                ushort minL0 = ushort.MaxValue, minL2 = ushort.MaxValue, minL3 = ushort.MaxValue;
                var maxPub = long.MinValue;
                var minPub = long.MaxValue;

                for (var i = bStart; i < bEnd; i++)
                {
                    var sp = spSpan[i];
                    var tHits = (ushort)((sp.Packed >> 20) & 1023);
                    var sHits = (ushort)((sp.Packed >> 10) & 1023);
                    var xHits = (ushort)(sp.Packed & 1023);
                    if (tHits > maxT) maxT = tHits;
                    if (sHits > maxS) maxS = sHits;
                    if (xHits > maxX) maxX = xHits;

                    var d = mergedDocs[sp.Ordinal];
                    var l0 = (ushort)Math.Min(ushort.MaxValue, d.TitleLen);
                    var l2 = (ushort)Math.Min(ushort.MaxValue, d.SummaryLen);
                    var l3 = (ushort)Math.Min(ushort.MaxValue, d.TaxonomyLen);
                    if (l0 < minL0) minL0 = l0;
                    if (l2 < minL2) minL2 = l2;
                    if (l3 < minL3) minL3 = l3;

                    var pub = d.PublishedAtTicks;
                    if (pub > maxPub) maxPub = pub;
                    if (pub < minPub) minPub = pub;
                }

                mergedSpBlocks.Add(new ShortPrefixBlockMeta(
                    spSpan[bEnd - 1].Ordinal,
                    maxT, maxS, maxX,
                    minL0, minL2, minL3,
                    maxPub, minPub));
            }
            mergedSpTerms.Add(new ShortPrefixTerm(minSpKey, startSp, liveSpCount, blockStart, bCount));
        }

        return new SearchSegment(
            mergedDocs,
            [.. mergedTerms],
            [.. mergedPostings],
            [.. mergedBlocks],
            [.. mergedPositions],
            [.. mergedSpTerms],
            [.. mergedSpPostings],
            [.. mergedSpBlocks],
            fieldTotals,
            scannedChars,
            SearchTextAnalyzer.Version,
            SearchScoringProfile.ProfileVersion);
    }

    private static List<int> SelectSegmentsForCompaction(
        List<SearchSegment> segments,
        List<int> liveCounts,
        SearchIndexCompactionPolicy policy,
        bool postingPressure)
    {
        var count = segments.Count;
        var totalLive = 0;
        for (var i = 0; i < count; i++) totalLive += liveCounts[i];

        // When total live docs fit within work budget (or posting pressure requires full purge),
        // collapse all active segments into one pristine unmasked segment!
        if (postingPressure || totalLive <= Math.Max(1, policy.MaxCompactionWorkDocs))
        {
            // Avoid pointless single-segment rewrite when only 1 clean segment exists
            if (count == 1 && liveCounts[0] == segments[0].Documents.Length) return [];
            var all = new List<int>(count);
            for (var i = 0; i < count; i++) all.Add(i);
            return all;
        }

        // Bounded work budget: greedily select smallest / dirtiest segments fitting MaxCompactionWorkDocs
        var order = new int[count];
        for (var i = 0; i < count; i++) order[i] = i;
        Array.Sort(order, (a, b) =>
        {
            var deadRatioA = 1.0 - (double)liveCounts[a] / Math.Max(1, segments[a].Documents.Length);
            var deadRatioB = 1.0 - (double)liveCounts[b] / Math.Max(1, segments[b].Documents.Length);
            var dirtyA = deadRatioA >= policy.MaxDeletionRatioBeforeCompact;
            var dirtyB = deadRatioB >= policy.MaxDeletionRatioBeforeCompact;
            if (dirtyA != dirtyB) return dirtyA ? -1 : 1;
            var liveCmp = liveCounts[a].CompareTo(liveCounts[b]);
            return liveCmp != 0 ? liveCmp : deadRatioB.CompareTo(deadRatioA);
        });

        var selected = new List<int>();
        var workBudget = Math.Max(1, policy.MaxCompactionWorkDocs);
        var used = 0;
        for (var i = 0; i < count; i++)
        {
            var idx = order[i];
            if (used + liveCounts[idx] <= workBudget)
            {
                selected.Add(idx);
                used += liveCounts[idx];
            }
        }

        // Require meaningful work (>= 2 segments, OR 1 segment with tombstones >= MinDeadDocsToCompact)
        if (selected.Count >= 2)
        {
            selected.Sort();
            return selected;
        }
        if (selected.Count == 1)
        {
            var idx = selected[0];
            var dead = segments[idx].Documents.Length - liveCounts[idx];
            if (dead >= policy.MinDeadDocsToCompact) return selected;
        }

        // Safety valve: if a single massive segment exceeded 50% dead slots, compact it so tombstones stay bounded
        for (var i = 0; i < count; i++)
        {
            var dead = segments[i].Documents.Length - liveCounts[i];
            if (dead >= policy.MinDeadDocsToCompact && dead * 2 >= segments[i].Documents.Length)
                return [i];
        }
        return [];
    }

    private static Dictionary<SearchTermKey, int> CloneOrMaterializeGlobalDf(ArticleSearchIndex previous, CancellationToken ct)
    {
        if (previous._globalLiveDf is not null)
            return new Dictionary<SearchTermKey, int>(previous._globalLiveDf);

        var seg = previous._segments[0];
        var map = new Dictionary<SearchTermKey, int>(seg.Terms.Length);
        for (var i = 0; i < seg.Terms.Length; i++)
        {
            if ((i & 4095) == 0) ct.ThrowIfCancellationRequested();
            map.Add(seg.Terms[i].Key, seg.Terms[i].Count);
        }
        return map;
    }

    private static Dictionary<ushort, int> CloneOrMaterializeGlobalShortPrefixDf(ArticleSearchIndex previous, CancellationToken ct)
    {
        if (previous._globalShortPrefixLiveDf is not null)
            return new Dictionary<ushort, int>(previous._globalShortPrefixLiveDf);

        var seg = previous._segments[0];
        var map = new Dictionary<ushort, int>(seg.ShortPrefixTerms.Length);
        for (var i = 0; i < seg.ShortPrefixTerms.Length; i++)
        {
            if ((i & 1023) == 0) ct.ThrowIfCancellationRequested();
            map.Add(seg.ShortPrefixTerms[i].Key, seg.ShortPrefixTerms[i].Count);
        }
        return map;
    }

    private static void AddSegmentToGlobalDf(
        SearchSegment segment,
        Dictionary<SearchTermKey, int> globalLiveDf,
        Dictionary<ushort, int> globalSpLiveDf,
        CancellationToken ct)
    {
        for (var i = 0; i < segment.Terms.Length; i++)
        {
            if ((i & 4095) == 0) ct.ThrowIfCancellationRequested();
            var t = segment.Terms[i];
            ref var df = ref CollectionsMarshal.GetValueRefOrAddDefault(globalLiveDf, t.Key, out _);
            df += t.Count;
        }
        for (var i = 0; i < segment.ShortPrefixTerms.Length; i++)
        {
            var sp = segment.ShortPrefixTerms[i];
            ref var df = ref CollectionsMarshal.GetValueRefOrAddDefault(globalSpLiveDf, sp.Key, out _);
            df += sp.Count;
        }
    }

    private static void SubtractDeadSegmentContributions(
        SearchSegment seg,
        ulong[]? prevLiveMask,
        ulong[] newlyDeadMask,
        int newlyDeadCount,
        int remainingLiveInSeg,
        long[] totalFieldLengths,
        ref long liveScannedChars,
        Dictionary<SearchTermKey, int> globalLiveDf,
        Dictionary<ushort, int> globalSpLiveDf,
        CancellationToken ct)
    {
        // 1. Subtract each newly-dead document's field lengths and scanned chars ONCE
        var minDeadOrd = int.MaxValue;
        var maxDeadOrd = -1;
        for (var w = 0; w < newlyDeadMask.Length; w++)
        {
            var bits = newlyDeadMask[w];
            while (bits != 0)
            {
                var bit = BitOperations.TrailingZeroCount(bits);
                var ord = (w << 6) + bit;
                if (ord < minDeadOrd) minDeadOrd = ord;
                if (ord > maxDeadOrd) maxDeadOrd = ord;
                var d = seg.Documents[ord];
                totalFieldLengths[0] -= d.TitleLen;
                totalFieldLengths[1] -= d.HeadingLen;
                totalFieldLengths[2] -= d.SummaryLen;
                totalFieldLengths[3] -= d.TaxonomyLen;
                totalFieldLengths[4] -= d.BodyLen;
                liveScannedChars -= d.ScannedChars;
                bits &= bits - 1;
            }
        }

        // 2. Subtract exact global DF contributions ONCE per newly-dead document
        if (remainingLiveInSeg == 0 && prevLiveMask is null)
        {
            // Fast path: entire previously-unmasked segment died — O(Terms) without touching postings!
            for (var i = 0; i < seg.Terms.Length; i++)
            {
                if ((i & 4095) == 0) ct.ThrowIfCancellationRequested();
                DecrementDf(globalLiveDf, seg.Terms[i].Key, seg.Terms[i].Count);
            }
            for (var i = 0; i < seg.ShortPrefixTerms.Length; i++)
                DecrementDf(globalSpLiveDf, seg.ShortPrefixTerms[i].Key, seg.ShortPrefixTerms[i].Count);
            return;
        }

        var postings = seg.Postings;
        var spPostings = seg.ShortPrefixPostings;

        if (newlyDeadCount == 1)
        {
            // Fast single-document path (most common edit/withdraw case): range guard + binary search
            var deadOrd = minDeadOrd;
            for (var i = 0; i < seg.Terms.Length; i++)
            {
                if ((i & 4095) == 0) ct.ThrowIfCancellationRequested();
                var t = seg.Terms[i];
                if (postings[t.Start].Ordinal > deadOrd || postings[t.Start + t.Count - 1].Ordinal < deadOrd)
                    continue;
                if (TryFindPosting(postings, t, deadOrd, out _))
                    DecrementDf(globalLiveDf, t.Key, 1);
            }
            for (var i = 0; i < seg.ShortPrefixTerms.Length; i++)
            {
                var sp = seg.ShortPrefixTerms[i];
                if (spPostings[sp.Start].Ordinal > deadOrd || spPostings[sp.Start + sp.Count - 1].Ordinal < deadOrd)
                    continue;
                if (TryFindShortPrefixPosting(spPostings, sp, deadOrd, out _))
                    DecrementDf(globalSpLiveDf, sp.Key, 1);
            }
            return;
        }

        // Batch-deletion path: single linear pass over overlapping terms using O(1) bitset checks
        for (var i = 0; i < seg.Terms.Length; i++)
        {
            if ((i & 2047) == 0) ct.ThrowIfCancellationRequested();
            var t = seg.Terms[i];
            if (postings[t.Start].Ordinal > maxDeadOrd || postings[t.Start + t.Count - 1].Ordinal < minDeadOrd)
                continue;
            var hits = 0;
            var end = t.Start + t.Count;
            for (var p = t.Start; p < end; p++)
            {
                if (IsLive(newlyDeadMask, postings[p].Ordinal))
                    hits++;
            }
            if (hits > 0) DecrementDf(globalLiveDf, t.Key, hits);
        }

        for (var i = 0; i < seg.ShortPrefixTerms.Length; i++)
        {
            var sp = seg.ShortPrefixTerms[i];
            if (spPostings[sp.Start].Ordinal > maxDeadOrd || spPostings[sp.Start + sp.Count - 1].Ordinal < minDeadOrd)
                continue;
            var hits = 0;
            var end = sp.Start + sp.Count;
            for (var p = sp.Start; p < end; p++)
            {
                if (IsLive(newlyDeadMask, spPostings[p].Ordinal))
                    hits++;
            }
            if (hits > 0) DecrementDf(globalSpLiveDf, sp.Key, hits);
        }
    }

    private static void DecrementDf<TKey>(Dictionary<TKey, int> map, TKey key, int delta) where TKey : notnull
    {
        if (!map.TryGetValue(key, out var current)) return;
        var next = current - delta;
        if (next <= 0) map.Remove(key);
        else map[key] = next;
    }

    private static Dictionary<int, (int SegmentIndex, int LocalOrdinal)> BuildLiveLocator(
        SearchSegment[] segments,
        ulong[]?[] liveMasks,
        int liveCount,
        CancellationToken ct)
    {
        var map = new Dictionary<int, (int SegmentIndex, int LocalOrdinal)>(liveCount);
        for (var s = 0; s < segments.Length; s++)
        {
            ct.ThrowIfCancellationRequested();
            var docs = segments[s].Documents;
            var mask = liveMasks[s];
            for (var ord = 0; ord < docs.Length; ord++)
            {
                if (mask is not null && !IsLive(mask, ord)) continue;
                map[docs[ord].ArticleId] = (s, ord);
            }
        }
        return map;
    }

    internal int GetGlobalLiveDf(SearchTermKey key)
    {
        if (_segments.Length == 0) return 0;
        if (_globalLiveDf is not null)
            return _globalLiveDf.GetValueOrDefault(key);
        return FindTerm(_segments[0].Terms, key).Count;
    }

    internal int GetGlobalShortPrefixLiveDf(ushort key)
    {
        if (_segments.Length == 0) return 0;
        if (_globalShortPrefixLiveDf is not null)
            return _globalShortPrefixLiveDf.GetValueOrDefault(key);
        return FindShortPrefixTerm(_segments[0].ShortPrefixTerms, key).Count;
    }

    internal double GetAverageFieldLength(SearchScoreField field) => _avgFieldLengths[(int)field];

    internal ArticleSearchIndex WithVersionMetadataForTesting(int analyzerVersion, int profileVersion) =>
        new(
            _segments,
            _liveMasks,
            _segmentLiveCounts,
            _liveLocator,
            _articlesById,
            _fallbackArticles,
            _liveDocumentCount,
            _deadDocumentSlots,
            _totalFieldLengths,
            _avgFieldLengths,
            _liveScannedChars,
            _globalLiveDf,
            _globalShortPrefixLiveDf,
            analyzerVersion,
            profileVersion,
            _wide);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static int WordCount(int bitCount) => (bitCount + 63) >> 6;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static void SetBit(ulong[] mask, int index) => mask[index >> 6] |= 1UL << (index & 63);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static bool IsLive(ulong[] mask, int index) => (mask[index >> 6] & (1UL << (index & 63))) != 0;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static ulong FullWordMask(int wordIndex, int totalBits)
    {
        var remaining = totalBits - (wordIndex << 6);
        return remaining >= 64 ? ulong.MaxValue : ((1UL << remaining) - 1UL);
    }

    private static int CountBits(ulong[] mask)
    {
        var total = 0;
        for (var i = 0; i < mask.Length; i++)
            total += BitOperations.PopCount(mask[i]);
        return total;
    }
}
