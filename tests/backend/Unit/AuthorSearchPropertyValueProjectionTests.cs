using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorSearchPropertyValueProjectionTests
{
    private static readonly Guid s_firstOption = Guid.Parse("00000000-0000-0000-0000-000000000001");
    private static readonly Guid s_secondOption = Guid.Parse("00000000-0000-0000-0000-000000000002");
    private static readonly DateTime s_instant = new(2026, 10, 11, 0, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData("number.equals", -1, false)]
    [InlineData("number.equals", 0, true)]
    [InlineData("number.equals", 1, false)]
    [InlineData("number.less-than", -1, true)]
    [InlineData("number.less-than", 0, false)]
    [InlineData("number.less-than", 1, false)]
    [InlineData("number.less-than-or-equal", -1, true)]
    [InlineData("number.less-than-or-equal", 0, true)]
    [InlineData("number.less-than-or-equal", 1, false)]
    [InlineData("number.greater-than", -1, false)]
    [InlineData("number.greater-than", 0, false)]
    [InlineData("number.greater-than", 1, true)]
    [InlineData("number.greater-than-or-equal", -1, false)]
    [InlineData("number.greater-than-or-equal", 0, true)]
    [InlineData("number.greater-than-or-equal", 1, true)]
    public void NumberComparisonPreservesExactZeroAndBoundary(string operation, int actual, bool expected)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        Assert.Equal(expected, Match(definition, new ArticlePropertyNumberValue(actual), operation,
            new ArticlePropertyNumberValue(0)));
    }

    [Fact]
    public void DecimalComparisonDoesNotRoundOrStringify()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        Assert.True(Match(definition, new ArticlePropertyNumberValue(0.0000000000000000000000000001m),
            "number.greater-than", new ArticlePropertyNumberValue(0)));
        Assert.False(Match(definition, new ArticlePropertyNumberValue(decimal.MaxValue),
            "number.equals", new ArticlePropertyNumberValue(decimal.MaxValue - 1)));
    }

    [Theory]
    [InlineData("date.before", -1, true)]
    [InlineData("date.before", 0, false)]
    [InlineData("date.before", 1, false)]
    [InlineData("date.on-or-before", -1, true)]
    [InlineData("date.on-or-before", 0, true)]
    [InlineData("date.on-or-before", 1, false)]
    [InlineData("date.after", -1, false)]
    [InlineData("date.after", 0, false)]
    [InlineData("date.after", 1, true)]
    [InlineData("date.on-or-after", -1, false)]
    [InlineData("date.on-or-after", 0, true)]
    [InlineData("date.on-or-after", 1, true)]
    public void DateComparisonUsesExactUtcTicks(string operation, int ticks, bool expected)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Date);
        Assert.Equal(expected, Match(definition, new ArticlePropertyDateValue(s_instant.AddTicks(ticks)),
            operation, new ArticlePropertyDateValue(s_instant)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void BooleanEqualsPreservesFalse(bool actual)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Boolean);
        Assert.True(Match(definition, new ArticlePropertyBooleanValue(actual), "boolean.equals",
            new ArticlePropertyBooleanValue(actual)));
        Assert.False(Match(definition, new ArticlePropertyBooleanValue(actual), "boolean.equals",
            new ArticlePropertyBooleanValue(!actual)));
    }

    [Fact]
    public void SelectComparisonUsesStableIdsAndAnyOfAlternatives()
    {
        ArticlePropertyDefinition single = Definition(ArticlePropertyValueType.SingleSelect);
        Assert.True(Match(single, new ArticlePropertySingleSelectValue(s_firstOption), "select.equals",
            new ArticlePropertySingleSelectValue(s_firstOption)));
        Assert.False(Match(single, new ArticlePropertySingleSelectValue(s_firstOption), "select.equals",
            new ArticlePropertySingleSelectValue(s_secondOption)));
        Assert.True(Match(single, new ArticlePropertySingleSelectValue(s_secondOption), "select.any-of",
            new ArticlePropertySingleSelectValue(s_firstOption), new ArticlePropertySingleSelectValue(s_secondOption)));
        ArticlePropertyDefinition multiple = Definition(ArticlePropertyValueType.MultiSelect);
        Assert.True(Match(multiple, new ArticlePropertyMultiSelectValue([s_firstOption, s_secondOption]),
            "select.any-of", new ArticlePropertyMultiSelectValue([s_secondOption])));
        Assert.False(Match(multiple, new ArticlePropertyMultiSelectValue([]), "select.any-of",
            new ArticlePropertyMultiSelectValue([s_secondOption])));
    }

    [Fact]
    public void ReferenceComparisonUsesIdsWithoutResolvingTargets()
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.ArticleReference);
        Assert.True(Match(definition, new ArticlePropertyArticleReferenceValue([7, 9]), "reference.any-of",
            new ArticlePropertyArticleReferenceValue([9, 11])));
        Assert.False(Match(definition, new ArticlePropertyArticleReferenceValue([]), "reference.any-of",
            new ArticlePropertyArticleReferenceValue([9])));
        ArticlePropertyDefinition single = Seal(definition with
        {
            Cardinality = ArticlePropertyCardinality.Single,
            ReferencePolicy = definition.ReferencePolicy! with
            {
                Cardinality = ArticlePropertyCardinality.Single
            }
        });
        Assert.True(Match(single, new ArticlePropertyArticleReferenceValue([7]), "reference.equals",
            new ArticlePropertyArticleReferenceValue([7])));
        Assert.True(Match(single, new ArticlePropertyArticleReferenceValue([7]), "reference.any-of",
            new ArticlePropertyArticleReferenceValue([7, 9])));
    }

    [Theory]
    [InlineData(ArticlePropertyValuePresence.Missing, true, false)]
    [InlineData(ArticlePropertyValuePresence.Null, false, false)]
    [InlineData(ArticlePropertyValuePresence.Present, false, true)]
    public void PresenceTestsExactVariants(ArticlePropertyValuePresence presence, bool missing, bool present)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        ArticlePropertyValueEntry entry = Entry(definition,
            presence == ArticlePropertyValuePresence.Present ? new ArticlePropertyNumberValue(0) : null, presence);
        AuthorSearchProjectedPropertyValue projection = AuthorSearchPropertyValueProjection.Project(definition, entry);
        Assert.Equal(missing, AuthorSearchPropertyValueProjection.Matches(definition, projection,
            AuthorFullTextSearchContract.CreatePropertyOperand(definition, "value.is-missing", [])));
        Assert.Equal(present, AuthorSearchPropertyValueProjection.Matches(definition, projection,
            AuthorFullTextSearchContract.CreatePropertyOperand(definition, "value.is-present", [])));
    }

    [Theory]
    [InlineData(ArticlePropertyValuePresence.Missing)]
    [InlineData(ArticlePropertyValuePresence.Null)]
    public void AbsentScalarComparisonExplicitlyRefuses(ArticlePropertyValuePresence presence)
    {
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Boolean);
        var projection = AuthorSearchPropertyValueProjection.Project(definition, Entry(definition, null, presence));
        var operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, "boolean.equals",
            [new ArticlePropertyBooleanValue(false)]);
        Assert.Equal("author_search_property_comparison_value_absent",
            Assert.Throws<AuthorSearchContractException>(() =>
                AuthorSearchPropertyValueProjection.Matches(definition, projection, operand)).Message);
    }

    [Fact]
    public void DefaultOriginRemainsDistinctAndMissingIsNotDefaultedHere()
    {
        ArticlePropertyDefinition definition = Seal(Definition(ArticlePropertyValueType.Number) with
        {
            Presence = new(ArticlePropertyMissingBehavior.ApplyDefault, ArticlePropertyNullBehavior.AllowNull,
                ArticlePropertyEmptyBehavior.PreserveEmpty),
            DefaultValue = new(ArticlePropertyDefaultKind.Scalar, Scalar: "0")
        });
        ArticlePropertyValueEntry explicitValue = Entry(definition, new ArticlePropertyNumberValue(0));
        ArticlePropertyValueEntry defaultValue = Entry(definition, new ArticlePropertyNumberValue(0), defaultApplied: true);
        Assert.NotEqual(explicitValue.ValueDigest, defaultValue.ValueDigest);
        Assert.True(AuthorSearchPropertyValueProjection.Project(definition, defaultValue).Entry.DefaultApplied);
        Assert.Throws<AuthorSearchContractException>(() => AuthorSearchPropertyValueProjection.Project(definition,
            Entry(definition, null, ArticlePropertyValuePresence.Missing)));
    }

    [Fact]
    public void EmptyDefaultAlreadyNormalizedToNullRetainsOrigin()
    {
        var definition = Seal(Definition(ArticlePropertyValueType.Text) with
        {
            Presence = new(ArticlePropertyMissingBehavior.ApplyDefault, ArticlePropertyNullBehavior.AllowNull,
                ArticlePropertyEmptyBehavior.TreatAsNull),
            DefaultValue = new(ArticlePropertyDefaultKind.Scalar, Scalar: "")
        });
        var entry = Entry(definition, null, ArticlePropertyValuePresence.Null, defaultApplied: true);
        Assert.Same(entry, AuthorSearchPropertyValueProjection.Project(definition, entry).Entry);
        Assert.Throws<AuthorSearchContractException>(() => AuthorSearchPropertyValueProjection.Project(definition,
            Entry(definition, new ArticlePropertyTextValue(""), defaultApplied: true)));
    }

    [Fact]
    public void CurrentConstraintsOptionsAndFilterFlagRejectStaleOrIneligibleCandidates()
    {
        var definition = Seal(Definition(ArticlePropertyValueType.Number) with
        {
            Constraints = new(MinNumber: 0, MaxNumber: 10)
        });
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => AuthorSearchPropertyValueProjection.Project(
            definition, Entry(definition, new ArticlePropertyNumberValue(-1))));
        var operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.less-than", [new ArticlePropertyNumberValue(100)]);
        var projection = AuthorSearchPropertyValueProjection.Project(definition, Entry(definition, new ArticlePropertyNumberValue(0)));
        Assert.True(AuthorSearchPropertyValueProjection.Matches(definition, projection, operand));
        Assert.Throws<AuthorSearchContractException>(() => AuthorSearchPropertyValueProjection.Matches(definition,
            projection with
            {
                Sortable = true
            }, operand));
        var unfilterable = Seal(definition with
        {
            Filterable = false
        });
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.CreatePropertyOperand(unfilterable,
            "number.equals", [new ArticlePropertyNumberValue(0)]));
        var select = Definition(ArticlePropertyValueType.SingleSelect);
        var retired = Seal(select with
        {
            Options = [select.Options[0] with { Status = ArticlePropertyOptionStatus.Deleted }, select.Options[1]]
        });
        Assert.Throws<AuthorSearchContractException>(() => AuthorSearchPropertyValueProjection.Project(retired,
            Entry(retired, new ArticlePropertySingleSelectValue(s_firstOption))));
    }

    [Fact]
    public void BetweenHasOrderedTypedPairButUndefinedEndpointSemanticsRefuse()
    {
        foreach (ArticlePropertyValueType type in new[] { ArticlePropertyValueType.Number, ArticlePropertyValueType.Date })
        {
            ArticlePropertyDefinition definition = Definition(type);
            ArticlePropertyTypedValue lower = type == ArticlePropertyValueType.Number
                ? new ArticlePropertyNumberValue(0) : new ArticlePropertyDateValue(s_instant);
            ArticlePropertyTypedValue upper = type == ArticlePropertyValueType.Number
                ? new ArticlePropertyNumberValue(1) : new ArticlePropertyDateValue(s_instant.AddTicks(1));
            string operation = type == ArticlePropertyValueType.Number ? "number.between" : "date.between";
            var operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, operation, [lower, upper]);
            AuthorFullTextSearchContract.ValidatePropertyOperand(operand, definition);
            Assert.Throws<AuthorSearchContractException>(() =>
                AuthorFullTextSearchContract.CreatePropertyOperand(definition, operation, [upper, lower]));
            Assert.Equal("author_search_property_comparison_semantics_unavailable",
                Assert.Throws<AuthorSearchContractException>(() => Match(definition, lower, operation, lower, upper)).Message);
        }
    }

    [Fact]
    public void UndefinedTextCollectionAndUrlComponentSemanticsStayUnsupported()
    {
        var text = Definition(ArticlePropertyValueType.Text);
        Assert.Throws<AuthorSearchContractException>(() => Match(text, new ArticlePropertyTextValue("café"),
            "text.equals", new ArticlePropertyTextValue("café")));
        Assert.Throws<AuthorSearchContractException>(() => Match(text, new ArticlePropertyTextValue("café"),
            "text.contains", new ArticlePropertyTextValue("fé")));
        var multiple = Definition(ArticlePropertyValueType.MultiSelect);
        Assert.Throws<AuthorSearchContractException>(() => Match(multiple, new ArticlePropertyMultiSelectValue([s_firstOption]),
            "select.equals", new ArticlePropertyMultiSelectValue([s_firstOption])));
        var reference = Definition(ArticlePropertyValueType.ArticleReference);
        Assert.Throws<AuthorSearchContractException>(() => Match(reference, new ArticlePropertyArticleReferenceValue([7]),
            "reference.equals", new ArticlePropertyArticleReferenceValue([7])));
        var url = Definition(ArticlePropertyValueType.Url);
        foreach (string operation in new[] { "url.host", "url.scheme" })
        {
            Assert.Equal("author_search_property_operand_semantics_unavailable",
                Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.CreatePropertyOperand(
                    url, operation, [new ArticlePropertyUrlValue("https://example.com/a")])).Message);
        }
    }

    [Fact]
    public void UrlEqualsUsesOnlyDefinitionCanonicalUrlWithoutFetching()
    {
        var definition = Definition(ArticlePropertyValueType.Url);
        string canonical = ArticlePropertyDefinitionContract.NormalizeUrl("https://EXAMPLE.com/A", definition.UrlPolicy!);
        Assert.True(Match(definition, new ArticlePropertyUrlValue(canonical), "url.equals", new ArticlePropertyUrlValue(canonical)));
        Assert.False(Match(definition, new ArticlePropertyUrlValue(canonical), "url.equals",
            new ArticlePropertyUrlValue("https://example.com/a")));
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => AuthorFullTextSearchContract.CreatePropertyOperand(
            definition, "url.equals", [new ArticlePropertyUrlValue("javascript:alert(1)")]));
    }

    [Fact]
    public void InvalidOperatorsTypesArityDatesOptionsAndSetsRefuse()
    {
        var number = Definition(ArticlePropertyValueType.Number);
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() =>
            AuthorFullTextSearchContract.CreatePropertyOperand(number, "number.regex", [new ArticlePropertyNumberValue(0)]));
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() =>
            AuthorFullTextSearchContract.CreatePropertyOperand(number, "boolean.equals", [new ArticlePropertyNumberValue(0)]));
        Assert.Throws<AuthorSearchContractException>(() =>
            AuthorFullTextSearchContract.CreatePropertyOperand(number, "number.equals", [new ArticlePropertyTextValue("0")]));
        Assert.Throws<AuthorSearchContractException>(() =>
            AuthorFullTextSearchContract.CreatePropertyOperand(number, "number.equals", []));
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.CreatePropertyOperand(
            Definition(ArticlePropertyValueType.Date), "date.before", [new ArticlePropertyDateValue(DateTime.SpecifyKind(s_instant, DateTimeKind.Unspecified))]));
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.CreatePropertyOperand(
            Definition(ArticlePropertyValueType.SingleSelect), "select.equals", [new ArticlePropertySingleSelectValue(Guid.Empty)]));
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.CreatePropertyOperand(
            Definition(ArticlePropertyValueType.MultiSelect), "select.any-of", [new ArticlePropertyMultiSelectValue([s_firstOption, s_firstOption])]));
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.CreatePropertyOperand(
            Definition(ArticlePropertyValueType.ArticleReference), "reference.any-of", [new ArticlePropertyArticleReferenceValue([0])]));
    }

    [Fact]
    public void OperandAndValueDigestsDetectPayloadAndVersionTamper()
    {
        var definition = Definition(ArticlePropertyValueType.Number);
        var operand = AuthorFullTextSearchContract.CreatePropertyOperand(definition, "number.equals", [new ArticlePropertyNumberValue(0)]);
        foreach (var mutation in new[]
        {
            operand with { Values = [new ArticlePropertyNumberValue(1)] },
            operand with { TokenizerVersion = "fsusblog.author-full-text-tokenizer.v2" },
            operand with { DefinitionSchemaRevision = 2 },
            operand with { OperatorId = "number.less-than" }
        })
        {
            Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ValidatePropertyOperand(mutation, definition));
        }
        ArticlePropertyValueEntry entry = Entry(definition, new ArticlePropertyNumberValue(0));
        Assert.Throws<AuthorSearchContractException>(() => AuthorSearchPropertyValueProjection.Project(definition,
            entry with
            {
                Value = new ArticlePropertyNumberValue(1)
            }));
        Assert.Throws<AuthorSearchContractException>(() => AuthorSearchPropertyValueProjection.Project(definition,
            entry with
            {
                DefinitionDigest = new string('a', 64)
            }));
    }

    [Fact]
    public void ProjectionRetainsAllEightVariantsAndFlagCombinations()
    {
        ArticlePropertyTypedValue[] values =
        [new ArticlePropertyTextValue(""), new ArticlePropertyNumberValue(0), new ArticlePropertyBooleanValue(false),
            new ArticlePropertyDateValue(s_instant), new ArticlePropertySingleSelectValue(s_firstOption),
            new ArticlePropertyMultiSelectValue([]), new ArticlePropertyArticleReferenceValue([]),
            new ArticlePropertyUrlValue("https://example.com/a")];
        for (int type = 0; type < values.Length; type++)
        {
            for (int flags = 0; flags < 8; flags++)
            {
                ArticlePropertyDefinition definition = Seal(Definition((ArticlePropertyValueType)type) with
                {
                    SearchEligible = (flags & 1) != 0,
                    Filterable = (flags & 2) != 0,
                    Sortable = (flags & 4) != 0
                });
                var projection = AuthorSearchPropertyValueProjection.Project(definition, Entry(definition, values[type]));
                Assert.Same(values[type], projection.Entry.Value);
                Assert.Equal(definition.SearchEligible, projection.SearchEligible);
                Assert.Equal(definition.Filterable, projection.Filterable);
                Assert.Equal(definition.Sortable, projection.Sortable);
            }
        }
    }

    [Fact]
    public void PropertyTextGrammarAndProductionQueryRemainUnavailable()
    {
        Assert.Equal("author_search_typed_property_operand_unavailable",
            Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ParseClauses("property:0")).Message);
        var definition = Definition(ArticlePropertyValueType.Number);
        var query = AuthorFullTextSearchContract.SealQuery(new(AuthorFullTextSearchContract.SchemaVersion,
            AuthorFullTextSearchContract.QuerySchema, AuthorFullTextSearchContract.TokenizerVersion,
            AuthorFullTextSearchContract.RankingVersion, AuthorFullTextSearchContract.IndexOwner,
            Guid.NewGuid(), 42, "site-a", 1, 1, AuthorSearchScope.CurrentArticle,
            [new(AuthorSearchClauseKind.Property, AuthorSearchFieldKind.Property, definition.DefinitionId, "number.equals", ["0"])],
            25, null, string.Empty, AuthorFullTextSearchContract.Digest("permission-policy")));
        Assert.Equal("author_search_typed_property_operand_unavailable", Assert.Throws<AuthorSearchContractException>(() =>
            AuthorFullTextSearchContract.ValidateQuery(query, new Dictionary<Guid, ArticlePropertyDefinition>
            {
                [definition.DefinitionId] = definition
            })).Message);
    }

    private static bool Match(ArticlePropertyDefinition definition, ArticlePropertyTypedValue actual,
        string operation, params ArticlePropertyTypedValue[] expected)
        => AuthorSearchPropertyValueProjection.Matches(definition,
            AuthorSearchPropertyValueProjection.Project(definition, Entry(definition, actual)),
            AuthorFullTextSearchContract.CreatePropertyOperand(definition, operation, expected));

    private static ArticlePropertyValueEntry Entry(ArticlePropertyDefinition definition, ArticlePropertyTypedValue? value,
        ArticlePropertyValuePresence presence = ArticlePropertyValuePresence.Present, bool defaultApplied = false)
    {
        var input = new ArticlePropertyValueInput(definition.DefinitionId, definition.SchemaRevision,
            definition.ContentDigest, presence, value);
        return new(input.DefinitionId, input.DefinitionSchemaRevision, input.DefinitionDigest,
            presence, value, ArticlePropertyValueDigest.ComputeValue(input, defaultApplied), defaultApplied);
    }

    private static ArticlePropertyDefinition Definition(ArticlePropertyValueType type)
    {
        bool multiple = type is ArticlePropertyValueType.MultiSelect or ArticlePropertyValueType.ArticleReference;
        return Seal(new(ArticlePropertyDefinitionContract.SchemaVersion, Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
            ArticlePropertyDefinitionOwner.User(42, "site-a"), "property", [new("en", "Property")], type,
            multiple ? ArticlePropertyCardinality.Multiple : ArticlePropertyCardinality.Single, false,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            null, new(), type is ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect
                ? [new(s_firstOption, "First", 0, ArticlePropertyOptionStatus.Active), new(s_secondOption, "Second", 1, ArticlePropertyOptionStatus.Active)] : [],
            type == ArticlePropertyValueType.ArticleReference
                ? new(ArticlePropertyCardinality.Multiple, ArticlePropertyReferencePermission.SourceActorMustReadTarget,
                    false, false, false, false, false) : null,
            type == ArticlePropertyValueType.Url ? new(["https"], false, true, 512, ArticlePropertyUrlNormalization.LowerSchemeHost) : null,
            true, true, false, ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.AuthorOnly,
            ArticlePropertyDefinitionStatus.Active, 1, s_instant, s_instant, string.Empty));
    }

    private static ArticlePropertyDefinition Seal(ArticlePropertyDefinition definition)
        => definition with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
        };
}
