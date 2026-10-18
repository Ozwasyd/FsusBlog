using System.Collections;
using System.Reflection;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Real producer-to-token-consumer controls; no admitted typed query or permission receipt is fabricated.</summary>
[Trait("Category", "Unit")]
public sealed class AuthorFullTextSearchPropertyConsumerTests
{
    private static readonly Guid s_definitionId = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly DateTime s_instant = new(2026, 10, 18, 0, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData(ArticlePropertyValueType.Text)]
    [InlineData(ArticlePropertyValueType.Url)]
    public async Task ExistingTextPredicateReturnsActualCanonicalPropertyTokenCandidates(ArticlePropertyValueType type)
    {
        ArticlePropertyDefinition definition = Definition(type);
        string raw = type == ArticlePropertyValueType.Text ? "needle value" : "https://example.com/needle";
        var source = new Source(Article(definition, type == ArticlePropertyValueType.Text
            ? new ArticlePropertyTextValue(raw) : new ArticlePropertyUrlValue(raw)));
        using AuthorFullTextSearchIndex index = await Index(source);
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [s_definitionId] = definition };
        AuthorSearchQuery query = Query(index);
        var evidence = await evaluator.InspectIndexAsync(query, definitions);
        AuthorSearchTokenCandidate candidate = Assert.Single(evidence.Candidates);
        Assert.Equal(AuthorSearchFieldKind.Property, candidate.Document.Field.Kind);
        Assert.Equal(definition.ContentDigest, candidate.Document.Field.DefinitionDigest);
        Assert.Equal(source.Article.PropertyValues!.Values[0].ValueDigest, candidate.Document.Field.PropertyValueDigest);
        AuthorSearchSourceRange hit = Assert.Single(candidate.Ranges);
        Assert.Equal("needle", raw[hit.Utf16Start..hit.Utf16End]);
        Assert.Equal("needle", Encoding.UTF8.GetString(Encoding.UTF8.GetBytes(raw)[hit.Utf8Start..hit.Utf8End]));
        await evaluator.RevalidateSourceAsync(query, evidence, source);
        Assert.Empty((await evaluator.InspectIndexAsync(Query(index, "missing"), definitions)).Candidates);
        if (type == ArticlePropertyValueType.Text)
        {
            var phrase = Assert.Single((await evaluator.InspectIndexAsync(Query(index, "\"needle value\""), definitions)).Candidates);
            Assert.Equal(1, phrase.PhraseClauses);
            Assert.Equal(raw.Length, Assert.Single(phrase.Ranges).Utf16End);
        }
    }

    [Theory]
    [InlineData("schema")]
    [InlineData("owner")]
    [InlineData("site")]
    [InlineData("search")]
    [InlineData("status")]
    [InlineData("unchanged")]
    public async Task ActualPropertyCandidateRechecksDefinitionAfterFinalIndexAwait(string change)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Text);
        using AuthorFullTextSearchIndex index = await Index(new Source(Article(definition, new ArticlePropertyTextValue("needle value"))));
        var gate = Assert.IsType<SemaphoreSlim>(typeof(AuthorFullTextSearchIndex)
            .GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(index));
        bool held = false;
        var definitions = new WaitingDefinitions(definition, () =>
        {
            Assert.True(gate.Wait(0));
            held = true;
        });
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var pending = new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(Query(index), definitions, timeout.Token);
        try
        {
            Assert.True(held);
            Assert.False(pending.IsCompleted);
            definitions.Current = Seal(change switch
            {
                "schema" => definition with { SchemaRevision = 2 },
                "owner" => definition with { Owner = ArticlePropertyDefinitionOwner.User(43, "primary") },
                "site" => definition with { Owner = ArticlePropertyDefinitionOwner.User(42, "other") },
                "search" => definition with { SearchEligible = false },
                "status" => definition with { Status = ArticlePropertyDefinitionStatus.Deprecated },
                _ => definition
            });
            gate.Release();
            held = false;
            if (change == "unchanged")
            {
                Assert.Equal(AuthorSearchFieldKind.Property, Assert.Single((await pending).Candidates).Document.Field.Kind);
            }
            else
            {
                await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending);
            }
            Assert.Equal(1, index.RequireCurrentGeneration());
        }
        finally
        {
            if (held)
            {
                gate.Release();
            }
            try
            {
                _ = await pending;
            }
            catch (AuthorSearchContractException)
            {
                // Drain this test-owned operation after its checked refusal.
            }
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActualPropertyReadCannotUseReplacementIdentityAcrossAwait(bool intake)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Text);
        var source = new Source(Article(definition, new ArticlePropertyTextValue("needle value")));
        using AuthorFullTextSearchIndex first = await Index(source);
        using AuthorFullTextSearchIndex replacement = await Index(source);
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [s_definitionId] = definition };
        AuthorSearchQuery old = Query(first);
        var evaluator = new AuthorFullTextSearchQueryEvaluator(replacement);
        var operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, "value.is-present", []);
        var gate = Assert.IsType<SemaphoreSlim>(typeof(AuthorFullTextSearchIndex)
            .GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(replacement));
        await gate.WaitAsync();
        bool held = true;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        Task pending = intake ? evaluator.InspectPropertyOperandsAsync(old, definitions, [operand], timeout.Token)
            : evaluator.InspectIndexAsync(old, definitions, timeout.Token);
        try
        {
            Assert.False(pending.IsCompleted);
            Assert.Equal(first.RequireCurrentGeneration(), replacement.RequireCurrentGeneration());
            gate.Release();
            held = false;
            Assert.Equal("author_search_index_read_scope_or_generation_stale",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending)).Message);
            Assert.Single((await evaluator.InspectIndexAsync(Query(replacement), definitions, timeout.Token)).Candidates);
        }
        finally
        {
            if (held)
            {
                gate.Release();
            }
            try
            {
                await pending;
            }
            catch (AuthorSearchContractException)
            {
                // Drain this test-owned read without rebinding the incoming identity.
            }
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SnapshotFingerprintBindsActualTypedValueAndSnapshotCoordinates(bool coordinateOnly)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        var firstSource = new Source(Article(definition, new ArticlePropertyNumberValue(0)));
        var secondSource = new Source(Article(definition, new ArticlePropertyNumberValue(coordinateOnly ? 0 : 1),
            propertyRevision: coordinateOnly ? 2 : 1));
        using AuthorFullTextSearchIndex first = await Index(firstSource);
        using AuthorFullTextSearchIndex second = await Index(secondSource);
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [s_definitionId] = definition };
        var before = await new AuthorFullTextSearchQueryEvaluator(first).InspectIndexAsync(Query(first), definitions);
        var after = await new AuthorFullTextSearchQueryEvaluator(second).InspectIndexAsync(Query(second), definitions);
        Assert.Equal(before.SourceGeneration, after.SourceGeneration);
        Assert.Equal(before.IndexGeneration, after.IndexGeneration);
        Assert.Equal(Assert.Single(before.Candidates).Document.ContentDigest, Assert.Single(after.Candidates).Document.ContentDigest);
        Assert.NotEqual(before.SnapshotDigest, after.SnapshotDigest);
    }

    [Theory]
    [InlineData("user")]
    [InlineData("site")]
    [InlineData("permission-revision")]
    [InlineData("policy")]
    public async Task ActualPropertyCandidatesRetainOriginalActorSiteAndIndexedPermissionRefusals(string change)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Text);
        using AuthorFullTextSearchIndex index = await Index(new Source(Article(definition, new ArticlePropertyTextValue("needle"))));
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [s_definitionId] = definition };
        AuthorSearchQuery original = Query(index);
        AuthorSearchQuery query = AuthorFullTextSearchContract.SealQuery(change switch
        {
            "user" => original with { UserId = 43 },
            "site" => original with { SiteScope = "other" },
            "permission-revision" => original with { PermissionRevision = 2 },
            _ => original with { PermissionPolicyDigest = AuthorFullTextSearchContract.Digest("other") }
        });
        await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(query, definitions));
        Assert.Single((await new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(original, definitions)).Candidates);
    }

    [Fact]
    public async Task ProducerDoesNotConvertStringPropertyClauseIntoTypedExecutableAst()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        using AuthorFullTextSearchIndex index = await Index(new Source(Article(definition, new ArticlePropertyNumberValue(0))));
        AuthorSearchQuery query = AuthorFullTextSearchContract.SealQuery(Query(index) with
        {
            Clauses = [new(AuthorSearchClauseKind.Property, AuthorSearchFieldKind.Property, s_definitionId, "number.equals", ["0"])]
        });
        Assert.Equal("author_search_typed_property_operand_unavailable",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
                new AuthorFullTextSearchQueryEvaluator(index).InspectIndexAsync(query,
                    new Dictionary<Guid, ArticlePropertyDefinition> { [s_definitionId] = definition }))).Message);
    }

    private static AuthorSearchQuery Query(AuthorFullTextSearchIndex index, string text = "needle")
        => AuthorFullTextSearchContract.SealQuery(new(AuthorFullTextSearchContract.SchemaVersion,
            AuthorFullTextSearchContract.QuerySchema, AuthorFullTextSearchContract.TokenizerVersion,
            AuthorFullTextSearchContract.RankingVersion, AuthorFullTextSearchContract.IndexOwner,
            Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"), 42, "primary", 1, 1,
            AuthorSearchScope.CurrentArticle, AuthorFullTextSearchContract.ParseClauses(text), 10, null,
            string.Empty, AuthorFullTextSearchContract.Digest("policy"), index.IndexInstanceId));

    private static ArticlePropertyDefinition Definition(ArticlePropertyValueType type)
        => Seal(new(ArticlePropertyDefinitionContract.SchemaVersion, s_definitionId,
            ArticlePropertyDefinitionOwner.User(42, "primary"), "property", [new("en", "Property")], type,
            ArticlePropertyCardinality.Single, false,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            null, new(), [], null, type == ArticlePropertyValueType.Url
                ? new(["https"], false, true, 512, ArticlePropertyUrlNormalization.LowerSchemeHost) : null,
            true, true, false, ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.AuthorOnly,
            ArticlePropertyDefinitionStatus.Active, 1, s_instant, s_instant, string.Empty));

    private static ArticlePropertyDefinition Seal(ArticlePropertyDefinition definition)
        => definition with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
        };

    private static AuthorSearchIndexArticleSource Article(ArticlePropertyDefinition definition, ArticlePropertyTypedValue value,
        long propertyRevision = 1)
    {
        var input = new ArticlePropertyValueInput(s_definitionId, 1, definition.ContentDigest, ArticlePropertyValuePresence.Present, value);
        var entry = new ArticlePropertyValueEntry(s_definitionId, 1, definition.ContentDigest, input.Presence, value,
            ArticlePropertyValueDigest.ComputeValue(input));
        var coordinates = new ArticlePropertySnapshotCoordinates(42, "primary", 1, propertyRevision, 1);
        var snapshot = new ArticlePropertyValueSnapshot(ArticlePropertyValueSnapshot.CurrentSchemaVersion, coordinates, [entry],
            ArticlePropertyValueDigest.ComputeSnapshot(coordinates, [entry]));
        string raw = value switch
        {
            ArticlePropertyTextValue text => text.Text,
            ArticlePropertyUrlValue url => url.Url,
            _ => "needle"
        };
        bool property = value is ArticlePropertyTextValue or ArticlePropertyUrlValue;
        string digest = AuthorFullTextSearchContract.Digest(raw);
        var document = AuthorFullTextSearchContract.SealDocument(new(
            AuthorFullTextSearchContract.SchemaVersion, AuthorFullTextSearchContract.DocumentSchema,
            AuthorFullTextSearchContract.TokenizerVersion, AuthorFullTextSearchContract.IndexOwner,
            new(1, 42, "primary", 1, 1, 1, 1, "en", ArticleStatus.Draft, AuthorSearchScope.CurrentArticle,
                AuthorSearchPermissionState.Allowed, AuthorSearchVisibilityScope.AuthorOnly, AuthorFullTextSearchContract.Digest("policy")),
            new(property ? AuthorSearchFieldKind.Property : AuthorSearchFieldKind.Title, digest, null,
                property ? s_definitionId : null, property ? 1 : null, PropertyValueType: property ? definition.ValueType : null,
                DefinitionDigest: property ? definition.ContentDigest : null, PropertyValueDigest: property ? entry.ValueDigest : null),
            new(AuthorFullTextSearchContract.SourceCoordinateAuthority, "algorithm-fixture-parser", "document:1", 1,
                digest, 0, raw.Length, 0, Encoding.UTF8.GetByteCount(raw)), string.Empty));
        return new(1, 1, false, [new(document, raw, "algorithm-fixture-parser", "document:1")],
            new Dictionary<Guid, ArticlePropertyDefinition> { [s_definitionId] = definition }, snapshot);
    }

    private static async Task<AuthorFullTextSearchIndex> Index(Source source)
    {
        var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        while (await index.RebuildStepAsync() is not null)
        {
        }
        return index;
    }

    private sealed class Source(AuthorSearchIndexArticleSource article) : IAuthorFullTextSearchIndexSource
    {
        public AuthorSearchIndexArticleSource Article { get; } = article;

        public Task<AuthorSearchIndexSourcePage> ReadAsync(int userId, string siteScope, int afterArticleId,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(new AuthorSearchIndexSourcePage(1, afterArticleId < 1 ? [Article] : [], false));
        }
    }

    private sealed class WaitingDefinitions(ArticlePropertyDefinition definition, Action wait)
        : IReadOnlyDictionary<Guid, ArticlePropertyDefinition>
    {
        public ArticlePropertyDefinition Current { get; set; } = definition;
        private int _lookups;
        public int Count => 1;
        public IEnumerable<Guid> Keys => [s_definitionId];
        public IEnumerable<ArticlePropertyDefinition> Values => [Current];
        public ArticlePropertyDefinition this[Guid key] => Current;
        public bool ContainsKey(Guid key) => key == s_definitionId;
        public bool TryGetValue(Guid key, out ArticlePropertyDefinition value)
        {
            value = Current;
            if (++_lookups == 2)
            {
                wait();
            }
            return ContainsKey(key);
        }
        public IEnumerator<KeyValuePair<Guid, ArticlePropertyDefinition>> GetEnumerator()
            => new[] { new KeyValuePair<Guid, ArticlePropertyDefinition>(s_definitionId, Current) }.AsEnumerable().GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
