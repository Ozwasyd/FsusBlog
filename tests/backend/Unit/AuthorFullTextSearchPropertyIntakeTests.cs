using System.Collections.Immutable;
using System.Reflection;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Controls for unadmitted typed intake; these do not qualify product query execution.</summary>
[Trait("Category", "Unit")]
public sealed class AuthorFullTextSearchPropertyIntakeTests
{
    [Theory]
    [InlineData("number")]
    [InlineData("boolean")]
    [InlineData("date")]
    public async Task IntakeRetainsCanonicalZeroFalseAndUtcWithoutExecutingProperties(string kind)
    {
        ArticlePropertyValueType type = kind switch
        {
            "number" => ArticlePropertyValueType.Number,
            "boolean" => ArticlePropertyValueType.Boolean,
            _ => ArticlePropertyValueType.Date
        };
        ArticlePropertyTypedValue value = kind switch
        {
            "number" => new ArticlePropertyNumberValue(0),
            "boolean" => new ArticlePropertyBooleanValue(false),
            _ => new ArticlePropertyDateValue(Instant())
        };
        string operation = kind == "date" ? "date.before" : kind + ".equals";
        ArticlePropertyDefinition definition = Definition(type);
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition };
        AuthorSearchPropertyOperand operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, operation, [value]);
        AuthorSearchPropertyOperand[] borrowed = [operand];
        using AuthorFullTextSearchIndex index = await Index();
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        AuthorSearchQuery query = Query(index);
        AuthorSearchPropertyOperandIntake intake = await evaluator.InspectPropertyOperandsAsync(query, definitions, borrowed);
        borrowed[0] = operand with
        {
            ContentDigest = "tampered"
        };
        Assert.Same(operand, Assert.Single(intake.Operands));
        Assert.Same(value, intake.Operands[0].Values[0]);
        Assert.Empty(intake.IndexEvidence.Candidates);
        await evaluator.RevalidatePropertyOperandsAsync(query, intake, definitions);
    }

    [Theory]
    [InlineData("site")]
    [InlineData("user")]
    [InlineData("search")]
    public async Task IntakeCannotReplaceOriginalDefinitionEligibility(string fault)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        definition = Seal(definition with
        {
            Owner = fault == "site" ? ArticlePropertyDefinitionOwner.User(42, "other")
                : fault == "user" ? ArticlePropertyDefinitionOwner.User(43, "primary") : definition.Owner,
            SearchEligible = fault != "search"
        });
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition };
        var operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.equals", [new ArticlePropertyNumberValue(0)]);
        using var index = new AuthorFullTextSearchIndex(new EmptySource(), 42, "primary");
        AuthorSearchContractException error = await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            new AuthorFullTextSearchQueryEvaluator(index).InspectPropertyOperandsAsync(Query(index), definitions, [operand]));
        Assert.Equal("author_search_property_not_eligible", error.Message);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(64)]
    [InlineData(65)]
    public async Task IntakeBudgetCountsOriginalClausesAndTypedOperands(int count)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition };
        var operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.equals", [new ArticlePropertyNumberValue(0)]);
        using var index = new AuthorFullTextSearchIndex(new EmptySource(), 42, "primary");
        AuthorSearchContractException error = await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            new AuthorFullTextSearchQueryEvaluator(index).InspectPropertyOperandsAsync(Query(index), definitions, Enumerable.Repeat(operand, count)));
        Assert.Equal("author_search_query_budget_invalid", error.Message);
    }

    [Fact]
    public async Task IntakeRejectsDuplicateTypedFilterAndCanonicalOperandTamper()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition };
        var operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.equals", [new ArticlePropertyNumberValue(0)]);
        using var index = new AuthorFullTextSearchIndex(new EmptySource(), 42, "primary");
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        Assert.Equal("author_search_duplicate_filter", (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            evaluator.InspectPropertyOperandsAsync(Query(index), definitions, [operand, operand]))).Message);
        Assert.Equal("author_search_property_operand_digest_invalid", (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            evaluator.InspectPropertyOperandsAsync(Query(index), definitions,
                [operand with { Values = [new ArticlePropertyNumberValue(1)] }]))).Message);
    }

    [Fact]
    public async Task IntakeRevalidationRejectsChangedOperandDefinitionAndIndex()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition };
        var operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.equals", [new ArticlePropertyNumberValue(0)]);
        using AuthorFullTextSearchIndex index = await Index();
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        AuthorSearchQuery query = Query(index);
        var intake = await evaluator.InspectPropertyOperandsAsync(query, definitions, [operand]);
        var changed = AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.equals", [new ArticlePropertyNumberValue(1)]);
        Assert.Equal("author_search_property_intake_tampered", (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            evaluator.RevalidatePropertyOperandsAsync(query, intake with
            {
                Operands = [changed]
            }, definitions))).Message);
        definitions[definition.DefinitionId] = Seal(definition with
        {
            SchemaRevision = 2
        });
        Assert.Equal("author_search_property_operand_definition_stale", (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            evaluator.RevalidatePropertyOperandsAsync(query, intake, definitions))).Message);
        definitions[definition.DefinitionId] = definition;
        while (await index.RebuildStepAsync() is not null)
        {
        }
        await Assert.ThrowsAsync<AuthorSearchContractException>(() => evaluator.RevalidatePropertyOperandsAsync(query, intake, definitions));
    }

    [Fact]
    public async Task IntakeCannotAdmitOriginalPropertyStringClauseOrCancelledRequest()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition };
        var operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.equals", [new ArticlePropertyNumberValue(0)]);
        using var index = new AuthorFullTextSearchIndex(new EmptySource(), 42, "primary");
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        AuthorSearchQuery query = AuthorFullTextSearchContract.SealQuery(Query(index) with
        {
            Clauses = [new(AuthorSearchClauseKind.Property, AuthorSearchFieldKind.Property, definition.DefinitionId, "number.equals", ["0"])]
        });
        Assert.Equal("author_search_typed_property_operand_unavailable", (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            evaluator.InspectPropertyOperandsAsync(query, definitions, [operand]))).Message);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => evaluator.InspectPropertyOperandsAsync(
            Query(index), definitions, [operand], new CancellationToken(true)));
    }

    [Theory]
    [InlineData("schema")]
    [InlineData("owner")]
    [InlineData("site")]
    [InlineData("search")]
    [InlineData("unchanged")]
    public async Task IntakeRechecksDefinitionsAfterFinalActualIndexSemaphoreWait(string change)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        var operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.equals", [new ArticlePropertyNumberValue(0)]);
        using AuthorFullTextSearchIndex index = await Index();
        AuthorSearchQuery query = Query(index);
        AuthorSearchIndexReadSnapshot before = await index.ReadSnapshotAsync(42, "primary", query.IndexInstanceId, 1);
        string beforeDigest = index.SemanticDigest();
        SemaphoreSlim gate = Assert.IsType<SemaphoreSlim>(typeof(AuthorFullTextSearchIndex)
            .GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(index));
        bool held = false;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var definitions = new WaitingDefinitions(definition, () =>
        {
            // The second lookup follows the inspector's final snapshot read. Hold
            // the real gate for the remaining RevalidateIndexAsync; change no index fact.
            Assert.True(gate.Wait(0));
            held = true;
            entered.SetResult();
        });
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        Task<AuthorSearchPropertyOperandIntake> pending = evaluator.InspectPropertyOperandsAsync(query, definitions, [operand]);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(pending.IsCompleted);
            definitions.Current = change switch
            {
                "schema" => Seal(definition with { SchemaRevision = 2 }),
                "owner" => Seal(definition with { Owner = ArticlePropertyDefinitionOwner.User(43, "primary") }),
                "site" => Seal(definition with { Owner = ArticlePropertyDefinitionOwner.User(42, "other") }),
                "search" => Seal(definition with { SearchEligible = false }),
                _ => definition
            };
            gate.Release();
            held = false;
            if (change == "unchanged")
            {
                Assert.Same(operand, Assert.Single((await pending).Operands));
            }
            else
            {
                Assert.Equal("author_search_property_operand_definition_stale",
                    (await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending)).Message);
            }
            AuthorSearchIndexReadSnapshot after = await index.ReadSnapshotAsync(42, "primary", query.IndexInstanceId, 1);
            Assert.Equal(before.IndexGeneration, after.IndexGeneration);
            Assert.Equal(before.SourceGeneration, after.SourceGeneration);
            Assert.Equal(before.RegistryDigest, after.RegistryDigest);
            Assert.Same(before.Articles, after.Articles);
            Assert.Equal(beforeDigest, index.SemanticDigest());
            Assert.True(definitions.Lookups >= 3);
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
                // Preserve the checked refusal while draining this test-owned operation.
            }
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RestartOrOverlappingInstanceCannotRebindOriginalEvaluation(bool restart)
    {
        using AuthorFullTextSearchIndex original = await Index();
        AuthorSearchQuery originalQuery = Query(original);
        var originalEvaluator = new AuthorFullTextSearchQueryEvaluator(original);
        AuthorSearchTokenEvaluation evidence = await originalEvaluator.InspectIndexAsync(originalQuery,
            new Dictionary<Guid, ArticlePropertyDefinition>());
        if (restart)
        {
            original.Dispose();
        }
        using AuthorFullTextSearchIndex replacement = await Index();
        var evaluator = new AuthorFullTextSearchQueryEvaluator(replacement);
        AuthorSearchQuery replacementQuery = Query(replacement);
        AuthorSearchTokenEvaluation fresh = await evaluator.InspectIndexAsync(replacementQuery,
            new Dictionary<Guid, ArticlePropertyDefinition>());
        Assert.Equal(evidence.IndexGeneration, fresh.IndexGeneration);
        Assert.Equal(evidence.SourceGeneration, fresh.SourceGeneration);
        Assert.Equal(evidence.SnapshotDigest, fresh.SnapshotDigest);
        Assert.NotEqual(evidence.IndexInstanceId, fresh.IndexInstanceId);
        Assert.Equal(originalQuery.IndexInstanceId, evidence.IndexInstanceId);
        Assert.Equal(replacementQuery.IndexInstanceId, fresh.IndexInstanceId);
        Assert.Equal("author_search_index_read_scope_or_generation_stale",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
                evaluator.RevalidateIndexAsync(originalQuery, evidence))).Message);
        // Resealing the request for the replacement cannot rewrite held evidence.
        Assert.Equal("author_search_query_evaluation_stale",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
                evaluator.RevalidateIndexAsync(replacementQuery, evidence with
                {
                    QueryDigest = replacementQuery.ContentDigest
                }))).Message);
        await evaluator.RevalidateIndexAsync(replacementQuery, fresh);
        await evaluator.RevalidateSourceAsync(replacementQuery, fresh, new EmptySource());
    }

    [Theory]
    [InlineData("inspect")]
    [InlineData("intake")]
    [InlineData("index")]
    [InlineData("source")]
    [InlineData("property")]
    public async Task ReplacementReadPreservesRequestIdentityAcrossActualSemaphoreAwait(string operation)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition };
        var operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.equals", [new ArticlePropertyNumberValue(0)]);
        using AuthorFullTextSearchIndex original = await Index();
        AuthorSearchQuery query = Query(original);
        var intake = await new AuthorFullTextSearchQueryEvaluator(original)
            .InspectPropertyOperandsAsync(query, definitions, [operand]);
        using AuthorFullTextSearchIndex replacement = await Index();
        Assert.Equal(original.RequireCurrentGeneration(), replacement.RequireCurrentGeneration());
        Assert.NotEqual(query.IndexInstanceId, replacement.IndexInstanceId);
        var evaluator = new AuthorFullTextSearchQueryEvaluator(replacement);
        SemaphoreSlim gate = Assert.IsType<SemaphoreSlim>(typeof(AuthorFullTextSearchIndex)
            .GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(replacement));
        await gate.WaitAsync();
        bool held = true;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        Task pending = operation switch
        {
            "inspect" => evaluator.InspectIndexAsync(query, definitions, timeout.Token),
            "intake" => evaluator.InspectPropertyOperandsAsync(query, definitions, [operand], timeout.Token),
            "index" => evaluator.RevalidateIndexAsync(query, intake.IndexEvidence, timeout.Token),
            "source" => evaluator.RevalidateSourceAsync(query, intake.IndexEvidence, new EmptySource(), timeout.Token),
            _ => evaluator.RevalidatePropertyOperandsAsync(query, intake, definitions, timeout.Token)
        };
        try
        {
            Assert.False(pending.IsCompleted);
            gate.Release();
            held = false;
            Assert.Equal("author_search_index_read_scope_or_generation_stale",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending)).Message);
            AuthorSearchQuery fresh = Query(replacement);
            var current = await evaluator.InspectPropertyOperandsAsync(fresh, definitions, [operand], timeout.Token);
            Assert.Equal(replacement.IndexInstanceId, current.IndexEvidence.IndexInstanceId);
            Assert.Equal("author_search_query_evaluation_stale",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
                    evaluator.RevalidatePropertyOperandsAsync(fresh, intake, definitions, timeout.Token))).Message);
            await evaluator.RevalidatePropertyOperandsAsync(fresh, current, definitions, timeout.Token);
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
                // Drain the test-owned read while preserving its checked refusal.
            }
        }
    }

    [Fact]
    public async Task SourceRevalidationRejectsSnapshotChangedAcrossSourceAwait()
    {
        var source = new TombstoneSource();
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        while (await index.RebuildStepAsync() is not null)
        {
        }
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        AuthorSearchQuery query = Query(index);
        var evidence = await evaluator.InspectIndexAsync(query, new Dictionary<Guid, ArticlePropertyDefinition>());
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var waiting = new WaitingSource();
        Task pending = evaluator.RevalidateSourceAsync(query, evidence, waiting, timeout.Token);
        try
        {
            await waiting.Entered.Task.WaitAsync(timeout.Token);
            Assert.False(pending.IsCompleted);
            source.Generation = 2;
            await index.ApplyAsync(1, 2, AuthorSearchIndexLifecycleEvent.Edit, timeout.Token);
            Assert.Equal(evidence.IndexGeneration + 1, index.RequireCurrentGeneration());
            Assert.Equal(evidence.IndexInstanceId, index.IndexInstanceId);
            waiting.Release.TrySetResult();
            Assert.Equal("author_search_index_read_scope_or_generation_stale",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending)).Message);
            Assert.Equal("author_search_index_read_scope_or_generation_stale",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
                    evaluator.RevalidateIndexAsync(query, evidence, timeout.Token))).Message);
            AuthorSearchQuery currentQuery = AuthorFullTextSearchContract.SealQuery(query with
            {
                IndexGeneration = index.RequireCurrentGeneration()
            });
            var fresh = await evaluator.InspectIndexAsync(currentQuery, new Dictionary<Guid, ArticlePropertyDefinition>(), timeout.Token);
            Assert.Equal(query.IndexInstanceId, fresh.IndexInstanceId);
            Assert.Equal(2, fresh.SourceGeneration);
            await evaluator.RevalidateSourceAsync(currentQuery, fresh, source, timeout.Token);
        }
        finally
        {
            waiting.Release.TrySetResult();
            try
            {
                await pending;
            }
            catch (AuthorSearchContractException)
            {
                // Drain verification even if a preceding assertion failed.
            }
        }
    }

    [Theory]
    [InlineData("schema2")]
    [InlineData("empty-query-instance")]
    [InlineData("empty-evidence-instance")]
    public async Task EvaluationRejectsLegacySchemaAndMissingInstance(string fault)
    {
        using AuthorFullTextSearchIndex index = await Index();
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition>();
        AuthorSearchQuery query = Query(index);
        var evidence = await evaluator.InspectIndexAsync(query, definitions);
        AuthorSearchQuery changed = AuthorFullTextSearchContract.SealQuery(query with
        {
            SchemaVersion = fault == "schema2" ? 2 : query.SchemaVersion,
            Schema = fault == "schema2" ? "fsusblog.author-full-text-query.v2" : query.Schema,
            IndexInstanceId = fault == "empty-query-instance" ? Guid.Empty : query.IndexInstanceId
        });
        var changedEvidence = evidence with
        {
            QueryDigest = changed.ContentDigest,
            IndexInstanceId = fault == "empty-evidence-instance" ? Guid.Empty : evidence.IndexInstanceId
        };
        Assert.Equal("author_search_query_evaluation_stale",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
                evaluator.RevalidateIndexAsync(changed, changedEvidence))).Message);
        if (fault != "empty-evidence-instance")
        {
            await Assert.ThrowsAsync<AuthorSearchContractException>(() => evaluator.InspectIndexAsync(changed, definitions));
        }
        await evaluator.RevalidateIndexAsync(query, evidence);
    }

    [Fact]
    public async Task TokenCandidatesAndSnapshotGuardsRetainOriginalSemantics()
    {
        var source = new TextSource();
        using var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        while (await index.RebuildStepAsync() is not null)
        {
        }
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition>();
        AuthorSearchQuery query = Query(index);
        var evidence = await evaluator.InspectIndexAsync(query, definitions);
        AuthorSearchTokenCandidate candidate = Assert.Single(evidence.Candidates);
        Assert.Equal(2, candidate.MatchedRanges);
        Assert.Equal(0, candidate.PhraseClauses);
        Assert.Equal(new[] { 0, 10 }, candidate.Ranges.Select(range => range.Utf16Start));
        await evaluator.RevalidateSourceAsync(query, evidence, source);
        foreach (AuthorSearchTokenEvaluation stale in new[]
        {
            evidence with { SourceGeneration = evidence.SourceGeneration + 1 },
            evidence with { SnapshotDigest = AuthorFullTextSearchContract.Digest("stale") }
        })
        {
            Assert.Equal("author_search_index_source_snapshot_stale",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
                    evaluator.RevalidateIndexAsync(query, stale))).Message);
        }
        AuthorSearchQuery phrase = AuthorFullTextSearchContract.SealQuery(query with
        {
            Clauses = AuthorFullTextSearchContract.ParseClauses("\"red green\"")
        });
        AuthorSearchTokenCandidate phraseCandidate = Assert.Single((await evaluator.InspectIndexAsync(phrase, definitions)).Candidates);
        Assert.Equal(1, phraseCandidate.PhraseClauses);
        AuthorSearchSourceRange range = Assert.Single(phraseCandidate.Ranges);
        Assert.Equal(0, range.Utf16Start);
        Assert.Equal(9, range.Utf16End);
        Assert.Equal(0, range.Utf8Start);
        Assert.Equal(9, range.Utf8End);
    }

    private static AuthorSearchIndexSourcePage TombstonePage(long generation, int afterArticleId)
        => new(generation, afterArticleId < 1
            ? [new(1, generation, true, [], new Dictionary<Guid, ArticlePropertyDefinition>())] : [], false);

    private sealed class TextSource : IAuthorFullTextSearchIndexSource
    {
        public Task<AuthorSearchIndexSourcePage> ReadAsync(int userId, string siteScope, int afterArticleId,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            const string Raw = "red green red";
            string digest = AuthorFullTextSearchContract.Digest(Raw);
            var document = AuthorFullTextSearchContract.SealDocument(new(
                AuthorFullTextSearchContract.SchemaVersion, AuthorFullTextSearchContract.DocumentSchema,
                AuthorFullTextSearchContract.TokenizerVersion, AuthorFullTextSearchContract.IndexOwner,
                new(1, userId, siteScope, 1, 1, 1, 1, "en", ArticleStatus.Draft,
                    AuthorSearchScope.CurrentArticle, AuthorSearchPermissionState.Allowed,
                    AuthorSearchVisibilityScope.AuthorOnly, AuthorFullTextSearchContract.Digest("policy")),
                new(AuthorSearchFieldKind.MarkdownBody, digest, null, null, null),
                new(AuthorFullTextSearchContract.SourceCoordinateAuthority, "algorithm-fixture-parser",
                    "document:1", 1, digest, 0, Raw.Length, 0, Raw.Length), string.Empty));
            return Task.FromResult(new AuthorSearchIndexSourcePage(1, afterArticleId < 1
                ? [new(1, 1, false, [new(document, Raw, "algorithm-fixture-parser", "document:1")],
                    new Dictionary<Guid, ArticlePropertyDefinition>())] : [], false));
        }
    }

    private sealed class TombstoneSource : IAuthorFullTextSearchIndexSource
    {
        public long Generation { get; set; } = 1;

        public Task<AuthorSearchIndexSourcePage> ReadAsync(int userId, string siteScope, int afterArticleId,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(TombstonePage(Generation, afterArticleId));
        }
    }

    private sealed class WaitingSource : IAuthorFullTextSearchIndexSource
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task<AuthorSearchIndexSourcePage> ReadAsync(int userId, string siteScope, int afterArticleId,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            Assert.Equal(1, expectedSourceGeneration);
            Entered.TrySetResult();
            await Release.Task.WaitAsync(cancellationToken);
            return TombstonePage(1, afterArticleId);
        }
    }

    private static DateTime Instant() => new(2026, 10, 13, 0, 0, 0, DateTimeKind.Utc);

    private static ArticlePropertyDefinition Definition(ArticlePropertyValueType type)
        => Seal(new(ArticlePropertyDefinitionContract.SchemaVersion, Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
            ArticlePropertyDefinitionOwner.User(42, "primary"), "property", [new("en", "Property")], type,
            ArticlePropertyCardinality.Single, false,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            null, new(), [], null, null, true, true, false, ArticlePropertyDisplayPlacement.Metadata,
            ArticlePropertyVisibilityScope.AuthorOnly, ArticlePropertyDefinitionStatus.Active, 1, Instant(), Instant(), string.Empty));

    private static ArticlePropertyDefinition Seal(ArticlePropertyDefinition definition)
        => definition with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
        };

    private static AuthorSearchQuery Query(AuthorFullTextSearchIndex index)
        => AuthorFullTextSearchContract.SealQuery(new(AuthorFullTextSearchContract.SchemaVersion,
            AuthorFullTextSearchContract.QuerySchema, AuthorFullTextSearchContract.TokenizerVersion,
            AuthorFullTextSearchContract.RankingVersion, AuthorFullTextSearchContract.IndexOwner,
            Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"), 42, "primary", 1, 1,
            AuthorSearchScope.CurrentArticle, AuthorFullTextSearchContract.ParseClauses("red"), 10, null,
            string.Empty, AuthorFullTextSearchContract.Digest("policy"), index.IndexInstanceId));

    private static async Task<AuthorFullTextSearchIndex> Index()
    {
        var index = new AuthorFullTextSearchIndex(new EmptySource(), 42, "primary");
        while (await index.RebuildStepAsync() is not null)
        {
        }
        return index;
    }

    private sealed class EmptySource : IAuthorFullTextSearchIndexSource
    {
        public Task<AuthorSearchIndexSourcePage> ReadAsync(int userId, string siteScope, int afterArticleId,
            int pageSize, long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(new AuthorSearchIndexSourcePage(1, [], false));
        }
    }

    private sealed class WaitingDefinitions(ArticlePropertyDefinition definition, Action wait)
        : IReadOnlyDictionary<Guid, ArticlePropertyDefinition>
    {
        public ArticlePropertyDefinition Current { get; set; } = definition;
        public int Lookups
        {
            get; private set;
        }
        public int Count => 1;
        public IEnumerable<Guid> Keys => [definition.DefinitionId];
        public IEnumerable<ArticlePropertyDefinition> Values => [Current];
        public ArticlePropertyDefinition this[Guid key] => key == definition.DefinitionId ? Current : throw new KeyNotFoundException();
        public bool ContainsKey(Guid key) => key == definition.DefinitionId;
        public bool TryGetValue(Guid key, out ArticlePropertyDefinition value)
        {
            Lookups++;
            value = Current;
            if (Lookups == 2)
            {
                wait();
            }
            return ContainsKey(key);
        }
        public IEnumerator<KeyValuePair<Guid, ArticlePropertyDefinition>> GetEnumerator()
            => new[] { new KeyValuePair<Guid, ArticlePropertyDefinition>(definition.DefinitionId, Current) }.AsEnumerable().GetEnumerator();
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
