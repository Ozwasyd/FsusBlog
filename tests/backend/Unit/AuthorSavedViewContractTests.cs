using System.Collections;

using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorSavedViewContractTests
{
    private static readonly AuthorSavedViewOwner s_owner = new(7, "primary-site");

    [Fact]
    public async Task ClosedAst_CoversStableAuthoritiesAndControlledOrWithoutRecursivePayloads()
    {
        var provider = new TestDependencyProvider();
        var validator = new AuthorSavedViewQueryValidator(
            new AuthorSavedViewDependencyCatalog([provider]));
        AuthorSavedViewQuery query = Query(
        [
            Condition(AuthorSavedViewFieldKind.LifecycleStatus,
                AuthorSavedViewContract.LifecycleStatusField, "identity.any-of", "draft", "published"),
            Condition(AuthorSavedViewFieldKind.Category, "category:news", "identity.equals", "category:news"),
            Condition(AuthorSavedViewFieldKind.Tag, "tag:dotnet", "identity.any-of", "tag:dotnet", "tag:postgres"),
            Condition(AuthorSavedViewFieldKind.FullText,
                AuthorSavedViewContract.AuthorSearchField, "author-search.match", "query-ref:42"),
            Condition(AuthorSavedViewFieldKind.Property, "property:priority", "property.equals", "option:high"),
            Condition(AuthorSavedViewFieldKind.RelationState,
                "relation:outbound-state", "identity.equals", "relation-state:broken"),
            Condition(AuthorSavedViewFieldKind.ContentCheckState,
                "content-check:prepublish", "identity.equals", "content-check-state:blocked"),
            new AuthorSavedViewCondition(
                new AuthorSavedViewFieldReference(AuthorSavedViewFieldKind.Date,
                    AuthorSavedViewContract.PublishedAtField),
                "date.between",
                ["2026-01-01", "2026-12-31"],
                "UTC")
        ]);

        AuthorSavedViewQueryValidationResult result = await validator.ValidateAsync(s_owner, query);

        Assert.True(result.IsValid, string.Join(',', result.Reasons));
        Assert.Equal(8, result.Query.Conditions.Count);
        Assert.DoesNotContain(
            typeof(AuthorSavedViewQuery).GetProperties(),
            property => property.Name.Contains("Group", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Expression", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Sql", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Script", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Result", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Permission", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(12, AuthorSavedViewContract.Operators.Count);
        Assert.All(AuthorSavedViewContract.Operators.Values, descriptor =>
        {
            Assert.NotEmpty(descriptor.PermissionOwner);
            Assert.NotEmpty(descriptor.QueryOwner);
            Assert.True(Enum.IsDefined(descriptor.NullSemantics));
            Assert.True(Enum.IsDefined(descriptor.DefaultSemantics));
            Assert.True(Enum.IsDefined(descriptor.CaseSemantics));
            Assert.True(Enum.IsDefined(descriptor.DateBoundary));
            Assert.True(Enum.IsDefined(descriptor.Cardinality));
        });
        IDictionary registry = Assert.IsAssignableFrom<IDictionary>(AuthorSavedViewContract.Operators);
        Assert.Throws<NotSupportedException>(() => registry.Add("second.registry", new object()));
        IList<AuthorSavedViewFieldKind> fieldKinds = Assert.IsAssignableFrom<IList<AuthorSavedViewFieldKind>>(
            AuthorSavedViewContract.Operators["identity.equals"].FieldKinds);
        Assert.Throws<NotSupportedException>(() => fieldKinds.Add(AuthorSavedViewFieldKind.Property));
        Assert.Equal(Enum.GetValues<AuthorSavedViewFieldKind>().Length, AuthorSavedViewContract.Fields.Count);
        Assert.All(AuthorSavedViewContract.Fields.Values, field =>
        {
            Assert.All(field.OperatorIds, operatorId => Assert.Contains(operatorId, AuthorSavedViewContract.Operators));
            Assert.True(field.IdentityKind == AuthorSavedViewFieldIdentityKind.Exact
                ? field.ExactIdentities.Count > 0 && field.StableIdentityPrefix is null
                : field.ExactIdentities.Count == 0 && field.StableIdentityPrefix is not null);
        });
        Assert.All(AuthorSavedViewContract.Operators.Values, descriptor =>
            Assert.All(descriptor.FieldKinds, kind =>
                Assert.Contains(descriptor.Id, AuthorSavedViewContract.Fields[kind].OperatorIds)));
        IDictionary fieldRegistry = Assert.IsAssignableFrom<IDictionary>(AuthorSavedViewContract.Fields);
        Assert.Throws<NotSupportedException>(() => fieldRegistry.Add(AuthorSavedViewFieldKind.Tag, new object()));
        IList<string> tagOperators = Assert.IsAssignableFrom<IList<string>>(
            AuthorSavedViewContract.Fields[AuthorSavedViewFieldKind.Tag].OperatorIds);
        Assert.Throws<NotSupportedException>(() => tagOperators.Add("second.operator"));
    }

    [Fact]
    public async Task CanonicalDigest_IsOrderAndRenameStableButSemanticChangesDiffer()
    {
        var provider = new TestDependencyProvider();
        var validator = new AuthorSavedViewQueryValidator(
            new AuthorSavedViewDependencyCatalog([provider]));
        AuthorSavedViewCondition status = Condition(
            AuthorSavedViewFieldKind.LifecycleStatus,
            AuthorSavedViewContract.LifecycleStatusField,
            "identity.any-of",
            "published",
            "draft");
        AuthorSavedViewCondition tag = Condition(
            AuthorSavedViewFieldKind.Tag,
            "tag:stable-42",
            "identity.any-of",
            "tag:b",
            "tag:a");

        AuthorSavedViewQueryValidationResult first = await validator.ValidateAsync(s_owner, Query([status, tag]));
        AuthorSavedViewQueryValidationResult reordered = await validator.ValidateAsync(
            s_owner,
            Query([
                tag with { Values = ["tag:a", "tag:b"] },
                status with { Values = ["draft", "published"] }
            ]));
        AuthorSavedViewQueryValidationResult changed = await validator.ValidateAsync(
            s_owner,
            Query([status, tag with { Values = ["tag:c"] }]));

        Assert.Equal(first.QueryDigest, reordered.QueryDigest);
        Assert.Equal(first.DependencyDigest, reordered.DependencyDigest);
        Assert.NotEqual(first.QueryDigest, changed.QueryDigest);
    }

    [Theory]
    [InlineData("tag:not stable")]
    [InlineData("tag:not\u00a0stable")]
    public async Task CanonicalValues_RejectSameCountStableIdentitySemanticTamper(string malformedValue)
    {
        AuthorSavedViewCondition condition = Condition(
            AuthorSavedViewFieldKind.Tag,
            "tag:stable",
            "identity.equals",
            "tag:stable");
        AuthorSavedViewQuery query = Query([condition]);
        AuthorSavedViewContract.ValidateQueryShape(query);
        var provider = new TestDependencyProvider { ReuseMutableCanonicalBuffer = true };
        provider.MutableCanonicalBuffer.Clear();
        provider.MutableCanonicalBuffer.Add(malformedValue);
        AuthorSavedViewDependencyFact fact = Assert.IsType<AuthorSavedViewDependencyFact>(
            await provider.ResolveConditionAsync(s_owner, condition));
        Assert.Equal(condition.Field, fact.Dependency);
        Assert.Equal(condition.OperatorId, fact.OperatorId);
        Assert.Equal(AuthorSavedViewDependencyStatus.Current, fact.Status);
        Assert.Equal(condition.Values.Count, fact.CanonicalValues.Count);
        Assert.Equal(malformedValue, Assert.Single(fact.CanonicalValues));
        Assert.Contains(malformedValue, char.IsWhiteSpace);
        Assert.False(string.IsNullOrWhiteSpace(malformedValue));
        Assert.DoesNotContain(malformedValue, char.IsControl);
        Assert.NotEqual(Assert.Single(condition.Values), malformedValue);
        var validator = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([provider]));

        await AssertValidationCode(
            "saved_view_stable_identity_value_invalid",
            () => validator.ValidateAsync(s_owner, query));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" \t")]
    [InlineData("tag:\u0000invalid")]
    public async Task CanonicalValues_RejectMalformedProviderValueWithValidationCode(string? malformedValue)
    {
        AuthorSavedViewCondition condition = Condition(
            AuthorSavedViewFieldKind.Tag,
            "tag:stable",
            "identity.equals",
            "tag:stable");
        AuthorSavedViewQuery query = Query([condition]);
        AuthorSavedViewContract.ValidateQueryShape(query);
        var provider = new TestDependencyProvider { ReuseMutableCanonicalBuffer = true };
        provider.MutableCanonicalBuffer.Clear();
        provider.MutableCanonicalBuffer.Add(malformedValue!);
        var validator = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([provider]));

        await AssertValidationCode(
            "saved_view_condition_value_invalid",
            () => validator.ValidateAsync(s_owner, query));
    }

    [Fact]
    public async Task CanonicalValues_AcceptBenignSameCountReorderingBeforeSetNormalization()
    {
        AuthorSavedViewCondition condition = Condition(
            AuthorSavedViewFieldKind.Tag,
            "tag:stable",
            "identity.any-of",
            "tag:a",
            "tag:b");
        var provider = new TestDependencyProvider { ReuseMutableCanonicalBuffer = true };
        AuthorSavedViewDependencyFact fact = Assert.IsType<AuthorSavedViewDependencyFact>(
            await provider.ResolveConditionAsync(s_owner, condition));
        Assert.Equal(condition.Field, fact.Dependency);
        Assert.Equal(condition.OperatorId, fact.OperatorId);
        Assert.Equal(AuthorSavedViewDependencyStatus.Current, fact.Status);
        Assert.Equal(condition.Values.Count, fact.CanonicalValues.Count);
        Assert.Equal(["tag:b", "tag:a"], fact.CanonicalValues);
        Assert.False(condition.Values.SequenceEqual(fact.CanonicalValues));
        var validator = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([provider]));
        var unchangedValidator = new AuthorSavedViewQueryValidator(
            new AuthorSavedViewDependencyCatalog([new TestDependencyProvider()]));

        AuthorSavedViewQueryValidationResult reordered = await validator.ValidateAsync(s_owner, Query([condition]));
        AuthorSavedViewQueryValidationResult unchanged = await unchangedValidator.ValidateAsync(s_owner, Query([condition]));

        Assert.True(reordered.IsValid);
        Assert.True(unchanged.IsValid);
        Assert.Equal(["tag:a", "tag:b"], Assert.Single(reordered.Query.Conditions).Values);
        Assert.Equal(
            ["tag:b", "tag:a"],
            Assert.Single(reordered.Resolutions, static resolution => resolution.OperatorId == "identity.any-of").CanonicalValues);
        Assert.Equal(unchanged.QueryDigest, reordered.QueryDigest);
        Assert.Equal(unchanged.DependencyDigest, reordered.DependencyDigest);
    }

    [Fact]
    public async Task ValidationResult_IsDeeplyDetachedFromMutableInputsAndProviderBuffers()
    {
        var mutableValues = new List<string> { "tag:b", "tag:a" };
        var mutableConditions = new List<AuthorSavedViewCondition>
        {
            new(new(AuthorSavedViewFieldKind.Tag, "tag:stable"), "identity.any-of", mutableValues)
        };
        var mutableProjection = new List<AuthorSavedViewFieldReference>
        {
            new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField)
        };
        var provider = new TestDependencyProvider { ReuseMutableCanonicalBuffer = true };
        var validator = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([provider]));
        var query = new AuthorSavedViewQuery(
            AuthorSavedViewContract.SchemaVersion,
            mutableConditions,
            StatusSort(),
            mutableProjection,
            25);

        AuthorSavedViewQueryValidationResult result = await validator.ValidateAsync(s_owner, query);
        string digest = result.QueryDigest;
        mutableValues[0] = "tag:mutated";
        mutableConditions.Clear();
        mutableProjection.Clear();
        provider.MutableCanonicalBuffer[0] = "tag:provider-mutated";

        Assert.Equal(digest, AuthorSavedViewContract.ComputeQueryDigest(result.Query));
        Assert.Equal(["tag:a", "tag:b"], Assert.Single(result.Query.Conditions).Values);
        AuthorSavedViewDependencyResolution conditionResolution = Assert.Single(result.Resolutions, static resolution => resolution.OperatorId == "identity.any-of");
        Assert.Equal(["tag:b", "tag:a"], conditionResolution.CanonicalValues);
        Assert.Throws<NotSupportedException>(() =>
            ((IList<string>)Assert.Single(result.Query.Conditions).Values).Add("tag:late"));
    }

    [Fact]
    public async Task DependencyResolution_FailsClosedForRenameDeleteRetirePermissionMigrationAndDuplicateOwners()
    {
        foreach (AuthorSavedViewDependencyStatus status in new[]
        {
            AuthorSavedViewDependencyStatus.Retired,
            AuthorSavedViewDependencyStatus.Deleted,
            AuthorSavedViewDependencyStatus.PermissionRevoked,
            AuthorSavedViewDependencyStatus.TypeOrOperatorIncompatible,
            AuthorSavedViewDependencyStatus.MigrationRequired,
            AuthorSavedViewDependencyStatus.Unknown
        })
        {
            var provider = new TestDependencyProvider { Status = status };
            var validator = new AuthorSavedViewQueryValidator(
                new AuthorSavedViewDependencyCatalog([provider]));
            AuthorSavedViewQueryValidationResult result = await validator.ValidateAsync(
                s_owner,
                Query([Condition(AuthorSavedViewFieldKind.Tag, "tag:stable", "identity.equals", "tag:stable")]));
            Assert.False(result.IsValid);
            Assert.Contains(status.ToString(), Assert.Single(result.Reasons), StringComparison.Ordinal);
            Assert.Single(result.Query.Conditions);
        }

        var renamed = new TestDependencyProvider { Status = AuthorSavedViewDependencyStatus.RenamedLabelOnly };
        var renamedValidator = new AuthorSavedViewQueryValidator(
            new AuthorSavedViewDependencyCatalog([renamed]));
        Assert.True((await renamedValidator.ValidateAsync(
            s_owner,
            Query([Condition(AuthorSavedViewFieldKind.Tag, "tag:stable", "identity.equals", "tag:stable")]))).IsValid);

        var duplicateValidator = new AuthorSavedViewQueryValidator(
            new AuthorSavedViewDependencyCatalog([new TestDependencyProvider(), new TestDependencyProvider()]));
        AuthorSavedViewQueryValidationResult duplicate = await duplicateValidator.ValidateAsync(
            s_owner,
            Query([Condition(AuthorSavedViewFieldKind.Tag, "tag:stable", "identity.equals", "tag:stable")]));
        Assert.False(duplicate.IsValid);
        Assert.Contains(
            duplicate.Resolutions,
            resolution => resolution.Status == AuthorSavedViewDependencyStatus.DuplicateAuthority);
    }

    [Fact]
    public async Task Validator_RechecksCancellationAfterUntrustedProviderAwait()
    {
        using var cancellation = new CancellationTokenSource();
        var validator = new AuthorSavedViewQueryValidator(
            new AuthorSavedViewDependencyCatalog([new CancellingProvider(cancellation)]));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => validator.ValidateAsync(
            s_owner,
            Query([Condition(AuthorSavedViewFieldKind.Tag, "tag:stable", "identity.equals", "tag:stable")]),
            cancellation.Token));
    }

    [Fact]
    public async Task SchemaOperatorTypeSortPageTimezoneAndTamper_AreRejected()
    {
        var validator = new AuthorSavedViewQueryValidator(
            new AuthorSavedViewDependencyCatalog([new TestDependencyProvider()]));
        AuthorSavedViewQuery valid = Query([]);

        await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() => validator.ValidateAsync(
            s_owner, valid with
            {
                SchemaVersion = 0
            }));
        await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() => validator.ValidateAsync(
            s_owner, valid with
            {
                SchemaVersion = 2
            }));
        await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() => validator.ValidateAsync(
            s_owner, valid with
            {
                PageSize = 0
            }));
        await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() => validator.ValidateAsync(
            s_owner,
            valid with
            {
                Sort = valid.Sort with
                {
                    Collation = "numeric"
                }
            }));
        await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() => validator.ValidateAsync(
            s_owner,
            Query([
                new AuthorSavedViewCondition(
                    new(AuthorSavedViewFieldKind.Date, AuthorSavedViewContract.PublishedAtField),
                    "date.between",
                    ["2026-12-31", "2026-01-01"],
                    "UTC")
            ])));
        await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() => validator.ValidateAsync(
            s_owner,
            Query([Condition(AuthorSavedViewFieldKind.Tag, "tag:stable", "date.before", "2026-01-01")])));

        var tamperingValidator = new AuthorSavedViewQueryValidator(
            new AuthorSavedViewDependencyCatalog([new TestDependencyProvider { TamperDependency = true }]));
        await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() => tamperingValidator.ValidateAsync(
            s_owner,
            Query([Condition(AuthorSavedViewFieldKind.Tag, "tag:stable", "identity.equals", "tag:stable")])));
    }

    [Fact]
    public async Task ClosedRegistries_RejectUnknownFieldsOperatorsDuplicatesAndRecursiveShapesBeforeProviders()
    {
        var provider = new TestDependencyProvider();
        var validator = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([provider]));

        await AssertValidationCode(
            "saved_view_operator_unknown",
            () => validator.ValidateAsync(
                s_owner,
                Query([Condition(AuthorSavedViewFieldKind.Tag, "tag:stable", "future.operator", "tag:stable")])));
        await AssertValidationCode(
            "saved_view_field_identity_unknown",
            () => validator.ValidateAsync(
                s_owner,
                Query([Condition(AuthorSavedViewFieldKind.Tag, "category:wrong", "identity.equals", "tag:stable")])));
        await AssertValidationCode(
            "saved_view_field_kind_unknown",
            () => validator.ValidateAsync(
                s_owner,
                Query([Condition((AuthorSavedViewFieldKind)999, "future:field", "identity.equals", "future:value")])));

        AuthorSavedViewCondition duplicate = Condition(
            AuthorSavedViewFieldKind.Tag,
            "tag:stable",
            "identity.equals",
            "tag:stable");
        await AssertValidationCode(
            "saved_view_condition_duplicate",
            () => validator.ValidateAsync(s_owner, Query([duplicate, duplicate])));

        Assert.Equal(0, provider.ConditionCalls);
        Assert.Equal(
            ["SchemaVersion", "Conditions", "Sort", "Projection", "PageSize"],
            typeof(AuthorSavedViewQuery).GetProperties().Select(static property => property.Name));
        Assert.Equal(
            ["Field", "OperatorId", "Values", "TimeZoneId"],
            typeof(AuthorSavedViewCondition).GetProperties().Select(static property => property.Name));
        Assert.DoesNotContain(
            typeof(AuthorSavedViewQuery).GetProperties().Concat(typeof(AuthorSavedViewCondition).GetProperties()),
            property => property.PropertyType == typeof(AuthorSavedViewQuery)
                || property.PropertyType == typeof(AuthorSavedViewCondition)
                || property.Name.Contains("Expression", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Group", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Json", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task SchemaNullDefaultDateTimezoneAndPagePolicies_AreExplicitAndClosed()
    {
        Assert.Equal(AuthorSavedViewContract.SchemaVersion, AuthorSavedViewContract.SchemaPolicy.CurrentVersion);
        Assert.Equal(
            AuthorSavedViewOldSchemaDisposition.ExplicitMigrationRequired,
            AuthorSavedViewContract.SchemaPolicy.OldSchemaDisposition);
        Assert.Equal(
            AuthorSavedViewFutureSchemaDisposition.Reject,
            AuthorSavedViewContract.SchemaPolicy.FutureSchemaDisposition);
        Assert.Equal(
            AuthorSavedViewSchemaVersionStatus.MigrationRequired,
            AuthorSavedViewContract.ClassifySchemaVersion(0));
        Assert.Equal(
            AuthorSavedViewSchemaVersionStatus.Current,
            AuthorSavedViewContract.ClassifySchemaVersion(AuthorSavedViewContract.SchemaVersion));
        Assert.Equal(
            AuthorSavedViewSchemaVersionStatus.FutureUnsupported,
            AuthorSavedViewContract.ClassifySchemaVersion(AuthorSavedViewContract.SchemaVersion + 1));

        AuthorSavedViewOperatorDescriptor missing = AuthorSavedViewContract.Operators["value.is-missing"];
        AuthorSavedViewOperatorDescriptor present = AuthorSavedViewContract.Operators["value.is-present"];
        Assert.Equal(AuthorSavedViewNullSemantics.MissingOnly, missing.NullSemantics);
        Assert.Equal(AuthorSavedViewNullSemantics.PresentOnly, present.NullSemantics);
        Assert.Equal(AuthorSavedViewDefaultSemantics.DistinctFromMissing, missing.DefaultSemantics);
        Assert.Equal(AuthorSavedViewDefaultSemantics.DistinctFromMissing, present.DefaultSemantics);
        Assert.Equal(AuthorSavedViewOperatorCardinality.None, missing.Cardinality);
        Assert.Equal(AuthorSavedViewOperatorCardinality.None, present.Cardinality);

        var expectedDateBoundaries = new Dictionary<string, AuthorSavedViewDateBoundary>
        {
            ["date.before"] = AuthorSavedViewDateBoundary.ExclusiveUpper,
            ["date.on-or-before"] = AuthorSavedViewDateBoundary.InclusiveUpper,
            ["date.after"] = AuthorSavedViewDateBoundary.ExclusiveLower,
            ["date.on-or-after"] = AuthorSavedViewDateBoundary.InclusiveLower,
            ["date.between"] = AuthorSavedViewDateBoundary.InclusiveRange
        };
        Assert.All(expectedDateBoundaries, pair =>
            Assert.Equal(pair.Value, AuthorSavedViewContract.Operators[pair.Key].DateBoundary));

        var validator = new AuthorSavedViewQueryValidator(
            new AuthorSavedViewDependencyCatalog([new TestDependencyProvider()]));
        Assert.True((await validator.ValidateAsync(
            s_owner,
            Query([Condition(AuthorSavedViewFieldKind.Property, "property:priority", "value.is-missing")]))).IsValid);
        Assert.True((await validator.ValidateAsync(
            s_owner,
            Query([
                new(
                    new(AuthorSavedViewFieldKind.Date, AuthorSavedViewContract.PublishedAtField),
                    "date.before",
                    ["2026-09-07"],
                    "UTC")
            ]))).IsValid);
        Assert.True((await validator.ValidateAsync(
            s_owner,
            Query([]) with
            {
                Sort = StatusSort() with
                {
                    NullPlacement = AuthorSavedViewNullPlacement.First
                }
            })).IsValid);
        Assert.True((await validator.ValidateAsync(
            s_owner,
            Query([]) with
            {
                Sort = new(
                    new(AuthorSavedViewFieldKind.Date, AuthorSavedViewContract.UpdatedAtField),
                    AuthorSavedViewSortDirection.Descending,
                    AuthorSavedViewNullPlacement.Last,
                    "temporal",
                    TimeZoneId: "UTC")
            })).IsValid);

        await AssertValidationCode(
            "saved_view_operator_cardinality_invalid",
            () => validator.ValidateAsync(
                s_owner,
                Query([Condition(
                    AuthorSavedViewFieldKind.Property,
                    "property:priority",
                    "value.is-missing",
                    "option:default")])));
        await AssertValidationCode(
            "saved_view_date_timezone_required",
            () => validator.ValidateAsync(
                s_owner,
                Query([Condition(
                    AuthorSavedViewFieldKind.Date,
                    AuthorSavedViewContract.PublishedAtField,
                    "date.before",
                    "2026-09-07")])));
        await AssertValidationCode(
            "saved_view_timezone_invalid",
            () => validator.ValidateAsync(
                s_owner,
                Query([
                    new(
                        new(AuthorSavedViewFieldKind.Date, AuthorSavedViewContract.PublishedAtField),
                        "date.before",
                        ["2026-09-07"],
                        "Not/A-Time-Zone")
                ])));
        await AssertValidationCode(
            "saved_view_timezone_not_applicable",
            () => validator.ValidateAsync(
                s_owner,
                Query([
                    new(
                        new(AuthorSavedViewFieldKind.Tag, "tag:stable"),
                        "identity.equals",
                        ["tag:stable"],
                        "UTC")
                ])));
        await AssertValidationCode(
            "saved_view_page_size_invalid",
            () => validator.ValidateAsync(
                s_owner,
                Query([]) with
                {
                    PageSize = AuthorSavedViewContract.MaxPageSize + 1
                }));
        await AssertValidationCode(
            "saved_view_sort_unknown",
            () => validator.ValidateAsync(
                s_owner,
                Query([]) with
                {
                    Sort = StatusSort() with
                    {
                        NullPlacement = (AuthorSavedViewNullPlacement)999
                    }
                }));
        await AssertValidationCode(
            "saved_view_sort_tie_breaker_invalid",
            () => validator.ValidateAsync(
                s_owner,
                Query([]) with
                {
                    Sort = StatusSort() with
                    {
                        StableTieBreaker = "article.updated-at"
                    }
                }));
    }

    [Fact]
    public async Task Providers_ReturnFactsOnlyAndCannotTamperDependencyOperatorCanonicalSortOrProjection()
    {
        Assert.DoesNotContain(
            typeof(AuthorSavedViewDependencyFact).GetProperties(),
            property => property.PropertyType == typeof(AuthorSavedViewOperatorDescriptor));
        Assert.All(
            typeof(IAuthorSavedViewDependencyProvider).GetMethods(),
            method => Assert.Contains(
                nameof(AuthorSavedViewDependencyFact),
                method.ReturnType.ToString(),
                StringComparison.Ordinal));

        AuthorSavedViewOperatorDescriptor registered = AuthorSavedViewContract.Operators["identity.equals"];
        Assert.True(AuthorSavedViewContract.IsRegisteredOperatorDescriptor(registered));
        Assert.False(AuthorSavedViewContract.IsRegisteredOperatorDescriptor(
            registered with
            {
                QueryOwner = "second-query-owner"
            }));

        foreach (TestDependencyProvider provider in new[]
        {
            new TestDependencyProvider { TamperDependency = true },
            new TestDependencyProvider { TamperOperator = true },
            new TestDependencyProvider { TamperAuthorityRevision = true }
        })
        {
            var validator = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([provider]));
            await AssertValidationCode(
                "saved_view_dependency_fact_tampered",
                () => validator.ValidateAsync(
                    s_owner,
                    Query([Condition(
                        AuthorSavedViewFieldKind.Tag,
                        "tag:stable",
                        "identity.equals",
                        "tag:stable")])));
        }

        var canonicalTamper = new AuthorSavedViewQueryValidator(
            new AuthorSavedViewDependencyCatalog([new TestDependencyProvider { TamperCanonicalCount = true }]));
        await AssertValidationCode(
            "saved_view_dependency_values_tampered",
            () => canonicalTamper.ValidateAsync(
                s_owner,
                Query([Condition(AuthorSavedViewFieldKind.Tag, "tag:stable", "identity.equals", "tag:stable")])));

        var sortTamper = new AuthorSavedViewQueryValidator(
            new AuthorSavedViewDependencyCatalog([
                new TestDependencyProvider { ReturnSortFact = true, TamperSortFact = true }
            ]));
        await AssertValidationCode(
            "saved_view_dependency_fact_tampered",
            () => sortTamper.ValidateAsync(
                s_owner,
                Query([]) with
                {
                    Sort = new(
                        new(AuthorSavedViewFieldKind.Tag, "tag:stable"),
                        AuthorSavedViewSortDirection.Ascending,
                        AuthorSavedViewNullPlacement.Last,
                        "ordinal")
                }));

        var projectionTamper = new AuthorSavedViewQueryValidator(
            new AuthorSavedViewDependencyCatalog([
                new TestDependencyProvider { ReturnProjectionFact = true, TamperProjectionFact = true }
            ]));
        await AssertValidationCode(
            "saved_view_dependency_fact_tampered",
            () => projectionTamper.ValidateAsync(
                s_owner,
                Query([]) with
                {
                    Projection = [new(AuthorSavedViewFieldKind.Tag, "tag:stable")]
                }));
    }

    [Fact]
    public async Task MissingProductionProviders_FailClosedWithoutForgingExternalAuthority()
    {
        var validator = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([]));
        AuthorSavedViewQueryValidationResult taxonomy = await validator.ValidateAsync(
            s_owner,
            Query([Condition(AuthorSavedViewFieldKind.Tag, "tag:stable", "identity.equals", "tag:stable")]));
        AuthorSavedViewQueryValidationResult fullText = await validator.ValidateAsync(
            s_owner,
            Query([Condition(
                AuthorSavedViewFieldKind.FullText,
                AuthorSavedViewContract.AuthorSearchField,
                "author-search.match",
                "query-ref:42")]));

        Assert.False(taxonomy.IsValid);
        Assert.Equal(AuthorSavedViewDependencyStatus.Unknown, taxonomy.Resolutions[0].Status);
        Assert.False(fullText.IsValid);
        Assert.Equal(AuthorSavedViewDependencyStatus.MigrationRequired, fullText.Resolutions[0].Status);
    }

    private static async Task AssertValidationCode(string expectedCode, Func<Task> action)
    {
        AuthorSavedViewValidationException exception =
            await Assert.ThrowsAsync<AuthorSavedViewValidationException>(action);
        Assert.Equal(expectedCode, exception.Code);
    }

    private static AuthorSavedViewQuery Query(IReadOnlyList<AuthorSavedViewCondition> conditions)
        => new(
            AuthorSavedViewContract.SchemaVersion,
            conditions,
            StatusSort(),
            [new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField)],
            25);

    private static AuthorSavedViewSort StatusSort()
        => new(
            new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField),
            AuthorSavedViewSortDirection.Ascending,
            AuthorSavedViewNullPlacement.Last,
            "ordinal");

    private static AuthorSavedViewCondition Condition(
        AuthorSavedViewFieldKind kind,
        string identity,
        string operatorId,
        params string[] values)
        => new(new(kind, identity), operatorId, values);

    private sealed class TestDependencyProvider : IAuthorSavedViewDependencyProvider
    {
        public AuthorSavedViewDependencyStatus Status { get; set; } = AuthorSavedViewDependencyStatus.Current;
        public string LabelRevision { get; set; } = "authority-v1";
        public bool TamperDependency
        {
            get; set;
        }
        public bool TamperOperator
        {
            get; set;
        }
        public bool TamperCanonicalCount
        {
            get; set;
        }
        public bool TamperAuthorityRevision
        {
            get; set;
        }
        public bool ReturnSortFact
        {
            get; set;
        }
        public bool TamperSortFact
        {
            get; set;
        }
        public bool ReturnProjectionFact
        {
            get; set;
        }
        public bool TamperProjectionFact
        {
            get; set;
        }
        public int ConditionCalls
        {
            get; private set;
        }
        public bool ReuseMutableCanonicalBuffer
        {
            get; set;
        }
        public List<string> MutableCanonicalBuffer { get; } = ["tag:b", "tag:a"];

        public ValueTask<AuthorSavedViewDependencyFact?> ResolveConditionAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewCondition condition,
            CancellationToken cancellationToken = default)
        {
            ConditionCalls++;
            if (condition.Field.Kind is AuthorSavedViewFieldKind.LifecycleStatus or AuthorSavedViewFieldKind.Date)
            {
                return ValueTask.FromResult<AuthorSavedViewDependencyFact?>(null);
            }
            IReadOnlyList<string> canonical = ReuseMutableCanonicalBuffer
                ? MutableCanonicalBuffer
                : condition.Values;
            if (TamperCanonicalCount)
            {
                canonical = [.. canonical, "tampered:extra"];
            }
            return ValueTask.FromResult<AuthorSavedViewDependencyFact?>(new(
                TamperDependency ? new(condition.Field.Kind, $"{condition.Field.Identity}:tampered") : condition.Field,
                TamperOperator ? "future.operator" : condition.OperatorId,
                Status,
                TamperAuthorityRevision ? "invalid revision" : LabelRevision,
                canonical));
        }

        public ValueTask<AuthorSavedViewDependencyFact?> ResolveSortAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewSort sort,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyFact?>(ReturnSortFact
                ? new(
                    TamperSortFact ? new(sort.Field.Kind, $"{sort.Field.Identity}:tampered") : sort.Field,
                    "sort",
                    Status,
                    LabelRevision,
                    [])
                : null);

        public ValueTask<AuthorSavedViewDependencyFact?> ResolveProjectionAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewFieldReference field,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyFact?>(ReturnProjectionFact
                ? new(
                    TamperProjectionFact ? new(field.Kind, $"{field.Identity}:tampered") : field,
                    "projection",
                    Status,
                    LabelRevision,
                    [])
                : null);
    }

    private sealed class CancellingProvider(CancellationTokenSource cancellation)
        : IAuthorSavedViewDependencyProvider
    {
        public ValueTask<AuthorSavedViewDependencyFact?> ResolveConditionAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewCondition condition,
            CancellationToken cancellationToken = default)
        {
            cancellation.Cancel();
            return ValueTask.FromResult<AuthorSavedViewDependencyFact?>(new(
                condition.Field,
                condition.OperatorId,
                AuthorSavedViewDependencyStatus.Current,
                "authority-v1",
                condition.Values));
        }

        public ValueTask<AuthorSavedViewDependencyFact?> ResolveSortAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewSort sort,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyFact?>(null);

        public ValueTask<AuthorSavedViewDependencyFact?> ResolveProjectionAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewFieldReference field,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyFact?>(null);
    }
}
