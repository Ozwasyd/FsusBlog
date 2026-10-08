using System.Collections.Immutable;
using System.Globalization;
using System.Text;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Internal original-source evidence only. Neither text nor coordinates may be exposed
/// before fresh permission, complete ranking and result/transport admission exist.
/// </summary>
public sealed record AuthorSearchSourceSnippetEvidence(
    AuthorSearchDocument Document, AuthorSearchSnippet Snippet, string RawText, string RawTextDigest);

/// <summary>Bounded unadmitted snippets, without a public result, count, facet or receipt.</summary>
public sealed record AuthorSearchSourceSnippetEvaluation(
    string QueryDigest, long IndexGeneration, long SourceGeneration, string SnapshotDigest,
    ImmutableArray<AuthorSearchSourceSnippetEvidence> Snippets);

public sealed partial class AuthorFullTextSearchQueryEvaluator
{
    /// <summary>The entire internal snippet stage retains at most one page of contexts.</summary>
    public const int MaxSourceSnippets = AuthorFullTextSearchContract.MaxPageSize;

    /// <summary>One context is bounded in original UTF-16 code units, including highlights.</summary>
    public const int MaxSnippetCharacters = 512;

    /// <summary>Original UTF-8 snippet bytes across the stage may not exceed this budget.</summary>
    public const int MaxSnippetUtf8Bytes = 256 * 1_024;

    private const int SnippetContextCharacters = 48;

    /// <summary>
    /// Rederives candidates, verifies the original complete source, and reads candidate
    /// fields through the existing index-source port. Original bytes and grapheme boundaries
    /// determine contexts; parser/epoch/heading identities are never manufactured here.
    /// Source parity and index identity are checked again before returning internal evidence.
    /// This method supplies no production permission, source adapter or transport grant.
    /// </summary>
    public async Task<AuthorSearchSourceSnippetEvaluation> MaterializeSourceSnippetsAsync(
        AuthorSearchQuery query, AuthorSearchTokenEvaluation evaluation,
        IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions,
        IAuthorFullTextSearchIndexSource source, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(evaluation);
        ArgumentNullException.ThrowIfNull(source);
        await RevalidateIndexAsync(query, evaluation, cancellationToken).ConfigureAwait(false);
        AuthorSearchTokenEvaluation expected = await InspectIndexAsync(query, definitions, cancellationToken)
            .ConfigureAwait(false);
        RequireSameEvaluation(evaluation, expected);
        await RevalidateSourceAsync(query, evaluation, source, cancellationToken).ConfigureAwait(false);
        AuthorSearchIndexReadSnapshot snapshot = await index.ReadSnapshotAsync(query.UserId,
            query.SiteScope, query.IndexGeneration, cancellationToken).ConfigureAwait(false);
        var snippets = ImmutableArray.CreateBuilder<AuthorSearchSourceSnippetEvidence>();
        int outputBytes = 0;
        foreach (IGrouping<int, AuthorSearchTokenCandidate> group in evaluation.Candidates
            .GroupBy(static candidate => candidate.Document.Identity.ArticleId))
        {
            cancellationToken.ThrowIfCancellationRequested();
            AuthorSearchIndexSourcePage page = await source.ReadAsync(query.UserId, query.SiteScope,
                group.Key - 1, 1, evaluation.SourceGeneration, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (page.SourceGeneration != evaluation.SourceGeneration || page.Articles.IsDefault
                || page.Articles.Length != 1 || page.Articles[0].ArticleId != group.Key
                || page.Articles[0].Deleted || page.Articles[0].Fields.IsDefault
                || page.Articles[0].Fields.Length > 1_000
                || page.Articles[0].SourceSequence != snapshot.Articles[group.Key].SourceSequence)
            {
                throw new AuthorSearchContractException("author_search_snippet_source_stale");
            }
            AuthorSearchIndexArticleSource article = page.Articles[0];
            foreach (AuthorSearchTokenCandidate candidate in group)
            {
                AuthorSearchIndexFieldSource[] fields = article.Fields.Where(field =>
                    AuthorFullTextSearchContract.SealDocument(field.Document with
                    {
                        Identity = field.Document.Identity with
                        {
                            IndexGeneration = query.IndexGeneration
                        }
                    }).ContentDigest == candidate.Document.ContentDigest).Take(2).ToArray();
                if (fields.Length != 1)
                {
                    throw new AuthorSearchContractException("author_search_snippet_field_stale");
                }
                AuthorSearchIndexFieldSource field = fields[0];
                AuthorSearchTokenizedDocument tokenized = snapshot.Articles[group.Key].Documents.Single(document =>
                    document.Document.ContentDigest == candidate.Document.ContentDigest);
                AuthorFullTextSearchVerifier.VerifyTokenDocument(tokenized, field.RawSource,
                    article.Definitions, field.ParserVersion, field.DocumentEpoch);
                foreach (AuthorSearchSourceSnippetEvidence snippet in CreateSourceSnippets(candidate, field, cancellationToken))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    outputBytes = checked(outputBytes + Encoding.UTF8.GetByteCount(snippet.RawText));
                    if (snippets.Count >= MaxSourceSnippets || outputBytes > MaxSnippetUtf8Bytes)
                    {
                        throw new AuthorSearchContractException("author_search_snippet_output_budget_exceeded");
                    }
                    snippets.Add(snippet);
                }
            }
        }
        await RevalidateSourceAsync(query, evaluation, source, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        Dictionary<string, int> order = evaluation.Candidates.Select((candidate, position) =>
            (candidate.Document.ContentDigest, position)).ToDictionary(static item => item.ContentDigest,
            static item => item.position, StringComparer.Ordinal);
        return new(evaluation.QueryDigest, evaluation.IndexGeneration, evaluation.SourceGeneration,
            evaluation.SnapshotDigest, [.. snippets.OrderBy(item => order[item.Document.ContentDigest])
                .ThenBy(static item => item.Snippet.Context.Utf16Start)]);
    }

    private static void RequireSameEvaluation(AuthorSearchTokenEvaluation actual, AuthorSearchTokenEvaluation expected)
    {
        if (actual.QueryDigest != expected.QueryDigest || actual.IndexGeneration != expected.IndexGeneration
            || actual.SourceGeneration != expected.SourceGeneration || actual.SnapshotDigest != expected.SnapshotDigest
            || actual.Candidates.IsDefault || actual.Candidates.Length != expected.Candidates.Length)
        {
            throw new AuthorSearchContractException("author_search_snippet_candidates_tampered");
        }
        for (int i = 0; i < actual.Candidates.Length; i++)
        {
            AuthorSearchTokenCandidate candidate = actual.Candidates[i];
            AuthorSearchTokenCandidate original = expected.Candidates[i];
            if (candidate is null || candidate.Document != original.Document || candidate.Ranges.IsDefault
                || !candidate.Ranges.SequenceEqual(original.Ranges) || candidate.PhraseClauses != original.PhraseClauses
                || candidate.MatchedRanges != original.MatchedRanges || candidate.FieldWeight != original.FieldWeight)
            {
                throw new AuthorSearchContractException("author_search_snippet_candidates_tampered");
            }
        }
    }

    private static IEnumerable<AuthorSearchSourceSnippetEvidence> CreateSourceSnippets(
        AuthorSearchTokenCandidate candidate, AuthorSearchIndexFieldSource field, CancellationToken cancellationToken)
    {
        string raw = field.RawSource;
        int[] boundaries = StringInfo.ParseCombiningCharacters(raw);
        ImmutableArray<AuthorSearchSourceRange> highlights = MergeHighlights(candidate.Ranges);
        int next = 0;
        while (next < highlights.Length)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int first = next++;
            int start = GraphemeStart(boundaries, Math.Max(candidate.Document.Source.Utf16Start,
                highlights[first].Utf16Start - SnippetContextCharacters));
            int end = GraphemeEnd(boundaries, raw.Length, Math.Min(candidate.Document.Source.Utf16End,
                highlights[first].Utf16End + SnippetContextCharacters));
            while (next < highlights.Length)
            {
                int nextStart = GraphemeStart(boundaries, Math.Max(candidate.Document.Source.Utf16Start,
                    highlights[next].Utf16Start - SnippetContextCharacters));
                if (nextStart > end)
                {
                    break;
                }
                end = GraphemeEnd(boundaries, raw.Length, Math.Min(candidate.Document.Source.Utf16End,
                    highlights[next++].Utf16End + SnippetContextCharacters));
            }
            if (start < candidate.Document.Source.Utf16Start || end > candidate.Document.Source.Utf16End
                || end - start > MaxSnippetCharacters)
            {
                throw new AuthorSearchContractException("author_search_snippet_context_budget_or_boundary_invalid");
            }
            AuthorSearchSourceRange context = candidate.Document.Source with
            {
                Utf16Start = start,
                Utf16End = end,
                Utf8Start = Encoding.UTF8.GetByteCount(raw.AsSpan(0, start)),
                Utf8End = Encoding.UTF8.GetByteCount(raw.AsSpan(0, end))
            };
            var snippet = new AuthorSearchSnippet(candidate.Document.ContentDigest, candidate.Document.Field.ContentDigest,
                candidate.Document.Field.Kind, candidate.Document.Field.HeadingIdentity, context,
                highlights[first..next], start > candidate.Document.Source.Utf16Start,
                end < candidate.Document.Source.Utf16End);
            AuthorFullTextSearchContract.ValidateSnippet(snippet, candidate.Document, raw,
                field.ParserVersion, field.DocumentEpoch);
            string text = raw[start..end];
            yield return new(candidate.Document, snippet, text, AuthorFullTextSearchContract.Digest(text));
        }
    }

    private static ImmutableArray<AuthorSearchSourceRange> MergeHighlights(ImmutableArray<AuthorSearchSourceRange> ranges)
    {
        var merged = ImmutableArray.CreateBuilder<AuthorSearchSourceRange>();
        foreach (AuthorSearchSourceRange range in ranges)
        {
            if (merged.Count > 0 && range.Utf16Start <= merged[^1].Utf16End)
            {
                AuthorSearchSourceRange previous = merged[^1];
                merged[^1] = previous with
                {
                    Utf16End = Math.Max(previous.Utf16End, range.Utf16End),
                    Utf8End = Math.Max(previous.Utf8End, range.Utf8End)
                };
            }
            else
            {
                merged.Add(range);
            }
        }
        return merged.ToImmutable();
    }

    private static int GraphemeStart(int[] boundaries, int offset)
    {
        int found = Array.BinarySearch(boundaries, offset);
        return found >= 0 ? boundaries[found] : boundaries[Math.Max(0, ~found - 1)];
    }

    private static int GraphemeEnd(int[] boundaries, int rawLength, int offset)
    {
        int found = Array.BinarySearch(boundaries, offset);
        int next = found >= 0 ? found : ~found;
        return next < boundaries.Length ? boundaries[next] : rawLength;
    }
}
