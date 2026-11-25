namespace FsusBlog.V2.Contracts;

/// <summary>Result admission tier under the versioned concept-aware matching contract (#46).</summary>
public enum SearchMatchTier : byte
{
    Primary = 0,
    Relaxed = 1
}

/// <summary>Logical searchable fields for globally consistent BM25F field-length normalization.</summary>
public enum SearchScoreField : byte
{
    Title = 0,
    Heading = 1,
    Summary = 2,
    Taxonomy = 3,
    Body = 4
}

/// <summary>Single ranked public search hit with its admission tier and deterministic score.</summary>
public readonly record struct ArticleSearchHit(Article Article, SearchMatchTier Tier, double Score);

/// <summary>Deterministic cursor ordering tuple anchored to the last hit of a search page (#47).</summary>
public readonly record struct SearchCursorPosition(
    SearchMatchTier Tier,
    long ScoreBits,
    long PublishedAtTicks,
    long CreatedAtTicks,
    int Id)
{
    public static SearchCursorPosition From(ArticleSearchHit hit) => new(
        hit.Tier,
        BitConverter.DoubleToInt64Bits(hit.Score),
        hit.Article.PublishedAt.UtcTicks,
        hit.Article.CreatedAt.UtcTicks,
        hit.Article.Id);
}

/// <summary>Raised when a search execution exceeds its explicit work budget rather than fabricating a truncated empty result (#47).</summary>
public sealed class SearchBudgetExceededException(string message = "Search work budget exceeded.") : Exception(message);

/// <summary>Detailed public search result exposing primary vs relaxed tier counts alongside ordered hits.</summary>
public readonly record struct ArticleSearchDetailedPage(
    ArticleSearchHit[] Hits,
    int Total,
    int PrimaryTotal,
    int RelaxedTotal);

/// <summary>Execution path selected by the bounded Top-K retrieval engine (#48).</summary>
public enum SearchExecutionPath : byte
{
    Empty = 0,
    SelectiveExact = 1,
    BlockMaxConjunction = 2,
    BlockMaxWand = 3,
    LatestBlockScan = 4,
    WideIndex = 5
}

/// <summary>
/// Generation-independent primitive block metadata over up to 64 ascending postings (#48, #51).
/// Stores only raw per-field TF maxima, field-length minima, exact-form presence, and publish timestamps
/// so dynamic bounds stay mathematically conservative across global-stat updates and segment merges.
/// </summary>
public readonly record struct SearchPostingBlockMeta(
    int MaxOrdinal,
    byte MaxTf0, byte MaxTf1, byte MaxTf2, byte MaxTf3, byte MaxTf4,
    byte HasAnyExact,
    ushort MinLen0, ushort MinLen1, ushort MinLen2, ushort MinLen3, ushort MinLen4,
    long MaxPublishedTicks,
    long MinPublishedTicks)
{
    public static SearchPostingBlockMeta Merge(SearchPostingBlockMeta left, SearchPostingBlockMeta right) => new(
        Math.Max(left.MaxOrdinal, right.MaxOrdinal),
        Math.Max(left.MaxTf0, right.MaxTf0),
        Math.Max(left.MaxTf1, right.MaxTf1),
        Math.Max(left.MaxTf2, right.MaxTf2),
        Math.Max(left.MaxTf3, right.MaxTf3),
        Math.Max(left.MaxTf4, right.MaxTf4),
        (byte)(left.HasAnyExact | right.HasAnyExact),
        Math.Min(left.MinLen0, right.MinLen0),
        Math.Min(left.MinLen1, right.MinLen1),
        Math.Min(left.MinLen2, right.MinLen2),
        Math.Min(left.MinLen3, right.MinLen3),
        Math.Min(left.MinLen4, right.MinLen4),
        Math.Max(left.MaxPublishedTicks, right.MaxPublishedTicks),
        Math.Min(left.MinPublishedTicks, right.MinPublishedTicks));

    public double UpperBoundBm25F(double idf, bool allowExactBonus, ReadOnlySpan<double> avgFieldLengths) =>
        SearchScoringProfile.UpperBoundConceptBlockBm25F(
            idf,
            MaxTf0, MaxTf1, MaxTf2, MaxTf3, MaxTf4,
            MinLen0, MinLen1, MinLen2, MinLen3, MinLen4,
            allowExactBonus,
            avgFieldLengths);
}

/// <summary>Per-query execution counters for verification and #44 performance reporting (#48).</summary>
public struct SearchExecutionStats
{
    public SearchExecutionPath Path;
    public int PostingsDecoded;
    public int BlocksVisited;
    public int BlocksSkipped;
    public int PositionsRead;
    public int CandidatesScored;
    public int PositionSkipsByBound;
    public bool PrunedCounting;
}

/// <summary>Truthful cursor-paginated public search result separating count relation from continuation availability (#47).</summary>
public readonly record struct ArticleSearchCursorPage(
    ArticleSearchHit[] Hits,
    int TotalCount,
    PublicSearchTotalRelation TotalRelation,
    int PrimaryCount,
    int RelaxedCount,
    bool HasMore,
    SearchCursorPosition? LastHitPosition);

/// <summary>
/// Documented BM25F-style scoring specification shared by the server index (compact &amp; wide)
/// and the independent unpruned reference oracle (<see cref="ExhaustiveSearchOracle"/>).
/// </summary>
public static class SearchScoringProfile
{
    public const int ProfileVersion = WireLimits.SearchFas4Profile;
    public const int FieldCount = 5;

    // Literature-grounded BM25F parameters (never tuned on the held-out evaluation split).
    public const double K1 = 1.2;

    public const double TitleWeight = 4.5;
    public const double HeadingWeight = 2.6;
    public const double SummaryWeight = 2.0;
    public const double TaxonomyWeight = 2.5;
    public const double BodyWeight = 1.0;

    public const double TitleB = 0.50;
    public const double HeadingB = 0.55;
    public const double SummaryB = 0.55;
    public const double TaxonomyB = 0.40;
    public const double BodyB = 0.75;

    // Bounded exact-form and phrase/proximity signals (all have closed-form upper bounds for #48 pruning).
    public const double ExactFormBonusFactor = 0.15;
    public const double TitleOrHeadingPhraseBonusFactor = 0.35;
    public const double BodyPhraseBonusFactor = 0.20;
    public const double TightProximityBonusFactor = 0.10;

    // Deterministic relaxation policy bounds.
    public const int RelaxationTriggerPrimaryCount = 5;
    public const int MaxRelaxedResults = 50;

    // Short 1-2 char ASCII prefix half-step equivalents (always strictly below exact primary TF = 2 half-steps).
    public const double ShortPrefixTitleTf = 0.50;
    public const double ShortPrefixSummaryTf = 0.25;
    public const double ShortPrefixTaxonomyTf = 0.25;

    public static double FieldWeight(int field) => field switch
    {
        (int)SearchScoreField.Title => TitleWeight,
        (int)SearchScoreField.Heading => HeadingWeight,
        (int)SearchScoreField.Summary => SummaryWeight,
        (int)SearchScoreField.Taxonomy => TaxonomyWeight,
        _ => BodyWeight
    };

    public static double FieldB(int field) => field switch
    {
        (int)SearchScoreField.Title => TitleB,
        (int)SearchScoreField.Heading => HeadingB,
        (int)SearchScoreField.Summary => SummaryB,
        (int)SearchScoreField.Taxonomy => TaxonomyB,
        _ => BodyB
    };

    public static SearchScoreField ToScoreField(SearchFieldKind kind) => kind switch
    {
        SearchFieldKind.Title => SearchScoreField.Title,
        SearchFieldKind.Heading => SearchScoreField.Heading,
        SearchFieldKind.Summary => SearchScoreField.Summary,
        SearchFieldKind.Taxonomy => SearchScoreField.Taxonomy,
        _ => SearchScoreField.Body
    };

    /// <summary>Standard non-negative BM25+ / Robertson-Sparck Jones IDF over the complete active generation.</summary>
    public static double InverseDocumentFrequency(int totalDocs, int docFreq)
    {
        if (totalDocs <= 0) return 0.0;
        var clampedDf = Math.Clamp(docFreq, 0, totalDocs);
        return Math.Log(1.0 + (totalDocs - clampedDf + 0.5) / (clampedDf + 0.5));
    }

    /// <summary>Upper bound on IDF for an absent term (df = 0) in a generation of <paramref name="totalDocs"/> documents.</summary>
    public static double MaxIdf(int totalDocs) => InverseDocumentFrequency(totalDocs, 0);

    /// <summary>
    /// Computes canonical BM25F contribution for one concept in one document over the 5 fields
    /// in fixed field order (<see cref="SearchScoreField.Title"/> .. <see cref="SearchScoreField.Body"/>).
    /// </summary>
    public static double ScoreConceptBm25F(
        double idf,
        ReadOnlySpan<double> fieldTfs,
        ReadOnlySpan<int> fieldLengths,
        ReadOnlySpan<double> avgFieldLengths)
    {
        if (idf <= 0.0) return 0.0;
        var pseudoTf = 0.0;
        for (var f = 0; f < FieldCount; f++)
        {
            var tf = fieldTfs[f];
            if (tf <= 0.0) continue;
            var b = FieldB(f);
            var avg = avgFieldLengths[f];
            var len = Math.Max(1, fieldLengths[f]);
            var norm = (1.0 - b) + b * (len / avg);
            pseudoTf += FieldWeight(f) * (tf / norm);
        }
        if (pseudoTf <= 0.0) return 0.0;
        return idf * ((pseudoTf * (K1 + 1.0)) / (pseudoTf + K1));
    }

    /// <summary>
    /// Computes a mathematically conservative upper bound on a concept's BM25F + exact-form contribution
    /// for any document in a posting block, evaluated dynamically from generation-independent primitive block stats
    /// against the active generation's <paramref name="idf"/> and <paramref name="avgFieldLengths"/> (#48, #51).
    /// </summary>
    public static double UpperBoundConceptBlockBm25F(
        double idf,
        byte maxTf0, byte maxTf1, byte maxTf2, byte maxTf3, byte maxTf4,
        ushort minLen0, ushort minLen1, ushort minLen2, ushort minLen3, ushort minLen4,
        bool allowExactBonus,
        ReadOnlySpan<double> avgFieldLengths)
    {
        if (idf <= 0.0) return 0.0;
        var pseudoTf = 0.0;
        if (maxTf0 != 0)
        {
            var norm = (1.0 - TitleB) + TitleB * (Math.Max(1, (int)minLen0) / avgFieldLengths[0]);
            pseudoTf += TitleWeight * ((maxTf0 * 0.5) / norm);
        }
        if (maxTf1 != 0)
        {
            var norm = (1.0 - HeadingB) + HeadingB * (Math.Max(1, (int)minLen1) / avgFieldLengths[1]);
            pseudoTf += HeadingWeight * ((maxTf1 * 0.5) / norm);
        }
        if (maxTf2 != 0)
        {
            var norm = (1.0 - SummaryB) + SummaryB * (Math.Max(1, (int)minLen2) / avgFieldLengths[2]);
            pseudoTf += SummaryWeight * ((maxTf2 * 0.5) / norm);
        }
        if (maxTf3 != 0)
        {
            var norm = (1.0 - TaxonomyB) + TaxonomyB * (Math.Max(1, (int)minLen3) / avgFieldLengths[3]);
            pseudoTf += TaxonomyWeight * ((maxTf3 * 0.5) / norm);
        }
        if (maxTf4 != 0)
        {
            var norm = (1.0 - BodyB) + BodyB * (Math.Max(1, (int)minLen4) / avgFieldLengths[4]);
            pseudoTf += BodyWeight * ((maxTf4 * 0.5) / norm);
        }
        var bm25 = pseudoTf > 0.0 ? idf * ((pseudoTf * (K1 + 1.0)) / (pseudoTf + K1)) : 0.0;
        var exact = allowExactBonus ? ExactFormBonusFactor * idf : 0.0;
        return (bm25 + exact) * (1.0 + 1e-11) + 1e-11;
    }

    /// <summary>
    /// Computes a conservative BM25F upper bound for a 1–2 char ASCII short-prefix block (#48).
    /// </summary>
    public static double UpperBoundShortPrefixBlockBm25F(
        double idf,
        ushort maxTitleHits, ushort maxSummaryHits, ushort maxTaxonomyHits,
        ushort minLen0, ushort minLen2, ushort minLen3,
        ReadOnlySpan<double> avgFieldLengths)
    {
        if (idf <= 0.0) return 0.0;
        var pseudoTf = 0.0;
        if (maxTitleHits != 0)
        {
            var norm = (1.0 - TitleB) + TitleB * (Math.Max(1, (int)minLen0) / avgFieldLengths[0]);
            pseudoTf += TitleWeight * ((maxTitleHits * ShortPrefixTitleTf) / norm);
        }
        if (maxSummaryHits != 0)
        {
            var norm = (1.0 - SummaryB) + SummaryB * (Math.Max(1, (int)minLen2) / avgFieldLengths[2]);
            pseudoTf += SummaryWeight * ((maxSummaryHits * ShortPrefixSummaryTf) / norm);
        }
        if (maxTaxonomyHits != 0)
        {
            var norm = (1.0 - TaxonomyB) + TaxonomyB * (Math.Max(1, (int)minLen3) / avgFieldLengths[3]);
            pseudoTf += TaxonomyWeight * ((maxTaxonomyHits * ShortPrefixTaxonomyTf) / norm);
        }
        var bm25 = pseudoTf > 0.0 ? idf * ((pseudoTf * (K1 + 1.0)) / (pseudoTf + K1)) : 0.0;
        return bm25 * (1.0 + 1e-11) + 1e-11;
    }

    public static bool AllowsRelaxation(SearchQueryPlan plan) =>
        !plan.IsEmpty && !plan.IsOverlongExactIdentifier && plan.ContentConcepts.Length >= 3;

    public static int MinRelaxedConcepts(int contentConceptCount) => contentConceptCount switch
    {
        <= 2 => contentConceptCount,
        3 => 2,
        4 => 3,
        _ => Math.Max(3, (int)Math.Ceiling(contentConceptCount * 0.30))
    };

    public static double MinRelaxedIdfRatio(int contentConceptCount) => contentConceptCount switch
    {
        <= 3 => 0.60,
        4 => 0.50,
        _ => 0.20
    };

    /// <summary>
    /// Deterministic ordering comparator (returns &lt; 0 when <paramref name="left"/> ranks ahead of <paramref name="right"/>).
    /// Primary hits always precede Relaxed hits in both sort modes.
    /// </summary>
    public static int CompareHits(ArticleSearchHit left, ArticleSearchHit right, ArticleSearchSort sort)
    {
        var tierCmp = ((byte)left.Tier).CompareTo((byte)right.Tier);
        if (tierCmp != 0) return tierCmp;
        if (sort == ArticleSearchSort.Latest)
        {
            var pub = right.Article.PublishedAt.UtcTicks.CompareTo(left.Article.PublishedAt.UtcTicks);
            if (pub != 0) return pub;
            var score = right.Score.CompareTo(left.Score);
            if (score != 0) return score;
            var created = right.Article.CreatedAt.UtcTicks.CompareTo(left.Article.CreatedAt.UtcTicks);
            return created != 0 ? created : right.Article.Id.CompareTo(left.Article.Id);
        }
        else
        {
            var score = right.Score.CompareTo(left.Score);
            if (score != 0) return score;
            var created = right.Article.CreatedAt.UtcTicks.CompareTo(left.Article.CreatedAt.UtcTicks);
            return created != 0 ? created : right.Article.Id.CompareTo(left.Article.Id);
        }
    }

    /// <summary>
    /// Compares <paramref name="hit"/> against a cursor ordering tuple under <paramref name="sort"/>.
    /// Returns &gt; 0 strictly when <paramref name="hit"/> ranks AFTER <paramref name="cursor"/>.
    /// </summary>
    public static int CompareHitToCursor(ArticleSearchHit hit, SearchCursorPosition cursor, ArticleSearchSort sort)
    {
        var tierCmp = ((byte)hit.Tier).CompareTo((byte)cursor.Tier);
        if (tierCmp != 0) return tierCmp;
        var cursorScore = BitConverter.Int64BitsToDouble(cursor.ScoreBits);
        if (sort == ArticleSearchSort.Latest)
        {
            var pub = cursor.PublishedAtTicks.CompareTo(hit.Article.PublishedAt.UtcTicks);
            if (pub != 0) return pub;
            var score = cursorScore.CompareTo(hit.Score);
            if (score != 0) return score;
            var created = cursor.CreatedAtTicks.CompareTo(hit.Article.CreatedAt.UtcTicks);
            return created != 0 ? created : cursor.Id.CompareTo(hit.Article.Id);
        }
        else
        {
            var score = cursorScore.CompareTo(hit.Score);
            if (score != 0) return score;
            var created = cursor.CreatedAtTicks.CompareTo(hit.Article.CreatedAt.UtcTicks);
            return created != 0 ? created : cursor.Id.CompareTo(hit.Article.Id);
        }
    }

    /// <summary>Packs (field:3, position:25, widthMinus1:4) into one 32-bit coordinate sorted by (field, position, width).</summary>
    public static uint PackPosition(SearchScoreField field, int position, int width)
    {
        var clampedPos = (uint)Math.Clamp(position, 0, 0x01FF_FFFF);
        var clampedWidth = (uint)Math.Clamp(width - 1, 0, 15);
        return (((uint)field & 7U) << 29) | (clampedPos << 4) | clampedWidth;
    }

    public static SearchScoreField UnpackField(uint packed) => (SearchScoreField)(packed >> 29);
    public static int UnpackPosition(uint packed) => (int)((packed >> 4) & 0x01FF_FFFFU);
    public static int UnpackWidth(uint packed) => (int)(packed & 15U) + 1;
}
