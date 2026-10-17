using System.Collections.Immutable;
using System.Reflection;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Source controls for unadmitted typed intake; execution/discovery remains separately held.</summary>
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
        AuthorSearchQuery query = Query();
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
            new AuthorFullTextSearchQueryEvaluator(index).InspectPropertyOperandsAsync(Query(), definitions, [operand]));
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
            new AuthorFullTextSearchQueryEvaluator(index).InspectPropertyOperandsAsync(Query(), definitions, Enumerable.Repeat(operand, count)));
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
            evaluator.InspectPropertyOperandsAsync(Query(), definitions, [operand, operand]))).Message);
        Assert.Equal("author_search_property_operand_digest_invalid", (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            evaluator.InspectPropertyOperandsAsync(Query(), definitions,
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
        AuthorSearchQuery query = Query();
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
        AuthorSearchQuery query = AuthorFullTextSearchContract.SealQuery(Query() with
        {
            Clauses = [new(AuthorSearchClauseKind.Property, AuthorSearchFieldKind.Property, definition.DefinitionId, "number.equals", ["0"])]
        });
        Assert.Equal("author_search_typed_property_operand_unavailable", (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            evaluator.InspectPropertyOperandsAsync(query, definitions, [operand]))).Message);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => evaluator.InspectPropertyOperandsAsync(
            Query(), definitions, [operand], new CancellationToken(true)));
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
        AuthorSearchQuery query = Query();
        AuthorSearchIndexReadSnapshot before = await index.ReadSnapshotAsync(42, "primary", 1);
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
            AuthorSearchIndexReadSnapshot after = await index.ReadSnapshotAsync(42, "primary", 1);
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

    private static AuthorSearchQuery Query()
        => AuthorFullTextSearchContract.SealQuery(new(AuthorFullTextSearchContract.SchemaVersion,
            AuthorFullTextSearchContract.QuerySchema, AuthorFullTextSearchContract.TokenizerVersion,
            AuthorFullTextSearchContract.RankingVersion, AuthorFullTextSearchContract.IndexOwner,
            Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"), 42, "primary", 1, 1,
            AuthorSearchScope.CurrentArticle, AuthorFullTextSearchContract.ParseClauses("red"), 10, null,
            string.Empty, AuthorFullTextSearchContract.Digest("policy")));

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
