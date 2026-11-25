using System.Runtime.InteropServices;

namespace FsusBlog.V2.Contracts;

public sealed partial class ArticleSearchIndex
{
    private const int PostingBlockSize = 64;
    private const int SelectiveExactThreshold = 256;

    /// <summary>
    /// Bounded worst-at-root Top-K heap backed by <see cref="ArrayPool{T}"/>.
    /// Clears object references on <see cref="Dispose"/> so pooled arrays never retain published generations (#48).
    /// </summary>
    private struct SearchTopKHeap : IDisposable
    {
        private ArticleSearchHit[]? _buffer;
        private readonly int _capacity;
        private readonly ArticleSearchSort _sort;
        private int _count;

        internal SearchTopKHeap(int capacity, ArticleSearchSort sort)
        {
            _capacity = Math.Max(0, capacity);
            _sort = sort;
            _buffer = _capacity > 0 ? ArrayPool<ArticleSearchHit>.Shared.Rent(_capacity) : null;
            _count = 0;
        }

        internal readonly int Count => _count;
        internal readonly int Capacity => _capacity;
        internal readonly bool IsFull => _capacity > 0 && _count == _capacity;
        internal readonly ArticleSearchHit Worst => _buffer![0];

        internal bool TryPush(ArticleSearchHit hit)
        {
            if (_capacity == 0 || _buffer is null) return false;
            if (_count < _capacity)
            {
                var i = _count++;
                _buffer[i] = hit;
                SiftUp(i);
                return true;
            }
            if (SearchScoringProfile.CompareHits(hit, _buffer[0], _sort) < 0)
            {
                _buffer[0] = hit;
                SiftDown(0);
                return true;
            }
            return false;
        }

        internal ArticleSearchHit[] DrainSorted()
        {
            if (_count == 0 || _buffer is null) return [];
            var result = new ArticleSearchHit[_count];
            Array.Copy(_buffer, 0, result, 0, _count);
            var sort = _sort;
            Array.Sort(result, (a, b) => SearchScoringProfile.CompareHits(a, b, sort));
            return result;
        }

        private void SiftUp(int i)
        {
            var buf = _buffer!;
            var sort = _sort;
            while (i > 0)
            {
                var parent = (i - 1) >> 1;
                // Worst element stays at root: parent must be >= child in CompareHits order
                if (SearchScoringProfile.CompareHits(buf[parent], buf[i], sort) >= 0) break;
                (buf[parent], buf[i]) = (buf[i], buf[parent]);
                i = parent;
            }
        }

        private void SiftDown(int i)
        {
            var buf = _buffer!;
            var sort = _sort;
            while (true)
            {
                var left = (i << 1) + 1;
                if (left >= _count) break;
                var worst = left;
                var right = left + 1;
                if (right < _count && SearchScoringProfile.CompareHits(buf[right], buf[left], sort) > 0)
                    worst = right;
                if (SearchScoringProfile.CompareHits(buf[i], buf[worst], sort) >= 0) break;
                (buf[i], buf[worst]) = (buf[worst], buf[i]);
                i = worst;
            }
        }

        public void Dispose()
        {
            var buf = _buffer;
            if (buf is null) return;
            _buffer = null;
            _count = 0;
            // Clear Article references so ArrayPool never pins obsolete snapshots/generations.
            ArrayPool<ArticleSearchHit>.Shared.Return(buf, clearArray: true);
        }
    }

    private struct CompactTermCursor
    {
        private readonly Posting[] _postings;
        private readonly SearchPostingBlockMeta[] _blocks;
        private readonly int _start;
        private readonly int _end;
        private readonly int _blockStart;
        private readonly int _blockCount;
        private int _pos;
        private int _blockIdx;
        private int _blockEnd;
        private bool _blockAccounted;

        internal CompactTermCursor(Posting[] postings, SearchPostingBlockMeta[] blocks, Term term)
        {
            _postings = postings;
            _blocks = blocks;
            _start = term.Start;
            _end = term.Start + term.Count;
            _blockStart = term.BlockStart;
            _blockCount = term.BlockCount;
            _pos = _start;
            _blockIdx = 0;
            _blockEnd = Math.Min(_end, _start + PostingBlockSize);
            _blockAccounted = false;
        }

        internal readonly int Count => _end - _start;
        internal readonly bool Exhausted => _pos >= _end;
        internal readonly int Doc => _pos < _end ? _postings[_pos].Ordinal : int.MaxValue;
        internal readonly Posting Current => _postings[_pos];

        internal int AdvanceTo(int targetOrdinal, ref SearchExecutionStats stats)
        {
            if (_pos >= _end) return int.MaxValue;
            if (_postings[_pos].Ordinal >= targetOrdinal)
            {
                if (!_blockAccounted) { stats.BlocksVisited++; _blockAccounted = true; }
                return _postings[_pos].Ordinal;
            }

            if (targetOrdinal > _blocks[_blockStart + _blockIdx].MaxOrdinal)
            {
                var nextBlk = FindBlockAtOrAfter(_blockIdx + 1, targetOrdinal);
                var skipped = nextBlk - _blockIdx - (_blockAccounted ? 1 : 0);
                if (skipped > 0) stats.BlocksSkipped += skipped;
                _blockIdx = nextBlk;
                if (_blockIdx >= _blockCount)
                {
                    _pos = _end;
                    return int.MaxValue;
                }
                _pos = _start + _blockIdx * PostingBlockSize;
                _blockEnd = Math.Min(_end, _pos + PostingBlockSize);
                _blockAccounted = true;
                stats.BlocksVisited++;
                if (_postings[_pos].Ordinal >= targetOrdinal)
                {
                    stats.PostingsDecoded++;
                    return _postings[_pos].Ordinal;
                }
            }
            else if (!_blockAccounted)
            {
                stats.BlocksVisited++;
                _blockAccounted = true;
            }

            // Fast 1-step sequential advance inside the current block before falling back to binary search
            if (_pos + 1 < _blockEnd && _postings[_pos + 1].Ordinal >= targetOrdinal)
            {
                _pos++;
                stats.PostingsDecoded++;
                return _postings[_pos].Ordinal;
            }

            // Binary search within current 64-posting block when distance is non-trivial
            var lo = _pos + 1;
            var hi = _blockEnd - 1;
            var steps = 0;
            while (lo < hi)
            {
                var mid = lo + ((hi - lo) >> 1);
                steps++;
                if (_postings[mid].Ordinal < targetOrdinal) lo = mid + 1;
                else hi = mid;
            }
            stats.PostingsDecoded += Math.Max(1, steps);
            _pos = lo;
            if (_pos >= _blockEnd)
            {
                _blockIdx++;
                if (_blockIdx >= _blockCount)
                {
                    _pos = _end;
                    return int.MaxValue;
                }
                _blockEnd = Math.Min(_end, _pos + PostingBlockSize);
                _blockAccounted = false;
            }
            return _pos < _end ? _postings[_pos].Ordinal : int.MaxValue;
        }

        internal readonly bool TryShallowBlock(int targetOrdinal, out SearchPostingBlockMeta meta)
        {
            if (_pos >= _end || _blockIdx >= _blockCount)
            {
                meta = default;
                return false;
            }
            var idx = _blocks[_blockStart + _blockIdx].MaxOrdinal >= targetOrdinal
                ? _blockIdx
                : FindBlockAtOrAfter(_blockIdx + 1, targetOrdinal);
            if (idx >= _blockCount)
            {
                meta = default;
                return false;
            }
            meta = _blocks[_blockStart + idx];
            return true;
        }

        internal readonly double ComputeGlobalMaxBound(double idf, bool allowExactByBlock, bool forceAllowExact, double[] avgFieldLengths)
        {
            var max = 0.0;
            for (var b = 0; b < _blockCount; b++)
            {
                var blk = _blocks[_blockStart + b];
                var allowExact = forceAllowExact || (allowExactByBlock && blk.HasAnyExact != 0);
                var u = blk.UpperBoundBm25F(idf, allowExact, avgFieldLengths);
                if (u > max) max = u;
            }
            return max;
        }

        private readonly int FindBlockAtOrAfter(int startIdx, int targetOrdinal)
        {
            if (startIdx >= _blockCount) return _blockCount;
            if (_blocks[_blockStart + startIdx].MaxOrdinal >= targetOrdinal) return startIdx;
            var lo = startIdx + 1;
            var hi = _blockCount;
            while (lo < hi)
            {
                var mid = lo + ((hi - lo) >> 1);
                if (_blocks[_blockStart + mid].MaxOrdinal < targetOrdinal) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        }
    }

    private struct ShortPrefixCursor
    {
        private readonly ShortPrefixPosting[] _postings;
        private readonly ShortPrefixBlockMeta[] _blocks;
        private readonly int _start;
        private readonly int _end;
        private readonly int _blockStart;
        private readonly int _blockCount;
        private int _pos;
        private int _blockIdx;
        private int _blockEnd;
        private bool _blockAccounted;

        internal ShortPrefixCursor(ShortPrefixPosting[] postings, ShortPrefixBlockMeta[] blocks, ShortPrefixTerm term)
        {
            _postings = postings;
            _blocks = blocks;
            _start = term.Start;
            _end = term.Start + term.Count;
            _blockStart = term.BlockStart;
            _blockCount = term.BlockCount;
            _pos = _start;
            _blockIdx = 0;
            _blockEnd = Math.Min(_end, _start + PostingBlockSize);
            _blockAccounted = false;
        }

        internal readonly int Count => _end - _start;
        internal readonly bool Exhausted => _pos >= _end;
        internal readonly int Doc => _pos < _end ? _postings[_pos].Ordinal : int.MaxValue;
        internal readonly int CurrentPacked => _postings[_pos].Packed;

        internal int AdvanceTo(int targetOrdinal, ref SearchExecutionStats stats)
        {
            if (_pos >= _end) return int.MaxValue;
            if (_postings[_pos].Ordinal >= targetOrdinal)
            {
                if (!_blockAccounted) { stats.BlocksVisited++; _blockAccounted = true; }
                return _postings[_pos].Ordinal;
            }

            if (targetOrdinal > _blocks[_blockStart + _blockIdx].MaxOrdinal)
            {
                var nextBlk = FindBlockAtOrAfter(_blockIdx + 1, targetOrdinal);
                var skipped = nextBlk - _blockIdx - (_blockAccounted ? 1 : 0);
                if (skipped > 0) stats.BlocksSkipped += skipped;
                _blockIdx = nextBlk;
                if (_blockIdx >= _blockCount)
                {
                    _pos = _end;
                    return int.MaxValue;
                }
                _pos = _start + _blockIdx * PostingBlockSize;
                _blockEnd = Math.Min(_end, _pos + PostingBlockSize);
                _blockAccounted = true;
                stats.BlocksVisited++;
                if (_postings[_pos].Ordinal >= targetOrdinal)
                {
                    stats.PostingsDecoded++;
                    return _postings[_pos].Ordinal;
                }
            }
            else if (!_blockAccounted)
            {
                stats.BlocksVisited++;
                _blockAccounted = true;
            }

            if (_pos + 1 < _blockEnd && _postings[_pos + 1].Ordinal >= targetOrdinal)
            {
                _pos++;
                stats.PostingsDecoded++;
                return _postings[_pos].Ordinal;
            }

            var lo = _pos + 1;
            var hi = _blockEnd - 1;
            var steps = 0;
            while (lo < hi)
            {
                var mid = lo + ((hi - lo) >> 1);
                steps++;
                if (_postings[mid].Ordinal < targetOrdinal) lo = mid + 1;
                else hi = mid;
            }
            stats.PostingsDecoded += Math.Max(1, steps);
            _pos = lo;
            if (_pos >= _blockEnd)
            {
                _blockIdx++;
                if (_blockIdx >= _blockCount)
                {
                    _pos = _end;
                    return int.MaxValue;
                }
                _blockEnd = Math.Min(_end, _pos + PostingBlockSize);
                _blockAccounted = false;
            }
            return _pos < _end ? _postings[_pos].Ordinal : int.MaxValue;
        }

        internal readonly bool TryShallowBlock(int targetOrdinal, out ShortPrefixBlockMeta meta)
        {
            if (_pos >= _end || _blockIdx >= _blockCount)
            {
                meta = default;
                return false;
            }
            var idx = _blocks[_blockStart + _blockIdx].MaxOrdinal >= targetOrdinal
                ? _blockIdx
                : FindBlockAtOrAfter(_blockIdx + 1, targetOrdinal);
            if (idx >= _blockCount)
            {
                meta = default;
                return false;
            }
            meta = _blocks[_blockStart + idx];
            return true;
        }

        internal readonly double ComputeGlobalMaxBound(double idf, double[] avgFieldLengths)
        {
            var max = 0.0;
            for (var b = 0; b < _blockCount; b++)
            {
                var blk = _blocks[_blockStart + b];
                var u = SearchScoringProfile.UpperBoundShortPrefixBlockBm25F(
                    idf,
                    blk.MaxTitleHits, blk.MaxSummaryHits, blk.MaxTaxonomyHits,
                    blk.MinLen0, blk.MinLen2, blk.MinLen3,
                    avgFieldLengths);
                if (u > max) max = u;
            }
            return max;
        }

        private readonly int FindBlockAtOrAfter(int startIdx, int targetOrdinal)
        {
            if (startIdx >= _blockCount) return _blockCount;
            if (_blocks[_blockStart + startIdx].MaxOrdinal >= targetOrdinal) return startIdx;
            var lo = startIdx + 1;
            var hi = _blockCount;
            while (lo < hi)
            {
                var mid = lo + ((hi - lo) >> 1);
                if (_blocks[_blockStart + mid].MaxOrdinal < targetOrdinal) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        }
    }

    private sealed class ResolvedConcept
    {
        internal required SearchConcept Concept;
        internal double Idf;
        internal double ShortPrefixIdf;
        internal bool CanMatch;
        internal Term PrimaryTerm;
        internal Term ExactTerm; // for Term concepts with DiffersFromExactForm
        internal ShortPrefixTerm ShortPrefixTerm;
        internal Term[]? StepTerms; // CjkSequence canonical steps or CompoundHyphen sub-terms (Steps[1..])
        internal Term[]? ExactStepTerms; // CjkSequence exact-form steps
        internal int RarestStepIndex;
        internal bool AllExactStepsExist;
        internal bool AllSubsExist;
    }

    /// <summary>
    /// Seekable concept stream supporting single terms, short-prefix unions, CJK bigram sequences,
    /// and compound-hyphen unions with dynamic block-max upper bounds and publish-timestamp ranges.
    /// </summary>
    private struct ConceptStream
    {
        internal ResolvedConcept Resolved;
        internal CompactTermCursor MainCursor;
        internal CompactTermCursor AltCursor; // CompoundHyphen rarest sub-term
        internal ShortPrefixCursor PrefixCursor; // ShortAsciiPrefix fallback
        internal bool HasMain;
        internal bool HasAlt;
        internal bool HasPrefix;
        internal double GlobalMaxBound;

        internal static ConceptStream Create(
            ResolvedConcept rc,
            Posting[] postings,
            SearchPostingBlockMeta[] blocks,
            ShortPrefixPosting[] spPostings,
            ShortPrefixBlockMeta[] spBlocks,
            double[] avgFieldLengths)
        {
            var s = new ConceptStream { Resolved = rc };
            switch (rc.Concept.Kind)
            {
                case SearchConceptKind.CjkSequence:
                {
                    if (rc.CanMatch && rc.StepTerms is not null)
                    {
                        var rarest = rc.StepTerms[rc.RarestStepIndex];
                        s.MainCursor = new CompactTermCursor(postings, blocks, rarest);
                        s.HasMain = rarest.Count > 0;
                        var rarestStep = rc.Concept.Steps[rc.RarestStepIndex];
                        s.GlobalMaxBound = s.HasMain
                            ? s.MainCursor.ComputeGlobalMaxBound(
                                rc.Idf,
                                allowExactByBlock: rc.AllExactStepsExist && !rarestStep.DiffersFromExactForm,
                                forceAllowExact: rc.AllExactStepsExist && rarestStep.DiffersFromExactForm,
                                avgFieldLengths)
                            : 0.0;
                    }
                    break;
                }
                case SearchConceptKind.CompoundHyphen:
                {
                    if (rc.PrimaryTerm.Count > 0)
                    {
                        s.MainCursor = new CompactTermCursor(postings, blocks, rc.PrimaryTerm);
                        s.HasMain = true;
                    }
                    if (rc.AllSubsExist && rc.StepTerms is not null)
                    {
                        var rarestSub = rc.StepTerms[rc.RarestStepIndex];
                        if (rarestSub.Count > 0)
                        {
                            s.AltCursor = new CompactTermCursor(postings, blocks, rarestSub);
                            s.HasAlt = true;
                        }
                    }
                    // Conservative global bound for CompoundHyphen: combine max per-field TF across exact & rarest sub
                    if (s.HasMain && s.HasAlt)
                    {
                        var maxMain = s.MainCursor.ComputeGlobalMaxBound(rc.Idf, allowExactByBlock: true, forceAllowExact: false, avgFieldLengths);
                        var maxAlt = s.AltCursor.ComputeGlobalMaxBound(rc.Idf, allowExactByBlock: false, forceAllowExact: false, avgFieldLengths);
                        // Concavity of BM25F guarantees bm25(max(tfA, tfB)) <= bm25(tfA + tfB) <= bm25(tfA) + bm25(tfB)
                        s.GlobalMaxBound = maxMain + maxAlt;
                    }
                    else if (s.HasMain)
                    {
                        s.GlobalMaxBound = s.MainCursor.ComputeGlobalMaxBound(rc.Idf, allowExactByBlock: true, forceAllowExact: false, avgFieldLengths);
                    }
                    else if (s.HasAlt)
                    {
                        s.GlobalMaxBound = s.AltCursor.ComputeGlobalMaxBound(rc.Idf, allowExactByBlock: false, forceAllowExact: false, avgFieldLengths);
                    }
                    break;
                }
                default:
                {
                    if (rc.PrimaryTerm.Count > 0)
                    {
                        s.MainCursor = new CompactTermCursor(postings, blocks, rc.PrimaryTerm);
                        s.HasMain = true;
                    }
                    if (rc.ShortPrefixTerm.Count > 0)
                    {
                        s.PrefixCursor = new ShortPrefixCursor(spPostings, spBlocks, rc.ShortPrefixTerm);
                        s.HasPrefix = true;
                    }
                    var step = rc.Concept.Steps[0];
                    var mainBound = s.HasMain
                        ? s.MainCursor.ComputeGlobalMaxBound(
                            rc.Idf,
                            allowExactByBlock: !step.DiffersFromExactForm,
                            forceAllowExact: step.DiffersFromExactForm && rc.ExactTerm.Count > 0,
                            avgFieldLengths)
                        : 0.0;
                    var spBound = s.HasPrefix ? s.PrefixCursor.ComputeGlobalMaxBound(rc.ShortPrefixIdf, avgFieldLengths) : 0.0;
                    s.GlobalMaxBound = Math.Max(mainBound, spBound);
                    break;
                }
            }
            return s;
        }

        internal readonly int EstimatedCount =>
            (HasMain ? MainCursor.Count : 0) +
            (HasAlt ? AltCursor.Count : 0) +
            (HasPrefix ? PrefixCursor.Count : 0);

        internal readonly int Doc
        {
            get
            {
                var d = HasMain ? MainCursor.Doc : int.MaxValue;
                if (HasAlt)
                {
                    var d2 = AltCursor.Doc;
                    if (d2 < d) d = d2;
                }
                if (HasPrefix)
                {
                    var d3 = PrefixCursor.Doc;
                    if (d3 < d) d = d3;
                }
                return d;
            }
        }

        internal int AdvanceTo(int targetOrdinal, ref SearchExecutionStats stats)
        {
            var d = int.MaxValue;
            if (HasMain)
            {
                var d1 = MainCursor.AdvanceTo(targetOrdinal, ref stats);
                if (d1 < d) d = d1;
            }
            if (HasAlt)
            {
                var d2 = AltCursor.AdvanceTo(targetOrdinal, ref stats);
                if (d2 < d) d = d2;
            }
            if (HasPrefix)
            {
                var d3 = PrefixCursor.AdvanceTo(targetOrdinal, ref stats);
                if (d3 < d) d = d3;
            }
            return d;
        }

        internal readonly double ShallowBlockBound(
            int targetOrdinal,
            double[] avgFieldLengths,
            out int blockMaxDoc,
            out long minPubTicks,
            out long maxPubTicks)
        {
            blockMaxDoc = int.MaxValue;
            minPubTicks = long.MaxValue;
            maxPubTicks = long.MinValue;

            switch (Resolved.Concept.Kind)
            {
                case SearchConceptKind.CjkSequence:
                {
                    if (!HasMain || !MainCursor.TryShallowBlock(targetOrdinal, out var blk)) return 0.0;
                    blockMaxDoc = blk.MaxOrdinal;
                    minPubTicks = blk.MinPublishedTicks;
                    maxPubTicks = blk.MaxPublishedTicks;
                    var rarestStep = Resolved.Concept.Steps[Resolved.RarestStepIndex];
                    var allowExact = Resolved.AllExactStepsExist &&
                                     (rarestStep.DiffersFromExactForm || blk.HasAnyExact != 0);
                    return blk.UpperBoundBm25F(Resolved.Idf, allowExact, avgFieldLengths);
                }
                case SearchConceptKind.CompoundHyphen:
                {
                    SearchPostingBlockMeta blkA = default;
                    SearchPostingBlockMeta blkB = default;
                    var okA = HasMain && MainCursor.TryShallowBlock(targetOrdinal, out blkA);
                    var okB = HasAlt && AltCursor.TryShallowBlock(targetOrdinal, out blkB);
                    if (!okA && !okB) return 0.0;
                    if (okA && okB)
                    {
                        blockMaxDoc = Math.Min(blkA.MaxOrdinal, blkB.MaxOrdinal);
                        minPubTicks = Math.Min(blkA.MinPublishedTicks, blkB.MinPublishedTicks);
                        maxPubTicks = Math.Max(blkA.MaxPublishedTicks, blkB.MaxPublishedTicks);
                        var merged = SearchPostingBlockMeta.Merge(blkA, blkB);
                        return merged.UpperBoundBm25F(Resolved.Idf, blkA.HasAnyExact != 0, avgFieldLengths);
                    }
                    if (okA)
                    {
                        blockMaxDoc = blkA.MaxOrdinal;
                        minPubTicks = blkA.MinPublishedTicks;
                        maxPubTicks = blkA.MaxPublishedTicks;
                        return blkA.UpperBoundBm25F(Resolved.Idf, blkA.HasAnyExact != 0, avgFieldLengths);
                    }
                    blockMaxDoc = blkB.MaxOrdinal;
                    minPubTicks = blkB.MinPublishedTicks;
                    maxPubTicks = blkB.MaxPublishedTicks;
                    return blkB.UpperBoundBm25F(Resolved.Idf, allowExactBonus: false, avgFieldLengths);
                }
                default:
                {
                    var step = Resolved.Concept.Steps[0];
                    SearchPostingBlockMeta blkM = default;
                    ShortPrefixBlockMeta blkP = default;
                    var okM = HasMain && MainCursor.TryShallowBlock(targetOrdinal, out blkM);
                    var okP = HasPrefix && PrefixCursor.TryShallowBlock(targetOrdinal, out blkP);
                    if (!okM && !okP) return 0.0;
                    var boundM = 0.0;
                    if (okM)
                    {
                        var allowExact = step.DiffersFromExactForm
                            ? Resolved.ExactTerm.Count > 0
                            : blkM.HasAnyExact != 0;
                        boundM = blkM.UpperBoundBm25F(Resolved.Idf, allowExact, avgFieldLengths);
                        blockMaxDoc = blkM.MaxOrdinal;
                        minPubTicks = blkM.MinPublishedTicks;
                        maxPubTicks = blkM.MaxPublishedTicks;
                    }
                    var boundP = 0.0;
                    if (okP)
                    {
                        boundP = SearchScoringProfile.UpperBoundShortPrefixBlockBm25F(
                            Resolved.ShortPrefixIdf,
                            blkP.MaxTitleHits, blkP.MaxSummaryHits, blkP.MaxTaxonomyHits,
                            blkP.MinLen0, blkP.MinLen2, blkP.MinLen3,
                            avgFieldLengths);
                        if (blkP.MaxOrdinal < blockMaxDoc) blockMaxDoc = blkP.MaxOrdinal;
                        if (blkP.MinPublishedTicks < minPubTicks) minPubTicks = blkP.MinPublishedTicks;
                        if (blkP.MaxPublishedTicks > maxPubTicks) maxPubTicks = blkP.MaxPublishedTicks;
                    }
                    return Math.Max(boundM, boundP);
                }
            }
        }
    }

    private readonly record struct CompactSearchOutcome(
        ArticleSearchHit[] PrimaryHits,
        int PrimaryCount,
        ArticleSearchHit[] RelaxedHits,
        int RelaxedCount,
        bool PrunedCounting);

    private CompactSearchOutcome ExecuteCompactSearch(
        SearchQueryPlan plan,
        ArticleSearchSort sort,
        int primaryNeed,
        int relaxedNeedCap,
        SearchCursorPosition? afterCursor,
        int returnedSoFar,
        int pageTake,
        int workBudget,
        bool requireExactCount,
        CancellationToken ct,
        out SearchExecutionStats stats)
    {
        stats = default;
        var n = _documents.Length;
        var concepts = plan.ContentConcepts;

        // 1. Pre-resolve all quoted phrase steps; any absent step immediately fails closed
        Term[][] quotedPhraseTerms = plan.QuotedPhrases.Length == 0 ? [] : new Term[plan.QuotedPhrases.Length][];
        for (var p = 0; p < plan.QuotedPhrases.Length; p++)
        {
            var steps = plan.QuotedPhrases[p].Steps;
            var arr = new Term[steps.Length];
            for (var s = 0; s < steps.Length; s++)
            {
                var t = FindTerm(_terms, steps[s].CanonicalKey);
                if (t.Count == 0)
                    return new([], 0, [], 0, false);
                arr[s] = t;
            }
            quotedPhraseTerms[p] = arr;
        }

        var allowsRelaxation = SearchScoringProfile.AllowsRelaxation(plan);
        var minRelaxed = SearchScoringProfile.MinRelaxedConcepts(concepts.Length);
        var minRelaxedRatio = SearchScoringProfile.MinRelaxedIdfRatio(concepts.Length);

        // 2. Resolve every content concept once (zero O(N) metadata scans; short prefixes use pre-indexed ShortPrefixTerm[])
        var resolved = new ResolvedConcept[concepts.Length];
        var totalQueryIdf = 0.0;
        var possibleConcepts = 0;
        var possibleIdfSum = 0.0;
        var allConceptsCanMatch = true;

        for (var c = 0; c < concepts.Length; c++)
        {
            ct.ThrowIfCancellationRequested();
            var concept = concepts[c];
            var rc = new ResolvedConcept { Concept = concept };
            switch (concept.Kind)
            {
                case SearchConceptKind.CjkSequence:
                {
                    var stepTerms = new Term[concept.Steps.Length];
                    var exactStepTerms = new Term[concept.Steps.Length];
                    var maxIdf = 0.0;
                    var allPresent = true;
                    var allExact = true;
                    var rarestIdx = 0;
                    var rarestCount = int.MaxValue;
                    for (var s = 0; s < concept.Steps.Length; s++)
                    {
                        var st = concept.Steps[s];
                        var t = FindTerm(_terms, st.CanonicalKey);
                        stepTerms[s] = t;
                        if (t.Count == 0) allPresent = false;
                        if (t.Count < rarestCount) { rarestCount = t.Count; rarestIdx = s; }
                        var ex = st.DiffersFromExactForm ? FindTerm(_terms, st.ExactFormKey) : t;
                        exactStepTerms[s] = ex;
                        if (ex.Count == 0) allExact = false;
                        var stIdf = SearchScoringProfile.InverseDocumentFrequency(n, t.Count);
                        if (stIdf > maxIdf) maxIdf = stIdf;
                    }
                    rc.StepTerms = stepTerms;
                    rc.ExactStepTerms = exactStepTerms;
                    rc.RarestStepIndex = rarestIdx;
                    rc.AllExactStepsExist = allExact;
                    rc.Idf = maxIdf;
                    rc.CanMatch = allPresent;
                    break;
                }
                case SearchConceptKind.CompoundHyphen:
                {
                    var exact = FindTerm(_terms, concept.Steps[0].CanonicalKey);
                    rc.PrimaryTerm = exact;
                    var subCount = Math.Max(0, concept.Steps.Length - 1);
                    var subTerms = subCount > 0 ? new Term[subCount] : [];
                    var allSubs = subCount > 0;
                    var minSubDf = n;
                    var rarestSubIdx = 0;
                    for (var i = 0; i < subCount; i++)
                    {
                        var st = FindTerm(_terms, concept.Steps[i + 1].CanonicalKey);
                        subTerms[i] = st;
                        if (st.Count == 0) allSubs = false;
                        if (st.Count < minSubDf) { minSubDf = st.Count; rarestSubIdx = i; }
                    }
                    rc.StepTerms = subTerms;
                    rc.AllSubsExist = allSubs;
                    rc.RarestStepIndex = rarestSubIdx;
                    var combinedDf = Math.Min(n, Math.Max(exact.Count, allSubs ? minSubDf : 0));
                    rc.Idf = SearchScoringProfile.InverseDocumentFrequency(n, combinedDf);
                    rc.CanMatch = exact.Count > 0 || allSubs;
                    break;
                }
                default:
                {
                    var step = concept.Steps[0];
                    var term = FindTerm(_terms, step.CanonicalKey);
                    rc.PrimaryTerm = term;
                    rc.ExactTerm = step.DiffersFromExactForm ? FindTerm(_terms, step.ExactFormKey) : term;
                    rc.Idf = SearchScoringProfile.InverseDocumentFrequency(n, term.Count);
                    rc.CanMatch = term.Count > 0;
                    if (concept.ShortAsciiPrefix is { } prefix)
                    {
                        var spKey = ArticleSearchTokens.PackShortPrefixKey(prefix.AsSpan());
                        var spTerm = FindShortPrefixTerm(_shortPrefixTerms, spKey);
                        rc.ShortPrefixTerm = spTerm;
                        if (spTerm.Count > 0)
                        {
                            rc.ShortPrefixIdf = SearchScoringProfile.InverseDocumentFrequency(n, Math.Min(n, term.Count + spTerm.Count));
                            rc.CanMatch = true;
                        }
                    }
                    break;
                }
            }

            resolved[c] = rc;
            totalQueryIdf += rc.Idf;
            if (!rc.CanMatch)
            {
                allConceptsCanMatch = false;
                if (concept.IsStrictIdentifier || !allowsRelaxation)
                    return new([], 0, [], 0, false);
            }
            else
            {
                possibleConcepts++;
                possibleIdfSum += rc.Idf;
            }
        }

        if (possibleConcepts < minRelaxed || (totalQueryIdf > 0.0 && possibleIdfSum / totalQueryIdf < minRelaxedRatio))
            return new([], 0, [], 0, false);

        // 3. Path 1: Single simple term fast path — exact O(1) DF enables full Block-Max & Latest pruning even with exact count!
        if (concepts.Length == 1 &&
            plan.QuotedPhrases.Length == 0 &&
            concepts[0].Kind == SearchConceptKind.Term &&
            concepts[0].ShortAsciiPrefix is null)
        {
            return ExecuteSingleSimpleTerm(resolved[0], sort, primaryNeed, afterCursor, workBudget, ct, ref stats);
        }

        // Pre-resolve OrderedQuerySequence terms once (only needed when >= 2 steps)
        Term[] orderedSeqTerms = [];
        if (plan.OrderedQuerySequence.Length >= 2)
        {
            orderedSeqTerms = new Term[plan.OrderedQuerySequence.Length];
            for (var i = 0; i < plan.OrderedQuerySequence.Length; i++)
                orderedSeqTerms[i] = FindTerm(_terms, plan.OrderedQuerySequence[i].CanonicalKey);
        }

        var maxPrimaryPhraseBonus = (plan.QuotedPhrases.Length > 0 || plan.OrderedQuerySequence.Length >= 2)
            ? SearchScoringProfile.TitleOrHeadingPhraseBonusFactor * totalQueryIdf * (1.0 + 1e-11) + 1e-11
            : 0.0;

        var workUsed = 0;
        var prunedCounting = false;

        // 4. Path 2: Primary-first conjunction (skip completely when any concept cannot match)
        ArticleSearchHit[] primaryHits = [];
        var primaryObserved = 0;
        if (allConceptsCanMatch)
        {
            var effectivePrimaryNeed = afterCursor is { Tier: SearchMatchTier.Relaxed } ? 0 : primaryNeed;
            primaryHits = ExecutePrimaryConjunction(
                plan, resolved, quotedPhraseTerms, orderedSeqTerms,
                totalQueryIdf, maxPrimaryPhraseBonus, allowsRelaxation,
                sort, effectivePrimaryNeed, afterCursor, workBudget, requireExactCount,
                ct, ref workUsed, ref prunedCounting, ref stats, out primaryObserved);
        }

        // 5. Path 3: Bounded Relaxation — ONLY runs when allowsRelaxation && primaryObserved < 5!
        ArticleSearchHit[] relaxedHits = [];
        var relaxedObserved = 0;
        if (allowsRelaxation && primaryObserved < SearchScoringProfile.RelaxationTriggerPrimaryCount)
        {
            int effectiveRelaxedNeed;
            if (afterCursor is { Tier: SearchMatchTier.Relaxed })
            {
                var returnedRelaxedSoFar = Math.Max(0, returnedSoFar - primaryObserved);
                var remainingRelaxedCap = Math.Max(0, SearchScoringProfile.MaxRelaxedResults - returnedRelaxedSoFar);
                var relaxedTake = Math.Min(pageTake, remainingRelaxedCap);
                var needExtra = relaxedTake > 0 && relaxedTake < remainingRelaxedCap && returnedSoFar + relaxedTake < MaxPaginatedResults;
                effectiveRelaxedNeed = relaxedTake + (needExtra ? 1 : 0);
            }
            else if (afterCursor is { Tier: SearchMatchTier.Primary } || !requireExactCount)
            {
                // Primary hits returned on this page (capped at pageTake) leave remaining slots for Relaxed
                var primaryOnPage = Math.Min(primaryHits.Length, pageTake);
                var remainingSlots = Math.Max(0, pageTake - primaryOnPage);
                var remainingRelaxedCap = Math.Min(SearchScoringProfile.MaxRelaxedResults, remainingSlots);
                var needExtra = remainingSlots > 0 && remainingRelaxedCap < SearchScoringProfile.MaxRelaxedResults &&
                                returnedSoFar + primaryOnPage + remainingRelaxedCap < MaxPaginatedResults;
                // Even if primaryOnPage == pageTake and primaryHits.Length == pageTake (no extra primary hit),
                // we still need at least 1 relaxed hit to determine HasMore accurately!
                if (remainingSlots == 0 && primaryHits.Length <= pageTake && pageTake > 0 &&
                    returnedSoFar + primaryOnPage < MaxPaginatedResults)
                {
                    effectiveRelaxedNeed = 1;
                }
                else
                {
                    effectiveRelaxedNeed = remainingRelaxedCap + (needExtra ? 1 : 0);
                }
            }
            else
            {
                // SearchDetailed offset mode: cap relaxed heap at min(MaxRelaxedResults, relaxedNeedCap)
                effectiveRelaxedNeed = Math.Min(SearchScoringProfile.MaxRelaxedResults, relaxedNeedCap);
            }

            var relaxedCursor = afterCursor is { Tier: SearchMatchTier.Relaxed } ? afterCursor : null;
            relaxedHits = ExecuteRelaxedDisjunction(
                plan, resolved, quotedPhraseTerms,
                totalQueryIdf, minRelaxed, minRelaxedRatio,
                sort, effectiveRelaxedNeed, relaxedCursor, workBudget, requireExactCount,
                ct, ref workUsed, ref prunedCounting, ref stats, out relaxedObserved);
            if (relaxedObserved > SearchScoringProfile.MaxRelaxedResults)
                relaxedObserved = SearchScoringProfile.MaxRelaxedResults;
        }

        stats.PrunedCounting = prunedCounting;
        return new(primaryHits, primaryObserved, relaxedHits, relaxedObserved, prunedCounting);
    }

    private CompactSearchOutcome ExecuteSingleSimpleTerm(
        ResolvedConcept rc,
        ArticleSearchSort sort,
        int primaryNeed,
        SearchCursorPosition? afterCursor,
        int workBudget,
        CancellationToken ct,
        ref SearchExecutionStats stats)
    {
        var term = rc.PrimaryTerm;
        var df = term.Count;
        var step = rc.Concept.Steps[0];
        var differsExact = step.DiffersFromExactForm;
        var exactTerm = rc.ExactTerm;
        var idf = rc.Idf;

        stats.Path = sort == ArticleSearchSort.Latest
            ? SearchExecutionPath.LatestBlockScan
            : (df <= SelectiveExactThreshold ? SearchExecutionPath.SelectiveExact : SearchExecutionPath.BlockMaxConjunction);

        // Relaxed cursor cannot have any Primary hits after it; zero need means O(1) return!
        if (primaryNeed == 0 || afterCursor is { Tier: SearchMatchTier.Relaxed })
            return new([], df, [], 0, false);

        var hasExactCursor = differsExact && exactTerm.Count > 0;
        var exactCursor = hasExactCursor ? new CompactTermCursor(_postings, _blocks, exactTerm) : default;
        var cursorPubTicks = afterCursor?.PublishedAtTicks ?? long.MaxValue;
        var hasCursor = afterCursor.HasValue;

        using var heap = new SearchTopKHeap(primaryNeed, sort);
        Span<double> tfs = stackalloc double[SearchScoringProfile.FieldCount];
        Span<int> docLens = stackalloc int[SearchScoringProfile.FieldCount];
        var workUsed = 0;

        for (var b = 0; b < term.BlockCount; b++)
        {
            ct.ThrowIfCancellationRequested();
            var blk = _blocks[term.BlockStart + b];

            // Safe block-level pruning — exact df is already known in O(1)!
            if (sort == ArticleSearchSort.Latest)
            {
                if (hasCursor && blk.MinPublishedTicks > cursorPubTicks)
                {
                    stats.BlocksSkipped++;
                    continue;
                }
                if (heap.IsFull && blk.MaxPublishedTicks < heap.Worst.Article.PublishedAt.UtcTicks)
                {
                    stats.BlocksSkipped++;
                    continue;
                }
            }
            else if (heap.IsFull)
            {
                var allowExact = differsExact ? hasExactCursor : blk.HasAnyExact != 0;
                var upper = blk.UpperBoundBm25F(idf, allowExact, _avgFieldLengths);
                if (upper < heap.Worst.Score)
                {
                    stats.BlocksSkipped++;
                    continue;
                }
            }

            stats.BlocksVisited++;
            var bStart = term.Start + b * PostingBlockSize;
            var bEnd = Math.Min(term.Start + term.Count, bStart + PostingBlockSize);
            for (var i = bStart; i < bEnd; i++)
            {
                if (++workUsed > workBudget) throw new SearchBudgetExceededException();
                stats.PostingsDecoded++;
                var p = _postings[i];
                var doc = _documents[p.Ordinal];

                if (sort == ArticleSearchSort.Latest)
                {
                    var pubTicks = doc.Article.PublishedAt.UtcTicks;
                    if (hasCursor && pubTicks > cursorPubTicks) continue;
                    if (heap.IsFull && pubTicks < heap.Worst.Article.PublishedAt.UtcTicks) continue;
                }

                stats.CandidatesScored++;
                tfs[0] = p.Tf0 * 0.5;
                tfs[1] = p.Tf1 * 0.5;
                tfs[2] = p.Tf2 * 0.5;
                tfs[3] = p.Tf3 * 0.5;
                tfs[4] = p.Tf4 * 0.5;
                doc.CopyLengths(docLens);

                var score = SearchScoringProfile.ScoreConceptBm25F(idf, tfs, docLens, _avgFieldLengths);
                var exactHit = false;
                if (differsExact)
                {
                    if (hasExactCursor)
                    {
                        var exDoc = exactCursor.AdvanceTo(p.Ordinal, ref stats);
                        exactHit = exDoc == p.Ordinal && (exactCursor.Current.ExactFlags & ExactFlagBit) != 0;
                    }
                }
                else
                {
                    exactHit = (p.ExactFlags & ExactFlagBit) != 0;
                }
                if (exactHit)
                    score += SearchScoringProfile.ExactFormBonusFactor * idf;

                var hit = new ArticleSearchHit(doc.Article, SearchMatchTier.Primary, score);
                if (hasCursor && SearchScoringProfile.CompareHitToCursor(hit, afterCursor!.Value, sort) <= 0)
                    continue;
                heap.TryPush(hit);
            }
        }

        return new(heap.DrainSorted(), df, [], 0, false);
    }

    private ArticleSearchHit[] ExecutePrimaryConjunction(
        SearchQueryPlan plan,
        ResolvedConcept[] resolved,
        Term[][] quotedPhraseTerms,
        Term[] orderedSeqTerms,
        double totalQueryIdf,
        double maxPrimaryPhraseBonus,
        bool allowsRelaxation,
        ArticleSearchSort sort,
        int primaryNeed,
        SearchCursorPosition? afterCursor,
        int workBudget,
        bool requireExactCount,
        CancellationToken ct,
        ref int workUsed,
        ref bool prunedCounting,
        ref SearchExecutionStats stats,
        out int primaryObserved)
    {
        primaryObserved = 0;

        // Build one ConceptStream per concept (for bounds & driving)
        var conceptStreams = new ConceptStream[resolved.Length];
        for (var c = 0; c < resolved.Length; c++)
            conceptStreams[c] = ConceptStream.Create(
                resolved[c], _postings, _blocks, _shortPrefixPostings, _shortPrefixBlocks, _avgFieldLengths);

        // Build required single-term cursors (for all Term/CjkSequence/QuotedPhrase steps) so leapfrog skips maximally
        var requiredTerms = new List<Term>(resolved.Length + quotedPhraseTerms.Length * 2);
        var seenTermStarts = new HashSet<int>();
        void AddRequired(Term t)
        {
            if (t.Count > 0 && seenTermStarts.Add(t.Start))
                requiredTerms.Add(t);
        }

        foreach (var qp in quotedPhraseTerms)
            foreach (var t in qp) AddRequired(t);
        foreach (var rc in resolved)
        {
            if (rc.Concept.Kind == SearchConceptKind.Term && rc.Concept.ShortAsciiPrefix is null)
                AddRequired(rc.PrimaryTerm);
            else if (rc.Concept.Kind == SearchConceptKind.CjkSequence && rc.StepTerms is not null)
                foreach (var t in rc.StepTerms) AddRequired(t);
        }

        // Order concept streams by EstimatedCount ascending to pick the rarest overall driver
        var streamOrder = new int[conceptStreams.Length];
        for (var i = 0; i < streamOrder.Length; i++) streamOrder[i] = i;
        Array.Sort(streamOrder, (a, b) => conceptStreams[a].EstimatedCount.CompareTo(conceptStreams[b].EstimatedCount));

        requiredTerms.Sort(static (a, b) => a.Count.CompareTo(b.Count));
        var reqCursors = new CompactTermCursor[requiredTerms.Count];
        for (var i = 0; i < requiredTerms.Count; i++)
            reqCursors[i] = new CompactTermCursor(_postings, _blocks, requiredTerms[i]);

        // Determine driver size to select SelectiveExact vs BlockMaxConjunction / LatestBlockScan
        var minDriverCount = int.MaxValue;
        if (reqCursors.Length > 0 && reqCursors[0].Count < minDriverCount) minDriverCount = reqCursors[0].Count;
        if (conceptStreams.Length > 0 && conceptStreams[streamOrder[0]].EstimatedCount < minDriverCount)
            minDriverCount = conceptStreams[streamOrder[0]].EstimatedCount;

        var isSelective = minDriverCount <= SelectiveExactThreshold;
        stats.Path = isSelective
            ? SearchExecutionPath.SelectiveExact
            : (sort == ArticleSearchSort.Latest ? SearchExecutionPath.LatestBlockScan : SearchExecutionPath.BlockMaxConjunction);

        // Union concept streams (ShortAsciiPrefix or CompoundHyphen) that must also intersect in Primary conjunction
        var unionIndices = new List<int>(2);
        for (var i = 0; i < streamOrder.Length; i++)
        {
            var idx = streamOrder[i];
            var kind = resolved[idx].Concept.Kind;
            if (kind == SearchConceptKind.CompoundHyphen || resolved[idx].Concept.ShortAsciiPrefix is not null)
                unionIndices.Add(idx);
        }

        using var heap = new SearchTopKHeap(primaryNeed, sort);
        Span<double> tfs = stackalloc double[SearchScoringProfile.FieldCount];
        Span<int> docLens = stackalloc int[SearchScoringProfile.FieldCount];

        var hasCursor = afterCursor is { Tier: SearchMatchTier.Primary };
        var cursorVal = hasCursor ? afterCursor!.Value : default;
        var cursorScore = hasCursor ? BitConverter.Int64BitsToDouble(cursorVal.ScoreBits) : 0.0;
        var hasPhraseOrProx = plan.QuotedPhrases.Length > 0 || plan.OrderedQuerySequence.Length >= 2;
        var hasQuoted = plan.QuotedPhrases.Length > 0;
        var hasCjkSeq = false;
        foreach (var rc in resolved)
            if (rc.Concept.Kind == SearchConceptKind.CjkSequence) { hasCjkSeq = true; break; }

        // Helper to advance the primary driver (rarest required term if present, else rarest union stream)
        var useReqDriver = reqCursors.Length > 0 &&
                           (unionIndices.Count == 0 || reqCursors[0].Count <= conceptStreams[unionIndices[0]].EstimatedCount);

        var candidate = useReqDriver ? reqCursors[0].Doc : conceptStreams[unionIndices[0]].Doc;

        while (candidate < int.MaxValue)
        {
            ct.ThrowIfCancellationRequested();

            // Block-level pruning once heap is full AND (not relaxable OR already observed >= 5 primary hits)
            var canPruneBlocks = !requireExactCount &&
                                 !isSelective &&
                                 heap.IsFull &&
                                 (!allowsRelaxation || primaryObserved >= SearchScoringProfile.RelaxationTriggerPrimaryCount);

            if (canPruneBlocks)
            {
                if (sort == ArticleSearchSort.Latest)
                {
                    var skipUntil = -1;
                    var worstPub = heap.Worst.Article.PublishedAt.UtcTicks;
                    for (var r = 0; r < reqCursors.Length; r++)
                    {
                        if (!reqCursors[r].TryShallowBlock(candidate, out var blk))
                        {
                            candidate = int.MaxValue;
                            break;
                        }
                        if ((hasCursor && blk.MinPublishedTicks > cursorVal.PublishedAtTicks) ||
                            blk.MaxPublishedTicks < worstPub)
                        {
                            if (blk.MaxOrdinal > skipUntil) skipUntil = blk.MaxOrdinal;
                        }
                    }
                    if (candidate == int.MaxValue) break;
                    if (skipUntil >= candidate)
                    {
                        prunedCounting = true;
                        stats.BlocksSkipped++;
                        var next = skipUntil == int.MaxValue ? int.MaxValue : skipUntil + 1;
                        candidate = useReqDriver
                            ? reqCursors[0].AdvanceTo(next, ref stats)
                            : conceptStreams[unionIndices[0]].AdvanceTo(next, ref stats);
                        continue;
                    }
                }
                else
                {
                    // Relevance Block-Max conjunction bound across ALL concepts + maxPrimaryPhraseBonus
                    var blockSum = maxPrimaryPhraseBonus;
                    var minBlockEnd = int.MaxValue;
                    var anyExhausted = false;
                    for (var c = 0; c < conceptStreams.Length; c++)
                    {
                        var bScore = conceptStreams[c].ShallowBlockBound(candidate, _avgFieldLengths, out var bEnd, out _, out _);
                        if (bEnd == int.MaxValue && bScore == 0.0) { anyExhausted = true; break; }
                        blockSum += bScore;
                        if (bEnd < minBlockEnd) minBlockEnd = bEnd;
                    }
                    if (anyExhausted) break;
                    if (blockSum < heap.Worst.Score)
                    {
                        prunedCounting = true;
                        stats.BlocksSkipped++;
                        var next = minBlockEnd == int.MaxValue ? int.MaxValue : minBlockEnd + 1;
                        if (next <= candidate) next = candidate + 1;
                        candidate = useReqDriver
                            ? reqCursors[0].AdvanceTo(next, ref stats)
                            : conceptStreams[unionIndices[0]].AdvanceTo(next, ref stats);
                        continue;
                    }
                }
            }

            // Leapfrog alignment across all required term cursors and union concept streams
            var aligned = true;
            for (var r = useReqDriver ? 1 : 0; r < reqCursors.Length; r++)
            {
                var d = reqCursors[r].AdvanceTo(candidate, ref stats);
                if (d != candidate)
                {
                    candidate = d;
                    if (candidate < int.MaxValue)
                        candidate = useReqDriver
                            ? reqCursors[0].AdvanceTo(candidate, ref stats)
                            : conceptStreams[unionIndices[0]].AdvanceTo(candidate, ref stats);
                    aligned = false;
                    break;
                }
            }
            if (!aligned) continue;

            for (var u = useReqDriver ? 0 : 1; u < unionIndices.Count; u++)
            {
                var d = conceptStreams[unionIndices[u]].AdvanceTo(candidate, ref stats);
                if (d != candidate)
                {
                    candidate = d;
                    if (candidate < int.MaxValue)
                        candidate = useReqDriver
                            ? reqCursors[0].AdvanceTo(candidate, ref stats)
                            : conceptStreams[unionIndices[0]].AdvanceTo(candidate, ref stats);
                    aligned = false;
                    break;
                }
            }
            if (!aligned) continue;

            var ord = candidate;
            if (++workUsed > workBudget) throw new SearchBudgetExceededException();

            var doc = _documents[ord];
            doc.CopyLengths(docLens);

            // Fast non-positional evaluation first: verify CompoundHyphen sub-terms & compute exact BM25F + exact-form score
            // BEFORE touching _positions for QuotedPhrases or CjkSequence!
            var baseScore = 0.0;
            var allNonPosOk = true;
            for (var c = 0; c < resolved.Length; c++)
            {
                var rc = resolved[c];
                tfs.Clear();
                var ok = EvaluateConceptNonPositional(ord, rc, tfs, out var exactFormHit, out var usedShortPrefixOnly, ref stats);
                if (!ok) { allNonPosOk = false; break; }
                var activeIdf = usedShortPrefixOnly ? rc.ShortPrefixIdf : rc.Idf;
                baseScore += SearchScoringProfile.ScoreConceptBm25F(activeIdf, tfs, docLens, _avgFieldLengths);
                if (exactFormHit)
                    baseScore += SearchScoringProfile.ExactFormBonusFactor * activeIdf;
            }
            if (!allNonPosOk)
            {
                candidate = AdvancePrimaryDriverPast(ord, useReqDriver, reqCursors, conceptStreams, unionIndices, ref stats);
                continue;
            }

            // If we have positional eligibility constraints (QuotedPhrases or CjkSequence) AND pruning is allowed,
            // skip reading positions when the document cannot possibly enter Top-K!
            if ((hasQuoted || hasCjkSeq) && canPruneBlocks)
            {
                var docPubTicks = doc.Article.PublishedAt.UtcTicks;
                var cannotEnter = sort == ArticleSearchSort.Latest
                    ? (hasCursor && docPubTicks > cursorVal.PublishedAtTicks) ||
                      docPubTicks < heap.Worst.Article.PublishedAt.UtcTicks ||
                      (docPubTicks == heap.Worst.Article.PublishedAt.UtcTicks && baseScore + maxPrimaryPhraseBonus < heap.Worst.Score)
                    : baseScore + maxPrimaryPhraseBonus < heap.Worst.Score;
                if (cannotEnter)
                {
                    prunedCounting = true;
                    stats.PositionSkipsByBound++;
                    candidate = AdvancePrimaryDriverPast(ord, useReqDriver, reqCursors, conceptStreams, unionIndices, ref stats);
                    continue;
                }
            }

            // Verify strict QuotedPhrases & CjkSequence positional eligibility
            var posEligOk = true;
            for (var p = 0; p < plan.QuotedPhrases.Length; p++)
            {
                if (!MatchesExactSequenceByTerms(ord, plan.QuotedPhrases[p].Steps, quotedPhraseTerms[p], out _, ref stats))
                {
                    posEligOk = false;
                    break;
                }
            }
            if (posEligOk && hasCjkSeq)
            {
                for (var c = 0; c < resolved.Length; c++)
                {
                    if (resolved[c].Concept.Kind == SearchConceptKind.CjkSequence &&
                        !MatchesExactSequenceByTerms(ord, resolved[c].Concept.Steps, resolved[c].StepTerms!, out _, ref stats))
                    {
                        posEligOk = false;
                        break;
                    }
                }
            }
            if (!posEligOk)
            {
                candidate = AdvancePrimaryDriverPast(ord, useReqDriver, reqCursors, conceptStreams, unionIndices, ref stats);
                continue;
            }

            // Confirmed Primary match! Always counted truthfully before lazy phrase-bonus check.
            primaryObserved++;
            stats.CandidatesScored++;

            if (primaryNeed > 0)
            {
                var docPubTicks = doc.Article.PublishedAt.UtcTicks;
                // Exact lazy position skip for phrase/proximity bonus (works even when requireExactCount == true!)
                var skipForHeapOrCursor = false;
                if (hasCursor)
                {
                    if (sort == ArticleSearchSort.Latest && docPubTicks > cursorVal.PublishedAtTicks)
                        skipForHeapOrCursor = true;
                    else if (sort == ArticleSearchSort.Relevance && baseScore > cursorScore)
                        skipForHeapOrCursor = true;
                }
                if (!skipForHeapOrCursor && heap.IsFull)
                {
                    if (sort == ArticleSearchSort.Latest)
                    {
                        var worstPub = heap.Worst.Article.PublishedAt.UtcTicks;
                        if (docPubTicks < worstPub ||
                            (docPubTicks == worstPub && baseScore + maxPrimaryPhraseBonus < heap.Worst.Score))
                            skipForHeapOrCursor = true;
                    }
                    else if (baseScore + maxPrimaryPhraseBonus < heap.Worst.Score)
                    {
                        skipForHeapOrCursor = true;
                    }
                }

                if (skipForHeapOrCursor)
                {
                    if (hasPhraseOrProx) stats.PositionSkipsByBound++;
                }
                else
                {
                    var score = baseScore;
                    if (hasPhraseOrProx)
                    {
                        var seqSteps = hasQuoted ? plan.QuotedPhrases[0].Steps : plan.OrderedQuerySequence;
                        var seqTerms = hasQuoted ? quotedPhraseTerms[0] : orderedSeqTerms;
                        if (MatchesExactSequenceByTerms(ord, seqSteps, seqTerms, out var matchField, ref stats))
                        {
                            var factor = matchField is SearchScoreField.Title or SearchScoreField.Heading
                                ? SearchScoringProfile.TitleOrHeadingPhraseBonusFactor
                                : SearchScoringProfile.BodyPhraseBonusFactor;
                            score += factor * totalQueryIdf;
                        }
                        else if (resolved.Length >= 2 &&
                                 MatchesTightProximityByTerms(ord, orderedSeqTerms, 2 * resolved.Length + 4, ref stats))
                        {
                            score += SearchScoringProfile.TightProximityBonusFactor * totalQueryIdf;
                        }
                    }

                    var hit = new ArticleSearchHit(doc.Article, SearchMatchTier.Primary, score);
                    if (!hasCursor || SearchScoringProfile.CompareHitToCursor(hit, cursorVal, sort) > 0)
                        heap.TryPush(hit);
                }
            }

            candidate = AdvancePrimaryDriverPast(ord, useReqDriver, reqCursors, conceptStreams, unionIndices, ref stats);
        }

        return heap.DrainSorted();

        static int AdvancePrimaryDriverPast(
            int ord,
            bool useReq,
            CompactTermCursor[] reqs,
            ConceptStream[] streams,
            List<int> unions,
            ref SearchExecutionStats s)
        {
            var next = ord + 1;
            return useReq
                ? reqs[0].AdvanceTo(next, ref s)
                : streams[unions[0]].AdvanceTo(next, ref s);
        }
    }

    private ArticleSearchHit[] ExecuteRelaxedDisjunction(
        SearchQueryPlan plan,
        ResolvedConcept[] resolved,
        Term[][] quotedPhraseTerms,
        double totalQueryIdf,
        int minRelaxed,
        double minRelaxedRatio,
        ArticleSearchSort sort,
        int relaxedNeed,
        SearchCursorPosition? afterCursor,
        int workBudget,
        bool requireExactCount,
        CancellationToken ct,
        ref int workUsed,
        ref bool prunedCounting,
        ref SearchExecutionStats stats,
        out int relaxedObserved)
    {
        relaxedObserved = 0;

        // Check whether mandatory constraints (QuotedPhrases or StrictIdentifiers) exist
        var mandatoryTerms = new List<Term>();
        var seenStarts = new HashSet<int>();
        foreach (var qp in quotedPhraseTerms)
            foreach (var t in qp)
                if (t.Count > 0 && seenStarts.Add(t.Start)) mandatoryTerms.Add(t);
        foreach (var rc in resolved)
            if (rc.Concept.IsStrictIdentifier && rc.PrimaryTerm.Count > 0 && seenStarts.Add(rc.PrimaryTerm.Start))
                mandatoryTerms.Add(rc.PrimaryTerm);

        if (mandatoryTerms.Count > 0)
        {
            return ExecuteRelaxedWithMandatoryDrivers(
                plan, resolved, quotedPhraseTerms, mandatoryTerms,
                totalQueryIdf, minRelaxed, minRelaxedRatio,
                sort, relaxedNeed, afterCursor, workBudget, requireExactCount,
                ct, ref workUsed, ref prunedCounting, ref stats, out relaxedObserved);
        }

        // Pure disjunction (no quoted phrases, no strict identifiers) => maxRelaxedPhraseBonus is identically 0.0!
        var activeStreams = new List<ConceptStream>(resolved.Length);
        var activeConceptIndices = new List<int>(resolved.Length);
        var totalEstimatedPostings = 0L;
        for (var c = 0; c < resolved.Length; c++)
        {
            if (!resolved[c].CanMatch) continue;
            var cs = ConceptStream.Create(
                resolved[c], _postings, _blocks, _shortPrefixPostings, _shortPrefixBlocks, _avgFieldLengths);
            if (cs.Doc == int.MaxValue) continue;
            totalEstimatedPostings += cs.EstimatedCount;
            activeStreams.Add(cs);
            activeConceptIndices.Add(c);
        }

        if (activeStreams.Count < minRelaxed)
            return [];

        if (!requireExactCount && relaxedNeed == 0 && totalEstimatedPostings > SelectiveExactThreshold)
        {
            prunedCounting = true;
            return [];
        }

        var streams = activeStreams.ToArray();
        var streamCount = streams.Length;
        var isSelective = totalEstimatedPostings <= SelectiveExactThreshold;
        stats.Path = isSelective
            ? SearchExecutionPath.SelectiveExact
            : (sort == ArticleSearchSort.Latest ? SearchExecutionPath.LatestBlockScan : SearchExecutionPath.BlockMaxWand);

        var order = new int[streamCount];
        for (var i = 0; i < streamCount; i++) order[i] = i;
        var liveCount = streamCount;

        var idfThreshold = minRelaxedRatio * totalQueryIdf - 1e-12;
        var hasCursor = afterCursor is { Tier: SearchMatchTier.Relaxed };
        var cursorVal = hasCursor ? afterCursor!.Value : default;

        using var heap = new SearchTopKHeap(relaxedNeed, sort);
        Span<double> tfs = stackalloc double[SearchScoringProfile.FieldCount];
        Span<int> docLens = stackalloc int[SearchScoringProfile.FieldCount];

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            // Insertion sort active streams by current Doc ascending (tiny m <= 16)
            for (var i = 1; i < liveCount; i++)
            {
                var key = order[i];
                var keyDoc = streams[key].Doc;
                var j = i - 1;
                while (j >= 0 && streams[order[j]].Doc > keyDoc)
                {
                    order[j + 1] = order[j];
                    j--;
                }
                order[j + 1] = key;
            }
            while (liveCount > 0 && streams[order[liveCount - 1]].Doc == int.MaxValue)
                liveCount--;
            if (liveCount < minRelaxed) break;

            var canPrune = !isSelective &&
                           heap.IsFull &&
                           (!requireExactCount || relaxedObserved >= SearchScoringProfile.MaxRelaxedResults);

            // Step 1: Select pivot pFirst satisfying eligibility (minRelaxed, minRelaxedRatio) AND score threshold (BMW)
            var pFirst = -1;
            var idfSum = 0.0;
            var boundSum = 0.0;
            var eligMetBeforeP = false;
            var threshold = canPrune && sort == ArticleSearchSort.Relevance ? heap.Worst.Score : -1.0;

            for (var i = 0; i < liveCount; i++)
            {
                var sIdx = order[i];
                idfSum += streams[sIdx].Resolved.Idf;
                boundSum += streams[sIdx].GlobalMaxBound;
                var eligOk = (i + 1) >= minRelaxed && idfSum >= idfThreshold;
                if (eligOk)
                {
                    if (!canPrune || sort != ArticleSearchSort.Relevance || boundSum >= threshold)
                    {
                        pFirst = i;
                        break;
                    }
                    eligMetBeforeP = true;
                }
            }

            if (pFirst < 0)
            {
                // No remaining combination of live streams can satisfy eligibility and beat threshold
                if (eligMetBeforeP && relaxedObserved < SearchScoringProfile.MaxRelaxedResults)
                {
                    prunedCounting = true;
                    stats.BlocksSkipped++;
                }
                break;
            }

            var pivotDoc = streams[order[pFirst]].Doc;
            var p = pFirst;
            while (p + 1 < liveCount && streams[order[p + 1]].Doc == pivotDoc)
                p++;

            // Step 2: Block-Max / Latest Block Upper Bound check at pivotDoc
            if (canPrune)
            {
                if (sort == ArticleSearchSort.Relevance)
                {
                    var blockScoreSum = 0.0;
                    var minBlockEnd = int.MaxValue;
                    for (var i = 0; i <= p; i++)
                    {
                        var bScore = streams[order[i]].ShallowBlockBound(pivotDoc, _avgFieldLengths, out var bEnd, out _, out _);
                        blockScoreSum += bScore;
                        if (bEnd < minBlockEnd) minBlockEnd = bEnd;
                    }
                    if (blockScoreSum < threshold)
                    {
                        var nextTarget = minBlockEnd == int.MaxValue ? int.MaxValue : minBlockEnd + 1;
                        if (p + 1 < liveCount)
                        {
                            var nextStreamDoc = streams[order[p + 1]].Doc;
                            if (nextStreamDoc < nextTarget) nextTarget = nextStreamDoc;
                        }
                        if (nextTarget <= pivotDoc) nextTarget = pivotDoc + 1;

                        for (var i = 0; i <= p; i++)
                            if (streams[order[i]].Doc < nextTarget)
                                streams[order[i]].AdvanceTo(nextTarget, ref stats);

                        if (relaxedObserved < SearchScoringProfile.MaxRelaxedResults)
                            prunedCounting = true;
                        stats.BlocksSkipped++;
                        continue;
                    }
                }
                else
                {
                    // Latest sort: every doc in [pivotDoc, nextTarget-1] can only come from streams[0..p]
                    var worstPub = heap.Worst.Article.PublishedAt.UtcTicks;
                    var maxPub = long.MinValue;
                    var minPub = long.MaxValue;
                    var minBlockEnd = int.MaxValue;
                    for (var i = 0; i <= p; i++)
                    {
                        streams[order[i]].ShallowBlockBound(pivotDoc, _avgFieldLengths, out var bEnd, out var bMin, out var bMax);
                        if (bEnd < minBlockEnd) minBlockEnd = bEnd;
                        if (bMin < minPub) minPub = bMin;
                        if (bMax > maxPub) maxPub = bMax;
                    }
                    if (maxPub < worstPub || (hasCursor && minPub > cursorVal.PublishedAtTicks))
                    {
                        var nextTarget = minBlockEnd == int.MaxValue ? int.MaxValue : minBlockEnd + 1;
                        if (p + 1 < liveCount)
                        {
                            var nextStreamDoc = streams[order[p + 1]].Doc;
                            if (nextStreamDoc < nextTarget) nextTarget = nextStreamDoc;
                        }
                        if (nextTarget <= pivotDoc) nextTarget = pivotDoc + 1;

                        for (var i = 0; i <= p; i++)
                            if (streams[order[i]].Doc < nextTarget)
                                streams[order[i]].AdvanceTo(nextTarget, ref stats);

                        if (relaxedObserved < SearchScoringProfile.MaxRelaxedResults)
                            prunedCounting = true;
                        stats.BlocksSkipped++;
                        continue;
                    }
                }
            }

            // Step 3: Align streams[0 .. pFirst - 1] to pivotDoc (proven: no doc < pivotDoc can be valid & competitive)
            if (streams[order[0]].Doc < pivotDoc)
            {
                if (eligMetBeforeP && relaxedObserved < SearchScoringProfile.MaxRelaxedResults)
                    prunedCounting = true;
                for (var i = 0; i < pFirst; i++)
                    if (streams[order[i]].Doc < pivotDoc)
                        streams[order[i]].AdvanceTo(pivotDoc, ref stats);
                continue;
            }

            // Step 4: All streams[0 .. p] are at pivotDoc; evaluate candidate
            if (++workUsed > workBudget) throw new SearchBudgetExceededException();

            var doc = _documents[pivotDoc];
            var docPubTicks = doc.Article.PublishedAt.UtcTicks;

            // Fast Latest pre-check when exact relaxed count is already saturated or pruning is enabled
            var skipLatestScore = canPrune && sort == ArticleSearchSort.Latest &&
                                  ((hasCursor && docPubTicks > cursorVal.PublishedAtTicks) ||
                                   docPubTicks < heap.Worst.Article.PublishedAt.UtcTicks);

            if (!skipLatestScore)
            {
                doc.CopyLengths(docLens);
                var matchedCount = 0;
                var matchedIdfSum = 0.0;
                var score = 0.0;

                // Evaluate non-positional concepts first, then CjkSequence concepts
                for (var i = 0; i <= p; i++)
                {
                    var rc = streams[order[i]].Resolved;
                    if (rc.Concept.Kind == SearchConceptKind.CjkSequence) continue;
                    tfs.Clear();
                    if (!EvaluateConceptNonPositional(pivotDoc, rc, tfs, out var exactHit, out var spOnly, ref stats))
                        continue;
                    matchedCount++;
                    matchedIdfSum += rc.Idf;
                    var activeIdf = spOnly ? rc.ShortPrefixIdf : rc.Idf;
                    score += SearchScoringProfile.ScoreConceptBm25F(activeIdf, tfs, docLens, _avgFieldLengths);
                    if (exactHit) score += SearchScoringProfile.ExactFormBonusFactor * activeIdf;
                }

                // Evaluate CjkSequence concepts at pivotDoc (only if still possible to qualify)
                for (var i = 0; i <= p; i++)
                {
                    var rc = streams[order[i]].Resolved;
                    if (rc.Concept.Kind != SearchConceptKind.CjkSequence) continue;
                    tfs.Clear();
                    if (!EvaluateConceptNonPositional(pivotDoc, rc, tfs, out var exactHit, out _, ref stats))
                        continue;
                    if (!MatchesExactSequenceByTerms(pivotDoc, rc.Concept.Steps, rc.StepTerms!, out _, ref stats))
                        continue;
                    matchedCount++;
                    matchedIdfSum += rc.Idf;
                    score += SearchScoringProfile.ScoreConceptBm25F(rc.Idf, tfs, docLens, _avgFieldLengths);
                    if (exactHit) score += SearchScoringProfile.ExactFormBonusFactor * rc.Idf;
                }

                // Strictly < resolved.Length (full coverage was handled in Primary pass)
                if (matchedCount > 0 &&
                    matchedCount < resolved.Length &&
                    matchedCount >= minRelaxed &&
                    totalQueryIdf > 0.0 &&
                    (matchedIdfSum / totalQueryIdf) >= minRelaxedRatio)
                {
                    relaxedObserved++;
                    stats.CandidatesScored++;
                    if (relaxedNeed > 0)
                    {
                        var hit = new ArticleSearchHit(doc.Article, SearchMatchTier.Relaxed, score);
                        if (!hasCursor || SearchScoringProfile.CompareHitToCursor(hit, cursorVal, sort) > 0)
                            heap.TryPush(hit);
                    }
                }
            }
            else if (relaxedObserved < SearchScoringProfile.MaxRelaxedResults)
            {
                prunedCounting = true;
            }

            // Advance all streams at pivotDoc past pivotDoc
            var nextDoc = pivotDoc + 1;
            for (var i = 0; i <= p; i++)
                streams[order[i]].AdvanceTo(nextDoc, ref stats);
        }

        return heap.DrainSorted();
    }

    private ArticleSearchHit[] ExecuteRelaxedWithMandatoryDrivers(
        SearchQueryPlan plan,
        ResolvedConcept[] resolved,
        Term[][] quotedPhraseTerms,
        List<Term> mandatoryTerms,
        double totalQueryIdf,
        int minRelaxed,
        double minRelaxedRatio,
        ArticleSearchSort sort,
        int relaxedNeed,
        SearchCursorPosition? afterCursor,
        int workBudget,
        bool requireExactCount,
        CancellationToken ct,
        ref int workUsed,
        ref bool prunedCounting,
        ref SearchExecutionStats stats,
        out int relaxedObserved)
    {
        relaxedObserved = 0;
        mandatoryTerms.Sort(static (a, b) => a.Count.CompareTo(b.Count));
        var drivers = new CompactTermCursor[mandatoryTerms.Count];
        for (var i = 0; i < mandatoryTerms.Count; i++)
            drivers[i] = new CompactTermCursor(_postings, _blocks, mandatoryTerms[i]);

        var isSelective = drivers[0].Count <= SelectiveExactThreshold;
        if (!isSelective && stats.Path == SearchExecutionPath.SelectiveExact)
            stats.Path = sort == ArticleSearchSort.Latest ? SearchExecutionPath.LatestBlockScan : SearchExecutionPath.BlockMaxConjunction;

        var hasCursor = afterCursor is { Tier: SearchMatchTier.Relaxed };
        var cursorVal = hasCursor ? afterCursor!.Value : default;
        var hasQuoted = plan.QuotedPhrases.Length > 0;
        var maxRelaxedPhraseBonus = hasQuoted
            ? SearchScoringProfile.TitleOrHeadingPhraseBonusFactor * totalQueryIdf * (1.0 + 1e-11) + 1e-11
            : 0.0;

        using var heap = new SearchTopKHeap(relaxedNeed, sort);
        Span<double> tfs = stackalloc double[SearchScoringProfile.FieldCount];
        Span<int> docLens = stackalloc int[SearchScoringProfile.FieldCount];

        var candidate = drivers[0].Doc;
        while (candidate < int.MaxValue)
        {
            ct.ThrowIfCancellationRequested();

            var canPrune = !isSelective &&
                           heap.IsFull &&
                           (!requireExactCount || relaxedObserved >= SearchScoringProfile.MaxRelaxedResults);

            if (canPrune && sort == ArticleSearchSort.Latest)
            {
                var worstPub = heap.Worst.Article.PublishedAt.UtcTicks;
                var skipUntil = -1;
                for (var r = 0; r < drivers.Length; r++)
                {
                    if (!drivers[r].TryShallowBlock(candidate, out var blk)) { candidate = int.MaxValue; break; }
                    if ((hasCursor && blk.MinPublishedTicks > cursorVal.PublishedAtTicks) || blk.MaxPublishedTicks < worstPub)
                        if (blk.MaxOrdinal > skipUntil) skipUntil = blk.MaxOrdinal;
                }
                if (candidate == int.MaxValue) break;
                if (skipUntil >= candidate)
                {
                    if (relaxedObserved < SearchScoringProfile.MaxRelaxedResults) prunedCounting = true;
                    stats.BlocksSkipped++;
                    candidate = drivers[0].AdvanceTo(skipUntil == int.MaxValue ? int.MaxValue : skipUntil + 1, ref stats);
                    continue;
                }
            }

            var aligned = true;
            for (var r = 1; r < drivers.Length; r++)
            {
                var d = drivers[r].AdvanceTo(candidate, ref stats);
                if (d != candidate)
                {
                    candidate = d < int.MaxValue ? drivers[0].AdvanceTo(d, ref stats) : int.MaxValue;
                    aligned = false;
                    break;
                }
            }
            if (!aligned) continue;

            var ord = candidate;
            if (++workUsed > workBudget) throw new SearchBudgetExceededException();

            // Check non-positional concepts first before verifying quoted phrase positions
            var doc = _documents[ord];
            doc.CopyLengths(docLens);
            var matchedCount = 0;
            var matchedIdfSum = 0.0;
            var strictOk = true;
            var baseScore = 0.0;

            for (var c = 0; c < resolved.Length; c++)
            {
                var rc = resolved[c];
                if (!rc.CanMatch) { if (rc.Concept.IsStrictIdentifier) { strictOk = false; break; } continue; }
                tfs.Clear();
                if (!EvaluateConceptNonPositional(ord, rc, tfs, out var exactHit, out var spOnly, ref stats))
                {
                    if (rc.Concept.IsStrictIdentifier) { strictOk = false; break; }
                    continue;
                }
                if (rc.Concept.Kind == SearchConceptKind.CjkSequence &&
                    !MatchesExactSequenceByTerms(ord, rc.Concept.Steps, rc.StepTerms!, out _, ref stats))
                    continue;
                matchedCount++;
                matchedIdfSum += rc.Idf;
                var activeIdf = spOnly ? rc.ShortPrefixIdf : rc.Idf;
                baseScore += SearchScoringProfile.ScoreConceptBm25F(activeIdf, tfs, docLens, _avgFieldLengths);
                if (exactHit) baseScore += SearchScoringProfile.ExactFormBonusFactor * activeIdf;
            }

            if (strictOk &&
                matchedCount > 0 &&
                matchedCount < resolved.Length &&
                matchedCount >= minRelaxed &&
                totalQueryIdf > 0.0 &&
                (matchedIdfSum / totalQueryIdf) >= minRelaxedRatio)
            {
                // When pruning is enabled and candidate cannot possibly beat heap threshold, skip quoted phrase positions
                var skipByBound = false;
                if (canPrune && hasQuoted)
                {
                    var docPubTicks = doc.Article.PublishedAt.UtcTicks;
                    if (sort == ArticleSearchSort.Latest)
                    {
                        var worstPub = heap.Worst.Article.PublishedAt.UtcTicks;
                        skipByBound = (hasCursor && docPubTicks > cursorVal.PublishedAtTicks) ||
                                      docPubTicks < worstPub ||
                                      (docPubTicks == worstPub && baseScore + maxRelaxedPhraseBonus < heap.Worst.Score);
                    }
                    else
                    {
                        skipByBound = baseScore + maxRelaxedPhraseBonus < heap.Worst.Score;
                    }
                }
                if (skipByBound)
                {
                    if (relaxedObserved < SearchScoringProfile.MaxRelaxedResults) prunedCounting = true;
                    stats.PositionSkipsByBound++;
                }
                else
                {
                    var quotedOk = true;
                    var firstQuoteField = SearchScoreField.Body;
                    for (var p = 0; p < plan.QuotedPhrases.Length; p++)
                    {
                        if (!MatchesExactSequenceByTerms(ord, plan.QuotedPhrases[p].Steps, quotedPhraseTerms[p], out var mf, ref stats))
                        {
                            quotedOk = false;
                            break;
                        }
                        if (p == 0) firstQuoteField = mf;
                    }
                    if (quotedOk)
                    {
                        relaxedObserved++;
                        stats.CandidatesScored++;
                        if (relaxedNeed > 0)
                        {
                            var score = baseScore;
                            if (hasQuoted)
                            {
                                var factor = firstQuoteField is SearchScoreField.Title or SearchScoreField.Heading
                                    ? SearchScoringProfile.TitleOrHeadingPhraseBonusFactor
                                    : SearchScoringProfile.BodyPhraseBonusFactor;
                                score += factor * matchedIdfSum;
                            }
                            var hit = new ArticleSearchHit(doc.Article, SearchMatchTier.Relaxed, score);
                            if (!hasCursor || SearchScoringProfile.CompareHitToCursor(hit, cursorVal, sort) > 0)
                                heap.TryPush(hit);
                        }
                    }
                }
            }

            candidate = drivers[0].AdvanceTo(ord + 1, ref stats);
        }

        return heap.DrainSorted();
    }

    private bool EvaluateConceptNonPositional(
        int ordinal,
        ResolvedConcept rc,
        Span<double> tfs,
        out bool exactFormHit,
        out bool usedShortPrefixOnly,
        ref SearchExecutionStats stats)
    {
        exactFormHit = false;
        usedShortPrefixOnly = false;

        switch (rc.Concept.Kind)
        {
            case SearchConceptKind.CjkSequence:
            {
                var stepTerms = rc.StepTerms!;
                for (var f = 0; f < SearchScoringProfile.FieldCount; f++) tfs[f] = double.MaxValue;
                for (var s = 0; s < stepTerms.Length; s++)
                {
                    if (!TryFindPosting(stepTerms[s], ordinal, out var p)) return false;
                    stats.PostingsDecoded++;
                    if (p.Tf0 * 0.5 < tfs[0]) tfs[0] = p.Tf0 * 0.5;
                    if (p.Tf1 * 0.5 < tfs[1]) tfs[1] = p.Tf1 * 0.5;
                    if (p.Tf2 * 0.5 < tfs[2]) tfs[2] = p.Tf2 * 0.5;
                    if (p.Tf3 * 0.5 < tfs[3]) tfs[3] = p.Tf3 * 0.5;
                    if (p.Tf4 * 0.5 < tfs[4]) tfs[4] = p.Tf4 * 0.5;
                }
                for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                    if (tfs[f] == double.MaxValue) tfs[f] = 0.0;

                exactFormHit = rc.AllExactStepsExist;
                if (exactFormHit)
                {
                    var exactTerms = rc.ExactStepTerms!;
                    for (var s = 0; s < exactTerms.Length; s++)
                    {
                        if (!TryFindPosting(exactTerms[s], ordinal, out var ex) || (ex.ExactFlags & ExactFlagBit) == 0)
                        {
                            exactFormHit = false;
                            break;
                        }
                    }
                }
                return true;
            }
            case SearchConceptKind.CompoundHyphen:
            {
                Posting exactPosting = default;
                var hasExact = rc.PrimaryTerm.Count > 0 && TryFindPosting(rc.PrimaryTerm, ordinal, out exactPosting);
                if (hasExact) stats.PostingsDecoded++;

                var subTerms = rc.StepTerms!;
                var hasAllSub = rc.AllSubsExist && subTerms.Length > 0;
                Span<Posting> subPostings = subTerms.Length <= 8
                    ? stackalloc Posting[subTerms.Length]
                    : new Posting[subTerms.Length];
                if (hasAllSub)
                {
                    for (var i = 0; i < subTerms.Length; i++)
                    {
                        if (!TryFindPosting(subTerms[i], ordinal, out subPostings[i]))
                        {
                            hasAllSub = false;
                            break;
                        }
                        stats.PostingsDecoded++;
                    }
                }
                if (!hasExact && !hasAllSub) return false;

                for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
                {
                    var tf = hasExact ? exactPosting.FieldTf(f) : 0.0;
                    if (hasAllSub)
                    {
                        var minSub = double.MaxValue;
                        for (var i = 0; i < subTerms.Length; i++)
                        {
                            var stf = subPostings[i].FieldTf(f);
                            if (stf < minSub) minSub = stf;
                        }
                        if (minSub != double.MaxValue && minSub > tf) tf = minSub;
                    }
                    tfs[f] = tf;
                }
                exactFormHit = hasExact && (exactPosting.ExactFlags & ExactFlagBit) != 0;
                return true;
            }
            default:
            {
                var step = rc.Concept.Steps[0];
                if (rc.PrimaryTerm.Count > 0 && TryFindPosting(rc.PrimaryTerm, ordinal, out var posting))
                {
                    stats.PostingsDecoded++;
                    tfs[0] = posting.Tf0 * 0.5;
                    tfs[1] = posting.Tf1 * 0.5;
                    tfs[2] = posting.Tf2 * 0.5;
                    tfs[3] = posting.Tf3 * 0.5;
                    tfs[4] = posting.Tf4 * 0.5;
                    exactFormHit = step.DiffersFromExactForm
                        ? (rc.ExactTerm.Count > 0 && TryFindPosting(rc.ExactTerm, ordinal, out var ex) && (ex.ExactFlags & ExactFlagBit) != 0)
                        : (posting.ExactFlags & ExactFlagBit) != 0;
                    return true;
                }
                if (rc.ShortPrefixTerm.Count > 0 && TryFindShortPrefixPosting(rc.ShortPrefixTerm, ordinal, out var packed))
                {
                    stats.PostingsDecoded++;
                    UnpackShortPrefixTfs(packed, tfs);
                    usedShortPrefixOnly = true;
                    return true;
                }
                return false;
            }
        }
    }

    private bool MatchesExactSequenceByTerms(
        int ordinal,
        SearchConceptStep[] steps,
        Term[] terms,
        out SearchScoreField bestField,
        ref SearchExecutionStats stats)
    {
        bestField = SearchScoreField.Body;
        if (steps.Length == 0) return false;
        Span<Posting> postings = steps.Length <= 16 ? stackalloc Posting[steps.Length] : new Posting[steps.Length];
        for (var i = 0; i < steps.Length; i++)
        {
            if (terms[i].Count == 0 || !TryFindPosting(terms[i], ordinal, out postings[i]) || postings[i].PosCount == 0)
                return false;
        }
        var baseSpan = _positions.AsSpan(postings[0].PosStart, postings[0].PosCount);
        stats.PositionsRead += baseSpan.Length;
        var baseOffset = steps[0].RelativeOffset;
        var found = false;
        for (var i = 0; i < baseSpan.Length; i++)
        {
            var packed0 = baseSpan[i];
            var field = SearchScoringProfile.UnpackField(packed0);
            var pos0 = SearchScoringProfile.UnpackPosition(packed0);
            var allOk = true;
            for (var s = 1; s < steps.Length; s++)
            {
                var targetPos = pos0 + (steps[s].RelativeOffset - baseOffset);
                var spanS = _positions.AsSpan(postings[s].PosStart, postings[s].PosCount);
                stats.PositionsRead++;
                if (!ExhaustiveSearchOracle.ContainsFieldAndPos(spanS, field, targetPos))
                {
                    allOk = false;
                    break;
                }
            }
            if (allOk)
            {
                if (!found || (int)field < (int)bestField) bestField = field;
                found = true;
                if (bestField == SearchScoreField.Title) return true;
            }
        }
        return found;
    }

    private bool MatchesTightProximityByTerms(
        int ordinal,
        Term[] terms,
        int maxSpan,
        ref SearchExecutionStats stats)
    {
        if (terms.Length < 2) return false;
        Span<Posting> postings = terms.Length <= 16 ? stackalloc Posting[terms.Length] : new Posting[terms.Length];
        for (var i = 0; i < terms.Length; i++)
        {
            if (terms[i].Count == 0 || !TryFindPosting(terms[i], ordinal, out postings[i]) || postings[i].PosCount == 0)
                return false;
        }
        var baseSpan = _positions.AsSpan(postings[0].PosStart, postings[0].PosCount);
        stats.PositionsRead += baseSpan.Length;
        for (var f = 0; f < SearchScoringProfile.FieldCount; f++)
        {
            var field = (SearchScoreField)f;
            for (var i = 0; i < baseSpan.Length; i++)
            {
                if (SearchScoringProfile.UnpackField(baseSpan[i]) != field) continue;
                var anchor = SearchScoringProfile.UnpackPosition(baseSpan[i]);
                var minP = anchor;
                var maxP = anchor;
                var allNear = true;
                for (var s = 1; s < terms.Length; s++)
                {
                    var spanS = _positions.AsSpan(postings[s].PosStart, postings[s].PosCount);
                    stats.PositionsRead++;
                    if (!ExhaustiveSearchOracle.TryFindClosestInField(spanS, field, anchor, out var closest))
                    {
                        allNear = false;
                        break;
                    }
                    if (closest < minP) minP = closest;
                    if (closest > maxP) maxP = closest;
                    if (maxP - minP > maxSpan) { allNear = false; break; }
                }
                if (allNear) return true;
            }
        }
        return false;
    }

    private bool TryFindShortPrefixPosting(ShortPrefixTerm term, int ordinal, out int packed)
    {
        var lo = term.Start;
        var hi = term.Start + term.Count - 1;
        while (lo <= hi)
        {
            var mid = lo + ((hi - lo) >> 1);
            var ord = _shortPrefixPostings[mid].Ordinal;
            if (ord == ordinal) { packed = _shortPrefixPostings[mid].Packed; return true; }
            if (ord < ordinal) lo = mid + 1;
            else hi = mid - 1;
        }
        packed = 0;
        return false;
    }

    private static ShortPrefixTerm FindShortPrefixTerm(ShortPrefixTerm[] terms, ushort key)
    {
        var position = Array.BinarySearch(terms, new ShortPrefixTerm(key, 0, 0, 0, 0), ShortPrefixTerm.ByKey);
        return position >= 0 ? terms[position] : default;
    }

    private static ArticleSearchDetailedPage BuildDetailedPageFromOutcome(
        CompactSearchOutcome outcome,
        int start,
        int window)
    {
        var total = outcome.PrimaryCount + outcome.RelaxedCount;
        if (window == 0 || start >= total || start >= window)
            return new([], total, outcome.PrimaryCount, outcome.RelaxedCount);

        var combinedLen = outcome.PrimaryHits.Length + outcome.RelaxedHits.Length;
        var end = Math.Min(Math.Min(total, window), combinedLen);
        if (start >= end)
            return new([], total, outcome.PrimaryCount, outcome.RelaxedCount);

        var count = end - start;
        var slice = new ArticleSearchHit[count];
        for (var i = 0; i < count; i++)
        {
            var idx = start + i;
            slice[i] = idx < outcome.PrimaryHits.Length
                ? outcome.PrimaryHits[idx]
                : outcome.RelaxedHits[idx - outcome.PrimaryHits.Length];
        }
        return new(slice, total, outcome.PrimaryCount, outcome.RelaxedCount);
    }

    private static ArticleSearchCursorPage BuildCursorPageFromOutcome(
        CompactSearchOutcome outcome,
        int size,
        int returnedSoFar,
        int countThreshold)
    {
        var remainingWindow = Math.Max(0, MaxPaginatedResults - Math.Max(0, returnedSoFar));
        var pageTake = Math.Min(size, remainingWindow);

        var primaryHits = outcome.PrimaryHits;
        var relaxedHits = outcome.RelaxedHits;
        var available = primaryHits.Length + relaxedHits.Length;
        var take = Math.Min(pageTake, available);

        ArticleSearchHit[] selected;
        if (take == 0)
        {
            selected = [];
        }
        else
        {
            selected = new ArticleSearchHit[take];
            var pTake = Math.Min(take, primaryHits.Length);
            if (pTake > 0) Array.Copy(primaryHits, 0, selected, 0, pTake);
            var rTake = take - pTake;
            if (rTake > 0) Array.Copy(relaxedHits, 0, selected, pTake, rTake);
        }

        // HasMore is true strictly when a real (pageTake + 1)-th hit within the retrieval window exists
        var hasMore = take == pageTake &&
                      pageTake > 0 &&
                      available > pageTake &&
                      returnedSoFar + take < MaxPaginatedResults;

        var rawTotal = outcome.PrimaryCount + outcome.RelaxedCount;
        var threshold = Math.Max(Math.Max(1, countThreshold), selected.Length);
        PublicSearchTotalRelation totalRelation;
        int totalCount, primaryCount, relaxedCount;

        if (!outcome.PrunedCounting && rawTotal <= threshold)
        {
            totalRelation = PublicSearchTotalRelation.Exact;
            totalCount = rawTotal;
            primaryCount = outcome.PrimaryCount;
            relaxedCount = outcome.RelaxedCount;
        }
        else
        {
            totalRelation = PublicSearchTotalRelation.LowerBound;
            primaryCount = Math.Min(threshold, outcome.PrimaryCount);
            relaxedCount = Math.Min(Math.Max(0, threshold - primaryCount), outcome.RelaxedCount);
            totalCount = Math.Max(selected.Length, Math.Min(threshold, primaryCount + relaxedCount));
        }

        var lastPos = selected.Length > 0 ? SearchCursorPosition.From(selected[^1]) : (SearchCursorPosition?)null;
        return new(selected, totalCount, totalRelation, primaryCount, relaxedCount, hasMore, lastPos);
    }
}
