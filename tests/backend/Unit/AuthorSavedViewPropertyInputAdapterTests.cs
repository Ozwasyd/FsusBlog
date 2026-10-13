using System.Globalization;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthorSavedViewPropertyInputAdapterTests
{
    private static readonly AuthorSavedViewOwner s_owner = new(42, "https://site.test");
    private static readonly Guid s_firstOption = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1");
    private static readonly Guid s_secondOption = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2");

    [Theory]
    [InlineData("0")]
    [InlineData("-1.25")]
    [InlineData("79228162514264337593543950335")]
    [InlineData("0.0000000000000000000000000001")]
    public async Task NumberEqualsRetainsExactCanonicalDecimal(string value)
    {
        BindingFixture fixture = await CreateAsync("property.equals", [value]);
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        AuthorSavedViewCanonicalPropertyOperandCandidate candidate = Bind(fixture, definition);
        Assert.Equal("number.equals", candidate.Operand.OperatorId);
        Assert.Equal(decimal.Parse(value, NumberStyles.Number, CultureInfo.InvariantCulture),
            Assert.IsType<ArticlePropertyNumberValue>(Assert.Single(candidate.Operand.Values)).Number);
        Assert.Equal(fixture.Plan.ContentDigest, candidate.PlanContentDigest);
        Assert.Equal("observed-property-authority", candidate.DependencyAuthorityRevision);
        Assert.Equal(definition.DefinitionId, candidate.Operand.DefinitionId);
        Assert.Equal(definition.SchemaRevision, candidate.Operand.DefinitionSchemaRevision);
        Assert.Equal(definition.ContentDigest, candidate.Operand.DefinitionDigest);
        Assert.Equal(AuthorSavedViewPropertyInputAdapter.DefinitionBindingUnavailable, candidate.UnavailableReason);
        AuthorFullTextSearchContract.ValidatePropertyOperand(candidate.Operand, definition);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BooleanEqualsNeverConflatesFalseWithMissing(bool value)
    {
        BindingFixture fixture = await CreateAsync("property.equals", [value ? "true" : "false"]);
        AuthorSavedViewCanonicalPropertyOperandCandidate candidate = Bind(fixture, Definition(ArticlePropertyValueType.Boolean));
        Assert.Equal("boolean.equals", candidate.Operand.OperatorId);
        Assert.Equal(value, Assert.IsType<ArticlePropertyBooleanValue>(Assert.Single(candidate.Operand.Values)).Boolean);
        Assert.Single(candidate.Condition.Values);
    }

    [Fact]
    public async Task SelectMappingsRetainStableOptionIdsAndOwnerSetShape()
    {
        BindingFixture equality = await CreateAsync("property.equals", [s_firstOption.ToString("D")]);
        AuthorSavedViewCanonicalPropertyOperandCandidate equal = Bind(equality, Definition(ArticlePropertyValueType.SingleSelect));
        Assert.Equal("select.equals", equal.Operand.OperatorId);
        Assert.Equal(s_firstOption, Assert.IsType<ArticlePropertySingleSelectValue>(Assert.Single(equal.Operand.Values)).OptionId);

        BindingFixture alternatives = await CreateAsync("property.any-of",
            [s_secondOption.ToString("D"), s_firstOption.ToString("D")]);
        AuthorSavedViewCanonicalPropertyOperandCandidate single = Bind(alternatives, Definition(ArticlePropertyValueType.SingleSelect));
        Assert.Equal("select.any-of", single.Operand.OperatorId);
        Assert.Equal(new[] { s_firstOption, s_secondOption },
            single.Operand.Values.Select(value => Assert.IsType<ArticlePropertySingleSelectValue>(value).OptionId));
        AuthorSavedViewCanonicalPropertyOperandCandidate multiple = Bind(alternatives, Definition(ArticlePropertyValueType.MultiSelect));
        Assert.Equal("select.any-of", multiple.Operand.OperatorId);
        Assert.Equal(new[] { s_firstOption, s_secondOption },
            Assert.IsType<ArticlePropertyMultiSelectValue>(Assert.Single(multiple.Operand.Values)).OptionIds);
        Assert.Equal(alternatives.Plan.Query.Conditions[0].Values, multiple.Condition.Values);
    }

    [Fact]
    public async Task ReferenceMappingsUseCanonicalIdsWithoutResolvingTargets()
    {
        ArticlePropertyDefinition singleDefinition = Definition(ArticlePropertyValueType.ArticleReference, singleReferences: true);
        BindingFixture equality = await CreateAsync("property.equals", ["7"]);
        AuthorSavedViewCanonicalPropertyOperandCandidate equal = Bind(equality, singleDefinition);
        Assert.Equal("reference.equals", equal.Operand.OperatorId);
        Assert.Equal(7, Assert.Single(Assert.IsType<ArticlePropertyArticleReferenceValue>(Assert.Single(equal.Operand.Values)).ArticleIds));

        BindingFixture alternatives = await CreateAsync("property.any-of", ["2", "10"]);
        foreach (ArticlePropertyDefinition definition in new[] { singleDefinition, Definition(ArticlePropertyValueType.ArticleReference) })
        {
            AuthorSavedViewCanonicalPropertyOperandCandidate candidate = Bind(alternatives, definition);
            Assert.Equal("reference.any-of", candidate.Operand.OperatorId);
            Assert.Equal(new long[] { 2, 10 },
                Assert.IsType<ArticlePropertyArticleReferenceValue>(Assert.Single(candidate.Operand.Values)).ArticleIds);
            Assert.Equal(new[] { "10", "2" }, candidate.Condition.Values);
            Assert.Equal(AuthorSavedViewPropertyInputAdapter.DefinitionBindingUnavailable, candidate.UnavailableReason);
        }
    }

    [Fact]
    public async Task UrlEqualityUsesOnlyTheOriginalCanonicalUrlAuthority()
    {
        BindingFixture fixture = await CreateAsync("property.equals", ["https://example.test/path"]);
        AuthorSavedViewCanonicalPropertyOperandCandidate candidate = Bind(fixture, Definition(ArticlePropertyValueType.Url));
        Assert.Equal("url.equals", candidate.Operand.OperatorId);
        Assert.Equal("https://example.test/path", Assert.IsType<ArticlePropertyUrlValue>(Assert.Single(candidate.Operand.Values)).Url);
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
    public async Task PresenceHasNoPayloadDefaultOrNullCoercion(ArticlePropertyValueType type)
    {
        foreach (string operation in new[] { "value.is-missing", "value.is-present" })
        {
            BindingFixture fixture = await CreateAsync(operation, []);
            ArticlePropertyDefinition definition = Definition(type);
            if (type == ArticlePropertyValueType.Number)
            {
                definition = Seal(definition with
                {
                    Presence = definition.Presence with { Missing = ArticlePropertyMissingBehavior.ApplyDefault },
                    DefaultValue = new(ArticlePropertyDefaultKind.Scalar, Scalar: "0")
                });
            }
            AuthorSavedViewCanonicalPropertyOperandCandidate candidate = Bind(fixture, definition);
            Assert.Equal(operation, candidate.Operand.OperatorId);
            Assert.Empty(candidate.Operand.Values);
            Assert.Empty(candidate.Condition.Values);
        }
    }

    [Theory]
    [InlineData(ArticlePropertyValueType.Text, "property.equals")]
    [InlineData(ArticlePropertyValueType.Date, "property.equals")]
    [InlineData(ArticlePropertyValueType.MultiSelect, "property.equals")]
    [InlineData(ArticlePropertyValueType.ArticleReference, "property.equals")]
    [InlineData(ArticlePropertyValueType.Number, "property.any-of")]
    [InlineData(ArticlePropertyValueType.Boolean, "property.any-of")]
    [InlineData(ArticlePropertyValueType.Text, "property.any-of")]
    [InlineData(ArticlePropertyValueType.Date, "property.any-of")]
    [InlineData(ArticlePropertyValueType.Url, "property.any-of")]
    public async Task MissingOperatorOrComparisonSemanticsRemainUnsupported(ArticlePropertyValueType type, string operation)
    {
        BindingFixture fixture = await CreateAsync(operation, ["0"]);
        AuthorSavedViewValidationException error = Assert.Throws<AuthorSavedViewValidationException>(() => Bind(fixture, Definition(type)));
        Assert.Equal(AuthorSavedViewPropertyInputAdapter.OperandSemanticsUnavailable, error.Code);
    }

    [Theory]
    [InlineData(ArticlePropertyValueType.Number, "0.0")]
    [InlineData(ArticlePropertyValueType.Number, "+1")]
    [InlineData(ArticlePropertyValueType.Number, "1,000")]
    [InlineData(ArticlePropertyValueType.Boolean, "False")]
    [InlineData(ArticlePropertyValueType.Boolean, "true ")]
    [InlineData(ArticlePropertyValueType.SingleSelect, "First")]
    [InlineData(ArticlePropertyValueType.SingleSelect, "option:high")]
    [InlineData(ArticlePropertyValueType.SingleSelect, "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAA1")]
    [InlineData(ArticlePropertyValueType.ArticleReference, "007")]
    [InlineData(ArticlePropertyValueType.ArticleReference, "article:7")]
    [InlineData(ArticlePropertyValueType.Url, "HTTPS://EXAMPLE.TEST/path")]
    public async Task NoncanonicalAliasesAreRejectedInsteadOfNormalizedOrInferred(ArticlePropertyValueType type, string value)
    {
        BindingFixture fixture = await CreateAsync("property.equals", [value]);
        AuthorSavedViewValidationException error = Assert.Throws<AuthorSavedViewValidationException>(() =>
            Bind(fixture, Definition(type, singleReferences: true)));
        Assert.Equal("saved_view_property_value_not_canonical", error.Code);
    }

    [Fact]
    public async Task DefinitionSiteChecksAndOptionEligibilityRemainWithOriginalContracts()
    {
        BindingFixture fixture = await CreateAsync("property.equals", [s_firstOption.ToString("D")]);
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.SingleSelect);
        Assert.Equal("saved_view_property_definition_scope_mismatch",
            Assert.Throws<AuthorSavedViewValidationException>(() => Bind(fixture, Seal(definition with
            {
                Owner = ArticlePropertyDefinitionOwner.User(42, "https://other.test")
            }))).Code);
        // A supplied definition's user ID is not a proved join to the Saved View admin principal.
        Assert.Equal(AuthorSavedViewPropertyInputAdapter.DefinitionBindingUnavailable,
            Bind(fixture, Seal(definition with { Owner = ArticlePropertyDefinitionOwner.User(43, s_owner.SiteScope) })).UnavailableReason);
        Assert.Equal(AuthorSavedViewPropertyInputAdapter.DefinitionBindingUnavailable,
            Bind(fixture, Seal(definition with { Owner = ArticlePropertyDefinitionOwner.Site(s_owner.SiteScope) })).UnavailableReason);
        Assert.Throws<AuthorSearchContractException>(() => Bind(fixture, Seal(definition with { Filterable = false })));
        Assert.Throws<AuthorSearchContractException>(() => Bind(fixture, Seal(definition with
        {
            Options = [definition.Options[0] with { Status = ArticlePropertyOptionStatus.Deprecated }, definition.Options[1]]
        })));
    }

    [Fact]
    public async Task PreparationDriftAndIndexErrorsCannotProduceCanonicalCandidates()
    {
        BindingFixture fixture = await CreateAsync("property.equals", ["0"]);
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Number);
        Assert.Throws<AuthorSavedViewValidationException>(() => Bind(fixture with
        {
            Plan = fixture.Plan with { ContentDigest = new string('a', 64) }
        }, definition));
        Assert.Throws<AuthorSavedViewValidationException>(() => AuthorSavedViewPropertyInputAdapter.PrepareCanonicalOperand(
            fixture.Plan, fixture.Source, fixture.Validation, 26, 0, definition));
        foreach (int index in new[] { -1, 1 })
        {
            Assert.Equal("saved_view_property_condition_index_invalid",
                Assert.Throws<AuthorSavedViewValidationException>(() => AuthorSavedViewPropertyInputAdapter.PrepareCanonicalOperand(
                    fixture.Plan, fixture.Source, fixture.Validation, 25, index, definition)).Code);
        }
    }

    [Fact]
    public async Task MaximumAlternativesRemainBoundedWithoutTruncation()
    {
        Guid[] identities = Enumerable.Range(1, AuthorSavedViewContract.MaxValuesPerCondition)
            .Select(static index => new Guid(index, 0, 0, new byte[8])).ToArray();
        string[] values = identities.Select(static identity => identity.ToString("D")).ToArray();
        ArticlePropertyDefinition definition = Seal(Definition(ArticlePropertyValueType.SingleSelect) with
        {
            Options = identities.Select(static (identity, index) =>
                new ArticlePropertyOption(identity, $"Option {index}", index, ArticlePropertyOptionStatus.Active)).ToArray()
        });
        BindingFixture fixture = await CreateAsync("property.any-of", values);
        AuthorSavedViewCanonicalPropertyOperandCandidate candidate = Bind(fixture, definition);
        Assert.Equal(AuthorSavedViewContract.MaxValuesPerCondition, candidate.Condition.Values.Count);
        Assert.Equal(identities, candidate.Operand.Values.Select(value => Assert.IsType<ArticlePropertySingleSelectValue>(value).OptionId));
        await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() =>
            CreateAsync("property.any-of", [.. values, "ffffffff-ffff-ffff-ffff-ffffffffffff"]));
        int dependencyLimit = AuthorSavedViewContract.MaxConditions + AuthorSavedViewContract.MaxProjectionFields + 1;
        Assert.Equal("saved_view_property_dependency_budget_exceeded",
            Assert.Throws<AuthorSavedViewValidationException>(() => Bind(fixture with
            {
                Plan = fixture.Plan with { Dependencies = Enumerable.Repeat(fixture.Plan.Dependencies[0], dependencyLimit + 1).ToArray() }
            }, definition)).Code);
    }

    [Fact]
    public async Task CanonicalCandidateIsDetachedFromSourceValueBuffers()
    {
        BindingFixture fixture = await CreateAsync("property.equals", ["0"]);
        string[] values = ["0"];
        fixture = fixture with
        {
            Plan = fixture.Plan with
            {
                Query = fixture.Plan.Query with { Conditions = [fixture.Plan.Query.Conditions[0] with { Values = values }] }
            }
        };
        AuthorSavedViewCanonicalPropertyOperandCandidate candidate = Bind(fixture, Definition(ArticlePropertyValueType.Number));
        values[0] = "1";
        Assert.Equal("0", Assert.Single(candidate.Condition.Values));
        Assert.Equal(0, Assert.IsType<ArticlePropertyNumberValue>(Assert.Single(candidate.Operand.Values)).Number);
        Assert.Equal(AuthorSavedViewPropertyInputAdapter.DefinitionBindingUnavailable, candidate.UnavailableReason);
    }

    [Fact]
    public async Task LegacyTypedInputAndCanonicalMappingBothLeaveProductionQueryUnavailable()
    {
        BindingFixture fixture = await CreateAsync("property.equals", ["false"]);
        ArticlePropertyDefinition definition = Definition(ArticlePropertyValueType.Boolean);
        AuthorSavedViewPropertyOperandCandidate legacy = AuthorSavedViewPropertyInputAdapter.PrepareOperand(
            fixture.Plan, fixture.Source, fixture.Validation, 25, 0, definition, "boolean.equals", [new ArticlePropertyBooleanValue(true)]);
        Assert.Equal(AuthorSavedViewPropertyInputAdapter.OperandBindingUnavailable, legacy.UnavailableReason);
        Assert.False(Assert.IsType<ArticlePropertyBooleanValue>(Assert.Single(Bind(fixture, definition).Operand.Values)).Boolean);
        Assert.Equal("author_search_typed_property_operand_unavailable",
            Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ParseClauses("property:false")).Message);
    }

    private static AuthorSavedViewCanonicalPropertyOperandCandidate Bind(BindingFixture fixture, ArticlePropertyDefinition definition)
        => AuthorSavedViewPropertyInputAdapter.PrepareCanonicalOperand(fixture.Plan, fixture.Source, fixture.Validation, 25, 0, definition);

    private static async Task<BindingFixture> CreateAsync(string operation, string[] values)
    {
        var validator = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([new PropertyProvider()]));
        var query = new AuthorSavedViewQuery(AuthorSavedViewContract.SchemaVersion,
            [new(new(AuthorSavedViewFieldKind.Property, "property:opaque-field"), operation, values)],
            new(new(AuthorSavedViewFieldKind.Date, AuthorSavedViewContract.UpdatedAtField),
                AuthorSavedViewSortDirection.Descending, AuthorSavedViewNullPlacement.Last, "temporal", TimeZoneId: "UTC"), [], 25);
        AuthorSavedViewQueryValidationResult validation = await validator.ValidateAsync(s_owner, query);
        var source = new AuthorSavedView(Guid.NewGuid(), s_owner, 1, 1, "Operand input", validation.Query,
            validation.QueryDigest, validation.DependencyDigest, false, 0, AuthorSavedViewLifecycleState.Active,
            DateTime.UnixEpoch, DateTime.UnixEpoch, string.Empty);
        source = source with
        {
            ContentDigest = AuthorSavedViewStorageContract.ComputeViewDigest(source.Owner, source.Id, source.Revision,
                source.Name, source.QueryDigest, source.DependencyDigest, source.Pinned, source.OrderKey, source.LifecycleState)
        };
        var plan = new AuthorSavedViewResolvedPlan(s_owner, source.Id, source.Revision, source.ContentDigest,
            validation.Query, validation.QueryDigest, validation.DependencyDigest, validation.Resolutions, 25, string.Empty);
        plan = plan with { ContentDigest = AuthorSavedViewExecutionPreparationVerifier.ComputePlanDigest(plan) };
        return new(plan, source, validation);
    }

    private static ArticlePropertyDefinition Definition(ArticlePropertyValueType type, bool singleReferences = false)
    {
        bool multiple = type == ArticlePropertyValueType.MultiSelect || type == ArticlePropertyValueType.ArticleReference && !singleReferences;
        ArticlePropertyCardinality cardinality = multiple ? ArticlePropertyCardinality.Multiple : ArticlePropertyCardinality.Single;
        return Seal(new(ArticlePropertyDefinitionContract.SchemaVersion, Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc"),
            ArticlePropertyDefinitionOwner.User(42, s_owner.SiteScope), "different-key", [new("en", "Property")], type,
            cardinality, false, new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull,
                ArticlePropertyEmptyBehavior.PreserveEmpty), null, new(),
            type is ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect
                ? [new(s_firstOption, "First", 0, ArticlePropertyOptionStatus.Active), new(s_secondOption, "Second", 1, ArticlePropertyOptionStatus.Active)] : [],
            type == ArticlePropertyValueType.ArticleReference
                ? new(cardinality, ArticlePropertyReferencePermission.SourceActorMustReadTarget, false, false, false, false, false) : null,
            type == ArticlePropertyValueType.Url ? new(["https"], false, true, 512, ArticlePropertyUrlNormalization.LowerSchemeHost) : null,
            true, true, false, ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.AuthorOnly,
            ArticlePropertyDefinitionStatus.Active, 7, DateTime.UnixEpoch, DateTime.UnixEpoch, string.Empty));
    }

    private static ArticlePropertyDefinition Seal(ArticlePropertyDefinition definition)
        => definition with { ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition) };

    private sealed record BindingFixture(
        AuthorSavedViewResolvedPlan Plan, AuthorSavedView Source, AuthorSavedViewQueryValidationResult Validation);

    // These supplied unit facts are not a production definition binding or permission authority.
    private sealed class PropertyProvider : IAuthorSavedViewDependencyProvider
    {
        public ValueTask<AuthorSavedViewDependencyFact?> ResolveConditionAsync(
            AuthorSavedViewOwner owner, AuthorSavedViewCondition condition, CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyFact?>(new(condition.Field, condition.OperatorId,
                AuthorSavedViewDependencyStatus.Current, "observed-property-authority", condition.Values));

        public ValueTask<AuthorSavedViewDependencyFact?> ResolveSortAsync(
            AuthorSavedViewOwner owner, AuthorSavedViewSort sort, CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyFact?>(null);

        public ValueTask<AuthorSavedViewDependencyFact?> ResolveProjectionAsync(
            AuthorSavedViewOwner owner, AuthorSavedViewFieldReference field, CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyFact?>(null);
    }
}
