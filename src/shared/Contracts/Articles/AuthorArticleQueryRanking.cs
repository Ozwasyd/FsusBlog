using System.Text;

namespace FsusBlog.Contracts.Articles;

/// <summary>Deterministic entity-field ranking, with no index, corpus reader or permission policy.</summary>
/// <remarks>The caller must first admit candidates and recent ordinals through server authorities.</remarks>
public static class AuthorArticleQueryRanking
{
    /// <summary>The ranking identity that must invalidate earlier cursors and cached results.</summary>
    public const string RankingId = "author-article-entity-ranking.v1";
    /// <summary>A nonmatching field sorts after every admitted match class.</summary>
    public const int NoMatch = 3;

    /// <summary>Normalizes comparison text without changing any article identity or source text.</summary>
    /// <remarks>NFKC and invariant uppercase preserve diacritics, combining equivalence, CJK and RTL.</remarks>
    public static string NormalizeText(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        return value.Normalize(NormalizationForm.FormKC).Trim().ToUpperInvariant();
    }

    /// <summary>Returns exact, prefix and bounded fuzzy title/slug matches, then taxonomy matches.</summary>
    /// <remarks>Only the result key is produced; this method does not grant access to metadata.</remarks>
    public static AuthorArticleQueryRank? Rank(
        string queryText,
        AuthorArticleQueryCandidate candidate,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(candidate);
        ArgumentNullException.ThrowIfNull(candidate.Tags);
        if (candidate.ArticleId <= 0
            || candidate.ServerRevision <= 0
            || !Enum.IsDefined(candidate.Status)
            || string.IsNullOrWhiteSpace(candidate.PermissionToken)
            || candidate.VerifiedRecentOrdinal is <= 0
            || candidate.Title is null
            || candidate.Slug is null
            || candidate.Category is null
            || candidate.Tags.Any(static tag => tag is null)
            || candidate.Tags.Count > 100
            || candidate.Title.Length > 512
            || candidate.Slug.Length > 512
            || candidate.Category.Length > 256
            || candidate.Tags.Any(static tag => tag.Length > 256))
        {
            throw new ArgumentException("author_article_query_candidate_invalid", nameof(candidate));
        }
        string query = NormalizeText(queryText);
        Rune[] queryRunes = query.EnumerateRunes().ToArray();
        if (queryRunes.Length > AuthorArticleQueryContract.MaxQueryRunes)
        {
            throw new ArgumentException("author_article_query_text_too_long", nameof(queryText));
        }
        (int titleMatch, int titleDistance) = Match(query, queryRunes, candidate.Title, cancellationToken);
        (int slugMatch, int slugDistance) = Match(query, queryRunes, candidate.Slug, cancellationToken);
        int taxonomyMatch = TaxonomyMatch(query, candidate.Category, candidate.Tags, cancellationToken);
        if (query.Length != 0
            && titleMatch == NoMatch
            && slugMatch == NoMatch
            && taxonomyMatch == NoMatch)
        {
            return null;
        }
        return new(
            titleMatch,
            titleDistance,
            slugMatch,
            slugDistance,
            taxonomyMatch,
            candidate.VerifiedRecentOrdinal ?? int.MaxValue,
            StatusPriority(candidate.Status),
            candidate.ArticleId);
    }

    /// <summary>Compares the machine-readable ranking tuple; stable article ID is the final tie.</summary>
    public static int Compare(AuthorArticleQueryRank left, AuthorArticleQueryRank right)
    {
        ArgumentNullException.ThrowIfNull(left);
        ArgumentNullException.ThrowIfNull(right);
        int[] leftFactors =
        [left.TitleMatch, left.TitleDistance, left.SlugMatch, left.SlugDistance,
            left.TaxonomyMatch, left.RecentOrdinal, left.StatusPriority, left.ArticleId];
        int[] rightFactors =
        [right.TitleMatch, right.TitleDistance, right.SlugMatch, right.SlugDistance,
            right.TaxonomyMatch, right.RecentOrdinal, right.StatusPriority, right.ArticleId];
        for (int index = 0; index < leftFactors.Length; index++)
        {
            int comparison = leftFactors[index].CompareTo(rightFactors[index]);
            if (comparison != 0)
            {
                return comparison;
            }
        }
        return 0;
    }

    private static (int Match, int Distance) Match(
        string query,
        Rune[] queryRunes,
        string value,
        CancellationToken cancellationToken)
    {
        string normalized = NormalizeText(value);
        if (query.Length == 0 || normalized == query)
        {
            return (0, 0);
        }
        if (normalized.StartsWith(query, StringComparison.Ordinal))
        {
            return (1, 0);
        }
        Rune[] valueRunes = normalized.EnumerateRunes().ToArray();
        int maxDistance = queryRunes.Length < 4 ? 0 : queryRunes.Length < 8 ? 1 : 2;
        if (maxDistance == 0 || Math.Abs(valueRunes.Length - queryRunes.Length) > maxDistance)
        {
            return (NoMatch, int.MaxValue);
        }
        int distance = EditDistance(queryRunes, valueRunes, maxDistance, cancellationToken);
        return distance <= maxDistance ? (2, distance) : (NoMatch, int.MaxValue);
    }

    private static int TaxonomyMatch(
        string query,
        string category,
        IReadOnlyList<string> tags,
        CancellationToken cancellationToken)
    {
        int best = NoMatch;
        foreach (string value in tags.Prepend(category))
        {
            cancellationToken.ThrowIfCancellationRequested();
            string normalized = NormalizeText(value);
            int current = query.Length == 0 || normalized == query
                ? 0
                : normalized.StartsWith(query, StringComparison.Ordinal) ? 1 : NoMatch;
            best = Math.Min(best, current);
        }
        return best;
    }

    private static int EditDistance(
        Rune[] query,
        Rune[] value,
        int maximum,
        CancellationToken cancellationToken)
    {
        int[] previous = [.. Enumerable.Range(0, value.Length + 1)];
        int[] current = new int[previous.Length];
        for (int row = 1; row <= query.Length; row++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            current[0] = row;
            int rowMinimum = row;
            for (int column = 1; column <= value.Length; column++)
            {
                current[column] = Math.Min(
                    Math.Min(previous[column] + 1, current[column - 1] + 1),
                    previous[column - 1] + (query[row - 1] == value[column - 1] ? 0 : 1));
                rowMinimum = Math.Min(rowMinimum, current[column]);
            }
            if (rowMinimum > maximum)
            {
                return maximum + 1;
            }
            (previous, current) = (current, previous);
        }
        return previous[value.Length];
    }

    private static int StatusPriority(AuthorArticleQueryStatus status)
        => status switch
        {
            AuthorArticleQueryStatus.Draft => 0,
            AuthorArticleQueryStatus.Published => 1,
            AuthorArticleQueryStatus.Scheduled => 2,
            AuthorArticleQueryStatus.Archived => 3,
            _ => throw new ArgumentOutOfRangeException(nameof(status))
        };
}
