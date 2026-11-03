using System.Collections.Immutable;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Real index/tokenizer algorithm execution on explicit fixture source, without production admission.</summary>
[Trait("Category", "Unit")]
public sealed class AuthorFullTextSearchQueryEvaluatorTests
{
    private static readonly IReadOnlyDictionary<Guid, ArticlePropertyDefinition> s_definitions =
        new Dictionary<Guid, ArticlePropertyDefinition>();

    [Theory]
    [InlineData("中文", "中文")]
    [InlineData("CAFÉ", "cafe\u0301")]
    [InlineData("ПРИВЕТ", "привет")]
    [InlineData("العربية", "العربية")]
    [InlineData("👩‍💻", "👩‍💻")]
    [InlineData("ος", "οσ")]
    public async Task Uses_Original_Tokenizer_And_Original_Raw_Coordinates(string raw, string queryText)
    {
        var source = new Source([new(1, AuthorSearchFieldKind.MarkdownBody, raw)]);
        using AuthorFullTextSearchIndex index = await Build(source);
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        AuthorSearchQuery query = Query(queryText);
        AuthorSearchTokenEvaluation result = await evaluator.InspectIndexAsync(query, s_definitions);
        AuthorSearchTokenCandidate candidate = Assert.Single(result.Candidates);
        Assert.Equal(1, candidate.Document.Identity.ArticleId);
        Assert.All(candidate.Ranges, range =>
        {
            Assert.Equal(Encoding.UTF8.GetByteCount(raw.AsSpan(0, range.Utf16Start)), range.Utf8Start);
            Assert.Equal(Encoding.UTF8.GetByteCount(raw.AsSpan(0, range.Utf16End)), range.Utf8End);
            Assert.Equal(AuthorFullTextSearchContract.Digest(raw), range.SourceDigest);
            Assert.Equal(source.Parser, range.ParserVersion);
        });
        await evaluator.RevalidateIndexAsync(query, result);
        await evaluator.RevalidateSourceAsync(query, result, source);
    }

    [Fact]
    public async Task Phrase_Requires_Adjacent_Ordered_Tokens_In_One_Field()
    {
        var source = new Source([
            new(1, AuthorSearchFieldKind.Title, "red blue red blue"),
            new(2, AuthorSearchFieldKind.Title, "red green blue"),
            new(3, AuthorSearchFieldKind.Title, "blue red"),
            new(4, AuthorSearchFieldKind.Title, "red"),
            new(4, AuthorSearchFieldKind.Summary, "blue")]);
        using AuthorFullTextSearchIndex index = await Build(source);
        AuthorSearchTokenEvaluation result = await new AuthorFullTextSearchQueryEvaluator(index)
            .InspectIndexAsync(Query("\"red blue\""), s_definitions);
        AuthorSearchTokenCandidate hit = Assert.Single(result.Candidates);
        Assert.Equal(1, hit.Document.Identity.ArticleId);
        Assert.Equal(2, hit.Ranges.Length);
        Assert.Equal([0, 9], hit.Ranges.Select(static range => range.Utf16Start));
        Assert.Equal([8, 17], hit.Ranges.Select(static range => range.Utf16End));
    }

    [Fact]
    public async Task Conjunction_May_Match_Different_Fields_But_Field_Restriction_Is_Exact()
    {
        var source = new Source([
            new(1, AuthorSearchFieldKind.Title, "red"), new(1, AuthorSearchFieldKind.Summary, "blue"),
            new(2, AuthorSearchFieldKind.Title, "red blue")]);
        using AuthorFullTextSearchIndex index = await Build(source);
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        AuthorSearchTokenEvaluation both = await evaluator.InspectIndexAsync(Query("red blue"), s_definitions);
        Assert.Equal([1, 2], both.Candidates.Select(static candidate => candidate.Document.Identity.ArticleId).Distinct().Order());
        AuthorSearchTokenEvaluation title = await evaluator.InspectIndexAsync(Query("field.title:\"red blue\""), s_definitions);
        Assert.Equal(2, Assert.Single(title.Candidates).Document.Identity.ArticleId);
    }

    [Fact]
    public async Task Indexed_Status_And_Taxonomy_Filters_Are_Conjunctive()
    {
        var source = new Source([
            new(1, AuthorSearchFieldKind.Title, "red"), new(1, AuthorSearchFieldKind.Category, "category", TaxonomyId: 8),
            new(1, AuthorSearchFieldKind.Tag, "tag", TaxonomyId: 9),
            new(2, AuthorSearchFieldKind.Title, "red", ArticleStatus.Published),
            new(3, AuthorSearchFieldKind.Title, "red")]);
        using AuthorFullTextSearchIndex index = await Build(source);
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        AuthorSearchTokenEvaluation filtered = await evaluator.InspectIndexAsync(Query("red status:draft category:8 tag:9"), s_definitions);
        Assert.Equal(1, Assert.Single(filtered.Candidates).Document.Identity.ArticleId);
        Assert.Empty((await evaluator.InspectIndexAsync(Query("red status:archived"), s_definitions)).Candidates);
    }

    [Fact]
    public async Task Partial_Metrics_Use_Registry_Weights_And_Stable_Ties()
    {
        var source = new Source([
            new(3, AuthorSearchFieldKind.Summary, "red"), new(2, AuthorSearchFieldKind.Title, "red"),
            new(1, AuthorSearchFieldKind.Title, "red"), new(4, AuthorSearchFieldKind.Heading, "red")]);
        using AuthorFullTextSearchIndex index = await Build(source);
        AuthorSearchTokenEvaluation result = await new AuthorFullTextSearchQueryEvaluator(index)
            .InspectIndexAsync(Query("red"), s_definitions);
        Assert.Equal([1, 2, 4, 3], result.Candidates.Select(static candidate => candidate.Document.Identity.ArticleId));
        Assert.Equal([10, 10, 6, 4], result.Candidates.Select(static candidate => candidate.FieldWeight));
        Assert.All(result.Candidates, candidate => Assert.Equal(1, candidate.MatchedRanges));
        Assert.Equal("heading:4", result.Candidates[2].Document.Field.HeadingIdentity);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(10_000)]
    public async Task Actual_Index_Scale_Keeps_One_Bounded_Candidate_Page(int count)
    {
        var source = new Source([.. Enumerable.Range(1, count).Select(static id => new Field(id, AuthorSearchFieldKind.Title, "red"))]);
        using AuthorFullTextSearchIndex index = await Build(source);
        AuthorSearchTokenEvaluation result = await new AuthorFullTextSearchQueryEvaluator(index)
            .InspectIndexAsync(Query("red", pageSize: 7), s_definitions);
        Assert.Equal(Math.Min(7, count), result.Candidates.Length);
        Assert.Equal(Enumerable.Range(1, Math.Min(7, count)), result.Candidates.Select(static candidate => candidate.Document.Identity.ArticleId));
    }

    [Theory]
    [InlineData("updated-at.before:2026-10-08T00:00:00.0000000+00:00 red", "author_search_current_updated_at_unavailable")]
    [InlineData("status:draft", "author_search_filter_only_query_unavailable")]
    [InlineData("\"...\"", "author_search_query_has_no_searchable_tokens")]
    public async Task Missing_Facts_And_Unsearchable_Query_Refuse_Explicitly(string text, string reason)
    {
        using AuthorFullTextSearchIndex index = await Build(new Source([]));
        AuthorSearchContractException error = await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(Query(text), s_definitions));
        Assert.Equal(reason, error.Message);
    }

    [Fact]
    public async Task Too_Many_Highlights_Refuse_Instead_Of_Silent_Truncation()
    {
        using AuthorFullTextSearchIndex index = await Build(new Source([new(1, AuthorSearchFieldKind.Title, string.Join(' ', Enumerable.Repeat("red", 257)))]));
        AuthorSearchContractException error = await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(Query("red"), s_definitions));
        Assert.Equal("author_search_highlight_budget_exceeded", error.Message);
    }

    [Fact]
    public async Task Stale_Permission_Facts_Do_Not_Become_Admitted_Candidates()
    {
        using AuthorFullTextSearchIndex index = await Build(new Source([new(1, AuthorSearchFieldKind.Title, "red")]));
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        AuthorSearchQuery query = AuthorFullTextSearchContract.SealQuery(Query("red") with
        {
            PermissionRevision = 2
        });
        Assert.Equal("author_search_indexed_facts_stale_or_invalid",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() => evaluator.InspectIndexAsync(query, s_definitions))).Message);
        query = AuthorFullTextSearchContract.SealQuery(Query("red") with
        {
            PermissionPolicyDigest = AuthorFullTextSearchContract.Digest("changed-policy")
        });
        Assert.Equal("author_search_indexed_facts_stale_or_invalid",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() => evaluator.InspectIndexAsync(query, s_definitions))).Message);
    }

    [Fact]
    public async Task Revalidation_Rejects_Article_Replacement_With_Current_Generation_Advance()
    {
        var source = new Source([new(1, AuthorSearchFieldKind.Title, "red")]);
        using AuthorFullTextSearchIndex index = await Build(source);
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        AuthorSearchQuery query = Query("red");
        AuthorSearchTokenEvaluation result = await evaluator.InspectIndexAsync(query, s_definitions);
        source.Sequence = 2;
        source.Fields = [new(1, AuthorSearchFieldKind.Title, "blue")];
        await index.ApplyAsync(1, 2, AuthorSearchIndexLifecycleEvent.Edit);
        Assert.Equal(2, index.RequireCurrentGeneration());
        Assert.Equal("author_search_index_read_scope_or_generation_stale",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() => evaluator.RevalidateIndexAsync(query, result))).Message);
    }

    [Fact]
    public async Task Revalidation_Rejects_Query_Identity_Change_And_Evaluation_Digest_Tamper()
    {
        using AuthorFullTextSearchIndex index = await Build(new Source([new(1, AuthorSearchFieldKind.Title, "red")]));
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        AuthorSearchQuery query = Query("red");
        AuthorSearchTokenEvaluation result = await evaluator.InspectIndexAsync(query, s_definitions);
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => evaluator.RevalidateIndexAsync(Query("red"), result));
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => evaluator.RevalidateIndexAsync(
            query with
            {
                Clauses = AuthorFullTextSearchContract.ParseClauses("blue")
            }, result));
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => evaluator.RevalidateIndexAsync(query,
            result with
            {
                SnapshotDigest = AuthorFullTextSearchContract.Digest("tampered")
            }));
    }

    [Fact]
    public async Task Original_Source_Verifier_Rejects_Source_And_Permission_Drift_Without_Index_Event()
    {
        var source = new Source([new(1, AuthorSearchFieldKind.Title, "red")]);
        using AuthorFullTextSearchIndex index = await Build(source);
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        AuthorSearchQuery query = Query("red");
        AuthorSearchTokenEvaluation result = await evaluator.InspectIndexAsync(query, s_definitions);
        source.Fields = [new(1, AuthorSearchFieldKind.Title, "blue")];
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => evaluator.RevalidateSourceAsync(query, result, source));
        source.Fields = [new(1, AuthorSearchFieldKind.Title, "red")];
        source.Permission = AuthorSearchPermissionState.Denied;
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => evaluator.RevalidateSourceAsync(query, result, source));
    }

    [Fact]
    public async Task Index_Unavailable_Wrong_Scope_And_Stale_Generation_Refuse()
    {
        using var index = new AuthorFullTextSearchIndex(new Source([]), 42, "primary");
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => evaluator.InspectIndexAsync(Query("red"), s_definitions));
        while (await index.RebuildStepAsync() is not null)
        {
        }
        foreach (AuthorSearchQuery query in new[]
        {
            AuthorFullTextSearchContract.SealQuery(Query("red") with { SiteScope = "other" }),
            AuthorFullTextSearchContract.SealQuery(Query("red") with { UserId = 99 }),
            AuthorFullTextSearchContract.SealQuery(Query("red") with { IndexGeneration = 2 })
        })
        {
            Assert.Equal("author_search_index_read_scope_or_generation_stale",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() => evaluator.InspectIndexAsync(query, s_definitions))).Message);
        }
    }

    [Fact]
    public async Task Cancellation_Prevents_Evaluation_And_Revalidation()
    {
        using AuthorFullTextSearchIndex index = await Build(new Source([]));
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        AuthorSearchQuery query = Query("red");
        AuthorSearchTokenEvaluation result = await evaluator.InspectIndexAsync(query, s_definitions);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => evaluator.InspectIndexAsync(query, s_definitions, cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => evaluator.RevalidateIndexAsync(query, result, cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => evaluator.RevalidateSourceAsync(query, result, new Source([]), cancellation.Token));
    }

    [Fact]
    public async Task Cancellation_While_Waiting_For_Actual_Index_Gate_Does_Not_Return_Late_Candidates()
    {
        var source = new Source([new(1, AuthorSearchFieldKind.Title, "red")]);
        using AuthorFullTextSearchIndex index = await Build(source);
        source.WaitBeforeRead = new(TaskCreationOptions.RunContinuationsAsynchronously);
        source.ReadEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<AuthorSearchIndexCheckpoint?> rebuilding = index.RebuildStepAsync();
        await source.ReadEntered.Task;
        using var cancellation = new CancellationTokenSource();
        Task<AuthorSearchTokenEvaluation> query = new AuthorFullTextSearchQueryEvaluator(index)
            .InspectIndexAsync(Query("red"), s_definitions, cancellation.Token);
        try
        {
            Assert.False(query.IsCompleted);
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => query);
        }
        finally
        {
            source.WaitBeforeRead.SetResult();
            await rebuilding;
        }
    }

    private static AuthorSearchQuery Query(string text, int pageSize = 100)
        => AuthorFullTextSearchContract.SealQuery(new(AuthorFullTextSearchContract.SchemaVersion,
            AuthorFullTextSearchContract.QuerySchema, AuthorFullTextSearchContract.TokenizerVersion,
            AuthorFullTextSearchContract.RankingVersion, AuthorFullTextSearchContract.IndexOwner,
            Guid.NewGuid(), 42, "primary", 1, 1, AuthorSearchScope.CurrentArticle,
            AuthorFullTextSearchContract.ParseClauses(text), pageSize, null, string.Empty,
            AuthorFullTextSearchContract.Digest("fixture-policy")));

    private static async Task<AuthorFullTextSearchIndex> Build(Source source)
    {
        var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        while (await index.RebuildStepAsync() is not null)
        {
        }
        return index;
    }

    private sealed record Field(int Id, AuthorSearchFieldKind Kind, string Text,
        ArticleStatus Status = ArticleStatus.Draft, int? TaxonomyId = null);

    private sealed class Source(ImmutableArray<Field> fields) : IAuthorFullTextSearchIndexSource
    {
        public ImmutableArray<Field> Fields { get; set; } = fields;
        public long Sequence { get; set; } = 1;
        public AuthorSearchPermissionState Permission { get; set; } = AuthorSearchPermissionState.Allowed;
        public TaskCompletionSource? WaitBeforeRead
        {
            get; set;
        }
        public TaskCompletionSource? ReadEntered
        {
            get; set;
        }
        public string Parser => "explicit-algorithm-fixture";

        public async Task<AuthorSearchIndexSourcePage> ReadAsync(int userId, string siteScope, int afterArticleId,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (WaitBeforeRead is not null)
            {
                ReadEntered!.TrySetResult();
                await WaitBeforeRead.Task.WaitAsync(cancellationToken);
            }
            var articles = ImmutableArray.CreateBuilder<AuthorSearchIndexArticleSource>();
            IGrouping<int, Field>[] grouped = Fields.GroupBy(static field => field.Id).OrderBy(static group => group.Key).ToArray();
            foreach (IGrouping<int, Field> group in grouped.Where(group => group.Key > afterArticleId).Take(pageSize))
            {
                var projected = ImmutableArray.CreateBuilder<AuthorSearchIndexFieldSource>();
                foreach (Field field in group)
                {
                    string digest = AuthorFullTextSearchContract.Digest(field.Text);
                    AuthorSearchDocument document = AuthorFullTextSearchContract.SealDocument(new(
                        AuthorFullTextSearchContract.SchemaVersion, AuthorFullTextSearchContract.DocumentSchema,
                        AuthorFullTextSearchContract.TokenizerVersion, AuthorFullTextSearchContract.IndexOwner,
                        new(field.Id, userId, siteScope, Sequence, Sequence, 1, 1, "en", field.Status,
                            AuthorSearchScope.CurrentArticle, Permission,
                            AuthorSearchVisibilityScope.AuthorOnly, AuthorFullTextSearchContract.Digest("fixture-policy")),
                        new(field.Kind, digest, field.Kind == AuthorSearchFieldKind.Heading ? $"heading:{field.Id}" : null,
                            null, null, field.TaxonomyId),
                        new(AuthorFullTextSearchContract.SourceCoordinateAuthority, Parser, "fixture-epoch",
                            Sequence, digest, 0, field.Text.Length, 0, Encoding.UTF8.GetByteCount(field.Text)), string.Empty));
                    projected.Add(new(document, field.Text, Parser, "fixture-epoch"));
                }
                articles.Add(new(group.Key, Sequence, false, projected.ToImmutable(), s_definitions));
            }
            int last = articles.Count == 0 ? afterArticleId : articles[^1].ArticleId;
            return new AuthorSearchIndexSourcePage(1, articles.ToImmutable(), grouped.Any(group => group.Key > last));
        }
    }
}
