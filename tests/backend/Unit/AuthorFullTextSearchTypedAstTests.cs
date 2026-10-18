using System.Collections;
using System.Reflection;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorFullTextSearchTypedAstTests
{
    [Fact]
    public void TypedPresenceWireNodeBelongsToTheCanonicalQueryAst()
    {
        var definition = Definition();
        var operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, "value.is-present", []);
        string wire = JsonSerializer.Serialize(new
        {
            Kind = AuthorSearchClauseKind.Property,
            Field = AuthorSearchFieldKind.Property,
            PropertyDefinitionId = definition.DefinitionId,
            Operator = operand.OperatorId,
            Values = Array.Empty<string>(),
            PropertyOperand = operand
        });
        AuthorSearchClause clause = JsonSerializer.Deserialize<AuthorSearchClause>(wire)!;
        AuthorFullTextSearchContract.ValidateQuery(Query(clause),
            new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition });
    }

    [Fact]
    public void TypedQueryWireCannotRetainTheLegacyV3Schema()
        => Assert.NotEqual("fsusblog.author-full-text-query.v3", AuthorFullTextSearchContract.QuerySchema);

    private static readonly Guid s_optionA = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid s_optionB = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly DateTime s_instant = new(2026, 10, 18, 0, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData(ArticlePropertyValueType.Text)]
    [InlineData(ArticlePropertyValueType.Number)]
    [InlineData(ArticlePropertyValueType.Boolean)]
    [InlineData(ArticlePropertyValueType.Date)]
    [InlineData(ArticlePropertyValueType.SingleSelect)]
    [InlineData(ArticlePropertyValueType.MultiSelect)]
    [InlineData(ArticlePropertyValueType.ArticleReference)]
    [InlineData(ArticlePropertyValueType.Url)]
    public void AllOriginalPayloadsParseSealAndRoundTripInsideTheSameAst(ArticlePropertyValueType type)
    {
        ArticlePropertyDefinition definition = Definition(type);
        var operand = Operand(definition);
        var query = Query(AuthorFullTextSearchContract.ParseClauses("needle", [operand]).ToArray());
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition };
        AuthorFullTextSearchContract.ValidateQuery(query, definitions);
        string wire = JsonSerializer.Serialize(query);
        AuthorSearchQuery parsed = JsonSerializer.Deserialize<AuthorSearchQuery>(wire)!;
        AuthorSearchPropertyOperand actual = parsed.Clauses[1].PropertyOperand!;
        Assert.Equal(operand.Values[0].GetType(), actual.Values[0].GetType());
        Assert.Equal(operand.ContentDigest, actual.ContentDigest);
        Assert.Equal(query.ContentDigest, AuthorFullTextSearchContract.SealQuery(parsed).ContentDigest);
        AuthorFullTextSearchContract.ValidateQuery(parsed, definitions);
        Assert.Empty(parsed.Clauses[1].Values);
        Assert.Equal("needle", Assert.Single(parsed.Clauses[0].Values));
    }

    [Theory]
    [InlineData("value")]
    [InlineData("definition-id")]
    [InlineData("schema")]
    [InlineData("definition-digest")]
    [InlineData("clause-order")]
    [InlineData("value-order")]
    [InlineData("borrowed-digest")]
    public void TypedValuesDefinitionsAndOrderChangeQueryDigestAndInvalidateCursor(string change)
    {
        ArticlePropertyDefinition definition = Definition(change == "value-order"
            ? ArticlePropertyValueType.SingleSelect : ArticlePropertyValueType.Number);
        var operand = change == "value-order"
            ? AuthorFullTextSearchContract.CreatePropertyOperand(definition, "select.any-of",
                [new ArticlePropertySingleSelectValue(s_optionA), new ArticlePropertySingleSelectValue(s_optionB)])
            : Operand(definition);
        AuthorSearchQuery original = Query(AuthorFullTextSearchContract.ParseClauses("needle", [operand]).ToArray());
        var oldCursor = AuthorFullTextSearchContract.SealCursor(new(AuthorFullTextSearchContract.SchemaVersion,
            AuthorFullTextSearchContract.QueryContextDigest(original), original.PermissionRevision, original.IndexGeneration,
            1, AuthorSearchFieldKind.Title, 0, string.Empty, original.IndexInstanceId));
        ArticlePropertyDefinition current = Seal(change switch
        {
            "definition-id" => definition with { DefinitionId = Guid.NewGuid() },
            "schema" => definition with { SchemaRevision = 2 },
            "definition-digest" => definition with { MachineKey = "renamed" },
            _ => definition
        });
        var changedOperand = change switch
        {
            "value" => AuthorFullTextSearchContract.CreatePropertyOperand(current, "number.equals", [new ArticlePropertyNumberValue(1)]),
            "value-order" => AuthorFullTextSearchContract.CreatePropertyOperand(current, "select.any-of", operand.Values.Reverse()),
            "borrowed-digest" => operand with { Values = [new ArticlePropertyNumberValue(1)] },
            _ => Operand(current)
        };
        var clauses = AuthorFullTextSearchContract.ParseClauses("needle", [changedOperand]);
        if (change == "clause-order")
        {
            clauses = [.. clauses.Reverse()];
        }
        AuthorSearchQuery changed = AuthorFullTextSearchContract.SealQuery(original with
        {
            Clauses = clauses
        });
        Assert.NotEqual(original.ContentDigest, changed.ContentDigest);
        Assert.NotEqual(oldCursor.QueryContextDigest, AuthorFullTextSearchContract.QueryContextDigest(changed));
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [current.DefinitionId] = current };
        if (change != "borrowed-digest")
        {
            AuthorFullTextSearchContract.ValidateQuery(changed, definitions);
        }
        else
        {
            Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ValidateQuery(changed, definitions));
        }
        Assert.Equal("author_search_cursor_invalid_or_stale", Assert.Throws<AuthorSearchContractException>(() =>
            AuthorFullTextSearchContract.ValidateQuery(AuthorFullTextSearchContract.SealQuery(changed with
            {
                Cursor = oldCursor
            }), definitions)).Message);
    }

    [Theory]
    [InlineData("missing-number")]
    [InlineData("number-string")]
    [InlineData("wrong-type")]
    [InlineData("extra")]
    [InlineData("duplicate")]
    [InlineData("null-values")]
    public void WireBindingRejectsMissingDefaultedAndUnrecognizedPayloads(string fault)
    {
        string wire = JsonSerializer.Serialize(Operand(Definition()));
        wire = fault switch
        {
            "missing-number" => wire.Replace("{\"Number\":0}", "{}", StringComparison.Ordinal),
            "number-string" => wire.Replace("\"Number\":0", "\"Number\":\"0\"", StringComparison.Ordinal),
            "wrong-type" => wire.Replace("\"Number\":0", "\"Boolean\":false", StringComparison.Ordinal),
            "extra" => wire.Replace("\"Number\":0", "\"Number\":0,\"Unknown\":0", StringComparison.Ordinal),
            "duplicate" => wire.Replace("\"Number\":0", "\"Number\":0,\"Number\":1", StringComparison.Ordinal),
            _ => wire.Replace("[{\"Number\":0}]", "null", StringComparison.Ordinal)
        };
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AuthorSearchPropertyOperand>(wire));
    }

    [Theory]
    [InlineData("strings")]
    [InlineData("non-property")]
    [InlineData("definition")]
    [InlineData("operator")]
    [InlineData("field")]
    public void TypedNodeCannotSmuggleStringsOrConflictingClauseCoordinates(string fault)
    {
        var definition = Definition();
        var clause = AuthorFullTextSearchContract.ParseClauses(string.Empty, [Operand(definition)])[0];
        clause = fault switch
        {
            "strings" => clause with { Values = ["0"] },
            "non-property" => clause with { Kind = AuthorSearchClauseKind.PlainText, Values = ["needle"] },
            "definition" => clause with { PropertyDefinitionId = Guid.NewGuid() },
            "operator" => clause with { Operator = "number.greater-than" },
            _ => clause with { Field = AuthorSearchFieldKind.Title }
        };
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ValidateQuery(Query(clause),
            new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition }));
    }

    [Theory]
    [InlineData(ArticlePropertyValueType.Text)]
    [InlineData(ArticlePropertyValueType.Number)]
    [InlineData(ArticlePropertyValueType.Boolean)]
    [InlineData(ArticlePropertyValueType.Date)]
    [InlineData(ArticlePropertyValueType.SingleSelect)]
    [InlineData(ArticlePropertyValueType.MultiSelect)]
    [InlineData(ArticlePropertyValueType.ArticleReference)]
    [InlineData(ArticlePropertyValueType.Url)]
    public async Task CanonicalAstExecutesOriginalSupportedPredicatesAgainstActualIndexedValues(ArticlePropertyValueType type)
    {
        ArticlePropertyDefinition definition = Definition(type);
        var source = new Source([Article(definition, Value(type))]);
        using AuthorFullTextSearchIndex index = await Index(source);
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition };
        var match = ConsumerOperand(definition, true);
        AuthorSearchQuery query = OnIndex(index, match);
        Assert.Equal(1, Assert.Single((await evaluator.InspectIndexAsync(query, definitions)).Candidates).Document.Identity.ArticleId);
        await evaluator.RevalidateSourceAsync(query, await evaluator.InspectIndexAsync(query, definitions), source);
        Assert.Empty((await evaluator.InspectIndexAsync(OnIndex(index, ConsumerOperand(definition, false)), definitions)).Candidates);
        Assert.Equal("author_search_indexed_facts_stale_or_invalid",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() => evaluator.InspectIndexAsync(
                AuthorFullTextSearchContract.SealQuery(query with
                {
                    PermissionRevision = 2
                }), definitions))).Message);
    }

    [Fact]
    public async Task TypedPredicateRunsBeforePageTrimmingAndPreservesMissingVersusUnavailable()
    {
        ArticlePropertyDefinition definition = Definition();
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition };
        using AuthorFullTextSearchIndex index = await Index(new Source([
            Article(definition, new ArticlePropertyNumberValue(0)), Article(definition, new ArticlePropertyNumberValue(1), 2)]));
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        var query = AuthorFullTextSearchContract.SealQuery(OnIndex(index,
            AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.equals", [new ArticlePropertyNumberValue(1)])) with
        {
            PageSize = 1
        });
        Assert.Equal(2, Assert.Single((await evaluator.InspectIndexAsync(query, definitions)).Candidates).Document.Identity.ArticleId);
        using AuthorFullTextSearchIndex missing = await Index(new Source([Article(definition, null)]));
        var missingEvaluator = new AuthorFullTextSearchQueryEvaluator(missing);
        Assert.Single((await missingEvaluator.InspectIndexAsync(OnIndex(missing,
            AuthorFullTextSearchContract.CreatePropertyOperand(definition, "value.is-missing", [])), definitions)).Candidates);
        Assert.Equal("author_search_property_comparison_value_absent", (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            missingEvaluator.InspectIndexAsync(OnIndex(missing, Operand(definition)), definitions))).Message);
        using AuthorFullTextSearchIndex unavailable = await Index(new Source([Article(definition, null) with { PropertyValues = null }]));
        Assert.Equal("author_search_property_snapshot_unavailable", (await Assert.ThrowsAsync<AuthorSearchContractException>(() =>
            new AuthorFullTextSearchQueryEvaluator(unavailable).InspectIndexAsync(OnIndex(unavailable,
                AuthorFullTextSearchContract.CreatePropertyOperand(definition, "value.is-missing", [])), definitions))).Message);
    }

    [Theory]
    [InlineData("text")]
    [InlineData("between")]
    [InlineData("date-between")]
    [InlineData("collection")]
    [InlineData("reference")]
    public async Task UndefinedSemanticsAndReferenceAuthorityRefuseEvenOnEmptyCorpus(string operation)
    {
        ArticlePropertyDefinition definition = Definition(operation switch
        {
            "text" => ArticlePropertyValueType.Text,
            "date-between" => ArticlePropertyValueType.Date,
            "collection" => ArticlePropertyValueType.MultiSelect,
            "reference" => ArticlePropertyValueType.ArticleReference,
            _ => ArticlePropertyValueType.Number
        });
        var operand = operation switch
        {
            "between" => AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.between", [new ArticlePropertyNumberValue(0), new ArticlePropertyNumberValue(1)]),
            "date-between" => AuthorFullTextSearchContract.CreatePropertyOperand(definition, "date.between", [new ArticlePropertyDateValue(s_instant), new ArticlePropertyDateValue(s_instant.AddDays(1))]),
            _ => Operand(definition, nonemptyReference: operation == "reference")
        };
        using AuthorFullTextSearchIndex index = await Index(new Source([]));
        Assert.Equal(operation == "reference" ? "author_search_property_reference_authority_unavailable"
            : "author_search_property_comparison_semantics_unavailable",
            (await Assert.ThrowsAsync<AuthorSearchContractException>(() => new AuthorFullTextSearchQueryEvaluator(index)
                .InspectIndexAsync(OnIndex(index, operand), new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition }))).Message);
    }

    [Fact]
    public void OriginalGrammarBudgetAndUrlComponentRefusalsRemain()
    {
        var operand = Operand(Definition());
        Assert.Equal(64, AuthorFullTextSearchContract.ParseClauses("needle", Enumerable.Repeat(operand, 63)).Length);
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ParseClauses("needle", Enumerable.Repeat(operand, 64)));
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ParseClauses("property:0", [operand]));
        var url = Definition(ArticlePropertyValueType.Url);
        foreach (string operation in new[] { "url.host", "url.scheme" })
        {
            Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.CreatePropertyOperand(url, operation,
                [new ArticlePropertyUrlValue("https://example.com/needle")]));
        }
        var text = Definition(ArticlePropertyValueType.Text);
        var large = AuthorFullTextSearchContract.CreatePropertyOperand(text, "text.equals",
            [new ArticlePropertyTextValue(new string('a', AuthorFullTextSearchContract.MaxQueryCharacters))]);
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ValidateQuery(
            Query(AuthorFullTextSearchContract.ParseClauses("needle", [large]).ToArray()),
            new Dictionary<Guid, ArticlePropertyDefinition> { [text.DefinitionId] = text }));
        var query = Query(AuthorFullTextSearchContract.ParseClauses("needle").ToArray());
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ValidateQuery(
            AuthorFullTextSearchContract.SealQuery(query with
            {
                SchemaVersion = 3,
                Schema = "fsusblog.author-full-text-query.v3"
            }),
            new Dictionary<Guid, ArticlePropertyDefinition>()));
    }

    [Theory]
    [InlineData("schema")]
    [InlineData("owner")]
    [InlineData("filter")]
    [InlineData("search")]
    [InlineData("unchanged")]
    [InlineData("cancel")]
    public async Task TypedDefinitionAndCancellationAreRecheckedAfterActualFinalIndexAwait(string change)
    {
        ArticlePropertyDefinition definition = Definition();
        using AuthorFullTextSearchIndex index = await Index(new Source([Article(definition, new ArticlePropertyNumberValue(0))]));
        var gate = Assert.IsType<SemaphoreSlim>(typeof(AuthorFullTextSearchIndex)
            .GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(index));
        bool held = false;
        var definitions = new WaitingDefinitions(definition, () =>
        {
            Assert.True(gate.Wait(0));
            held = true;
        });
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        Task<AuthorSearchTokenEvaluation> pending = new AuthorFullTextSearchQueryEvaluator(index)
            .InspectIndexAsync(OnIndex(index, Operand(definition)), definitions, timeout.Token);
        try
        {
            Assert.True(held);
            Assert.False(pending.IsCompleted);
            definitions.Current = Seal(change switch
            {
                "schema" => definition with { SchemaRevision = 2 },
                "owner" => definition with { Owner = ArticlePropertyDefinitionOwner.User(43, "primary") },
                "filter" => definition with { Filterable = false },
                "search" => definition with { SearchEligible = false },
                _ => definition
            });
            if (change == "cancel")
            {
                timeout.Cancel();
            }
            gate.Release();
            held = false;
            if (change == "unchanged")
            {
                Assert.Single((await pending).Candidates);
            }
            else if (change == "cancel")
            {
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
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
                // Drain the test-owned refused inspection.
            }
            catch (OperationCanceledException)
            {
                // This test owns and disposes the cancellation source.
            }
        }
    }

    [Fact]
    public async Task TypedQueryCannotReplaceItsRequestedIncarnationAcrossAnActualAwait()
    {
        ArticlePropertyDefinition definition = Definition();
        var source = new Source([Article(definition, new ArticlePropertyNumberValue(0))]);
        using AuthorFullTextSearchIndex first = await Index(source);
        using AuthorFullTextSearchIndex replacement = await Index(source);
        var query = OnIndex(first, Operand(definition));
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition };
        var gate = Assert.IsType<SemaphoreSlim>(typeof(AuthorFullTextSearchIndex)
            .GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(replacement));
        await gate.WaitAsync();
        bool held = true;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        Task<AuthorSearchTokenEvaluation> pending = new AuthorFullTextSearchQueryEvaluator(replacement)
            .InspectIndexAsync(query, definitions, timeout.Token);
        try
        {
            Assert.False(pending.IsCompleted);
            Assert.Equal(first.RequireCurrentGeneration(), replacement.RequireCurrentGeneration());
            gate.Release();
            held = false;
            Assert.Equal("author_search_index_read_scope_or_generation_stale",
                (await Assert.ThrowsAsync<AuthorSearchContractException>(() => pending)).Message);
            Assert.Single((await new AuthorFullTextSearchQueryEvaluator(replacement)
                .InspectIndexAsync(OnIndex(replacement, Operand(definition)), definitions, timeout.Token)).Candidates);
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
                // Preserve the requested incarnation while draining this read.
            }
        }
    }

    private sealed class WaitingDefinitions(ArticlePropertyDefinition definition, Action wait)
        : IReadOnlyDictionary<Guid, ArticlePropertyDefinition>
    {
        public ArticlePropertyDefinition Current { get; set; } = definition;
        private int _lookups;
        public int Count => 1;
        public IEnumerable<Guid> Keys => [Current.DefinitionId];
        public IEnumerable<ArticlePropertyDefinition> Values => [Current];
        public ArticlePropertyDefinition this[Guid key] => Current;
        public bool ContainsKey(Guid key) => key == Current.DefinitionId;
        public bool TryGetValue(Guid key, out ArticlePropertyDefinition value)
        {
            value = Current;
            if (++_lookups == 5)
            {
                wait();
            }
            return ContainsKey(key);
        }
        public IEnumerator<KeyValuePair<Guid, ArticlePropertyDefinition>> GetEnumerator()
            => new[] { new KeyValuePair<Guid, ArticlePropertyDefinition>(Current.DefinitionId, Current) }.AsEnumerable().GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ClosedQueryAndClauseWireRejectUnrecognizedMembers(bool clause)
    {
        var query = Query(AuthorFullTextSearchContract.ParseClauses("needle").ToArray());
        string wire = clause ? JsonSerializer.Serialize(query.Clauses[0]) : JsonSerializer.Serialize(query);
        wire = wire[..^1] + ",\"Unknown\":0}";
        if (clause)
        {
            Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AuthorSearchClause>(wire));
        }
        else
        {
            Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AuthorSearchQuery>(wire));
        }
    }

    [Theory]
    [InlineData(ArticlePropertyValuePresence.Missing)]
    [InlineData(ArticlePropertyValuePresence.Null)]
    [InlineData(ArticlePropertyValuePresence.Present)]
    public async Task CanonicalPresenceKeepsMissingNullAndFalseDistinct(ArticlePropertyValuePresence presence)
    {
        var definition = Definition(ArticlePropertyValueType.Boolean);
        using AuthorFullTextSearchIndex index = await Index(new Source([Article(definition,
            presence == ArticlePropertyValuePresence.Present ? new ArticlePropertyBooleanValue(false) : null, presence: presence)]));
        var evaluator = new AuthorFullTextSearchQueryEvaluator(index);
        var definitions = new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition };
        foreach (string operation in new[] { "value.is-missing", "value.is-present" })
        {
            var evaluated = await evaluator.InspectIndexAsync(OnIndex(index,
                AuthorFullTextSearchContract.CreatePropertyOperand(definition, operation, [])), definitions);
            bool expected = operation == "value.is-missing" ? presence == ArticlePropertyValuePresence.Missing
                : presence == ArticlePropertyValuePresence.Present;
            Assert.Equal(expected ? 1 : 0, evaluated.Candidates.Length);
        }
    }

    [Fact]
    public void MissingClauseDiscriminatorCannotDefaultToPlainText()
    {
        var clause = AuthorFullTextSearchContract.ParseClauses("needle")[0];
        string wire = JsonSerializer.Serialize(clause).Replace("\"Kind\":0,", string.Empty, StringComparison.Ordinal);
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<AuthorSearchClause>(wire));
    }

    private static ArticlePropertyDefinition Definition(ArticlePropertyValueType type = ArticlePropertyValueType.Number)
    {
        bool multiple = type is ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference;
        return Seal(new(ArticlePropertyDefinitionContract.SchemaVersion,
            Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), ArticlePropertyDefinitionOwner.User(42, "primary"),
            "property", [new("en", "Property")], type, multiple ? ArticlePropertyCardinality.Multiple : ArticlePropertyCardinality.Single, false,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull,
                ArticlePropertyEmptyBehavior.PreserveEmpty), null, new(), type is ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect
                ? [new(s_optionA, "First", 0, ArticlePropertyOptionStatus.Active), new(s_optionB, "Second", 1, ArticlePropertyOptionStatus.Active)] : [],
            type == ArticlePropertyValueType.ArticleReference
                ? new(ArticlePropertyCardinality.Multiple, ArticlePropertyReferencePermission.SourceActorMustReadTarget, false, false, false, false, false) : null,
            type == ArticlePropertyValueType.Url ? new(["https"], false, true, 512, ArticlePropertyUrlNormalization.LowerSchemeHost) : null,
            true, true, false, ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.AuthorOnly,
            ArticlePropertyDefinitionStatus.Active, 1, s_instant, s_instant, string.Empty));
    }

    private static ArticlePropertyDefinition Seal(ArticlePropertyDefinition definition)
        => definition with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
        };

    private static ArticlePropertyTypedValue Value(ArticlePropertyValueType type, bool other = false)
        => type switch
        {
            ArticlePropertyValueType.Text => new ArticlePropertyTextValue(other ? "other" : "needle"),
            ArticlePropertyValueType.Number => new ArticlePropertyNumberValue(other ? 1 : 0),
            ArticlePropertyValueType.Boolean => new ArticlePropertyBooleanValue(other),
            ArticlePropertyValueType.Date => new ArticlePropertyDateValue(other ? s_instant.AddDays(1) : s_instant),
            ArticlePropertyValueType.SingleSelect => new ArticlePropertySingleSelectValue(other ? s_optionB : s_optionA),
            ArticlePropertyValueType.MultiSelect => new ArticlePropertyMultiSelectValue([other ? s_optionB : s_optionA]),
            ArticlePropertyValueType.ArticleReference => new ArticlePropertyArticleReferenceValue([]),
            ArticlePropertyValueType.Url => new ArticlePropertyUrlValue(other ? "https://example.com/other" : "https://example.com/needle"),
            _ => throw new ArgumentOutOfRangeException(nameof(type))
        };

    private static AuthorSearchPropertyOperand Operand(ArticlePropertyDefinition definition, bool nonemptyReference = false)
        => AuthorFullTextSearchContract.CreatePropertyOperand(definition, definition.ValueType switch
        {
            ArticlePropertyValueType.Text => "text.equals",
            ArticlePropertyValueType.Number => "number.equals",
            ArticlePropertyValueType.Boolean => "boolean.equals",
            ArticlePropertyValueType.Date => "date.before",
            ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect => "select.equals",
            ArticlePropertyValueType.ArticleReference => "reference.any-of",
            ArticlePropertyValueType.Url => "url.equals",
            _ => throw new ArgumentOutOfRangeException(nameof(definition))
        }, [nonemptyReference ? new ArticlePropertyArticleReferenceValue([7]) : Value(definition.ValueType)]);

    private static AuthorSearchPropertyOperand ConsumerOperand(ArticlePropertyDefinition definition, bool match)
        => AuthorFullTextSearchContract.CreatePropertyOperand(definition, definition.ValueType switch
        {
            ArticlePropertyValueType.Text or ArticlePropertyValueType.ArticleReference => match ? "value.is-present" : "value.is-missing",
            ArticlePropertyValueType.Number => "number.equals",
            ArticlePropertyValueType.Boolean => "boolean.equals",
            ArticlePropertyValueType.Date => "date.before",
            ArticlePropertyValueType.SingleSelect => "select.equals",
            ArticlePropertyValueType.MultiSelect => "select.any-of",
            ArticlePropertyValueType.Url => "url.equals",
            _ => throw new ArgumentOutOfRangeException(nameof(definition))
        }, definition.ValueType is ArticlePropertyValueType.Text or ArticlePropertyValueType.ArticleReference ? []
            : definition.ValueType == ArticlePropertyValueType.Date
                ? [new ArticlePropertyDateValue(match ? s_instant.AddDays(1) : s_instant.AddDays(-1))]
                : [Value(definition.ValueType, !match)]);

    private static AuthorSearchQuery Query(params AuthorSearchClause[] clauses)
        => AuthorFullTextSearchContract.SealQuery(new(AuthorFullTextSearchContract.QuerySchemaVersion,
            AuthorFullTextSearchContract.QuerySchema, AuthorFullTextSearchContract.TokenizerVersion,
            AuthorFullTextSearchContract.RankingVersion, AuthorFullTextSearchContract.IndexOwner,
            Guid.NewGuid(), 42, "primary", 1, 1, AuthorSearchScope.CurrentArticle, [.. clauses], 10, null,
            string.Empty, AuthorFullTextSearchContract.Digest("policy"), Guid.NewGuid()));

    private static AuthorSearchQuery OnIndex(AuthorFullTextSearchIndex index, AuthorSearchPropertyOperand operand)
        => AuthorFullTextSearchContract.SealQuery(Query(AuthorFullTextSearchContract.ParseClauses("needle", [operand]).ToArray()) with
        {
            IndexInstanceId = index.IndexInstanceId
        });

    private static AuthorSearchIndexArticleSource Article(ArticlePropertyDefinition definition, ArticlePropertyTypedValue? value, int id = 1, ArticlePropertyValuePresence? presence = null)
    {
        var input = new ArticlePropertyValueInput(definition.DefinitionId, definition.SchemaRevision, definition.ContentDigest,
            presence ?? (value is null ? ArticlePropertyValuePresence.Missing : ArticlePropertyValuePresence.Present), value);
        var entry = new ArticlePropertyValueEntry(input.DefinitionId, input.DefinitionSchemaRevision, input.DefinitionDigest,
            input.Presence, input.Value, ArticlePropertyValueDigest.ComputeValue(input));
        var coordinates = new ArticlePropertySnapshotCoordinates(42, "primary", id, 1, 1);
        var snapshot = new ArticlePropertyValueSnapshot(ArticlePropertyValueSnapshot.CurrentSchemaVersion, coordinates, [entry],
            ArticlePropertyValueDigest.ComputeSnapshot(coordinates, [entry]));
        const string Raw = "needle";
        string digest = AuthorFullTextSearchContract.Digest(Raw);
        var document = AuthorFullTextSearchContract.SealDocument(new(AuthorFullTextSearchContract.SchemaVersion,
            AuthorFullTextSearchContract.DocumentSchema, AuthorFullTextSearchContract.TokenizerVersion, AuthorFullTextSearchContract.IndexOwner,
            new(id, 42, "primary", 1, 1, 1, 1, "en", ArticleStatus.Draft, AuthorSearchScope.CurrentArticle,
                AuthorSearchPermissionState.Allowed, AuthorSearchVisibilityScope.AuthorOnly, AuthorFullTextSearchContract.Digest("policy")),
            new(AuthorSearchFieldKind.Title, digest, null, null, null),
            new(AuthorFullTextSearchContract.SourceCoordinateAuthority, "algorithm-fixture-parser", "document:1", 1,
                digest, 0, Raw.Length, 0, Encoding.UTF8.GetByteCount(Raw)), string.Empty));
        return new(id, 1, false, [new(document, Raw, "algorithm-fixture-parser", "document:1")],
            new Dictionary<Guid, ArticlePropertyDefinition> { [definition.DefinitionId] = definition }, snapshot);
    }

    private static async Task<AuthorFullTextSearchIndex> Index(Source source)
    {
        var index = new AuthorFullTextSearchIndex(source, 42, "primary");
        while (await index.RebuildStepAsync() is not null)
        {
        }
        return index;
    }

    private sealed class Source(IReadOnlyList<AuthorSearchIndexArticleSource> articles) : IAuthorFullTextSearchIndexSource
    {
        public Task<AuthorSearchIndexSourcePage> ReadAsync(int userId, string siteScope, int afterArticleId, int pageSize,
            long? expectedSourceGeneration, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var page = articles.Where(article => article.ArticleId > afterArticleId).Take(pageSize).ToArray();
            return Task.FromResult(new AuthorSearchIndexSourcePage(1, [.. page], articles.Count > 0 && page.Length > 0 && page[^1].ArticleId < articles[^1].ArticleId));
        }
    }
}
