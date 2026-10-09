using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringFilterContributionQueryMapperTests
{
    private static readonly AuthorSavedViewOwner s_owner = new(7, "primary-site");
    private static readonly AuthoringCoreAuthorityRegistry s_core = new([], [], [], [], []);

    [Theory]
    [InlineData(AuthoringFilterScalarKind.Text, "hello")]
    [InlineData(AuthoringFilterScalarKind.StableIdentity, "option:high")]
    [InlineData(AuthoringFilterScalarKind.Number, "12.5")]
    [InlineData(AuthoringFilterScalarKind.Boolean, "true")]
    [InlineData(AuthoringFilterScalarKind.LocalDate, "2026-10-09")]
    public async Task TypedPropertyScalar_MapsDataButCannotAssertPropertyFacts(
        AuthoringFilterScalarKind kind, string expected)
    {
        AuthoringFilterContribution contribution = Contribution("property.equals", AuthorSavedViewFieldKind.Property,
            "property:priority", kind);
        AuthoringFilterScalar scalar = kind switch
        {
            AuthoringFilterScalarKind.Number => new(kind, null, 12.5m, null, null),
            AuthoringFilterScalarKind.Boolean => new(kind, null, null, true, null),
            AuthoringFilterScalarKind.LocalDate => new(kind, null, null, null, new DateOnly(2026, 10, 9)),
            _ => new(kind, expected, null, null, null)
        };
        AuthoringFilterMappingResult result = await Mapper(contribution).MapAsync(s_owner, Query(),
            [Configuration(contribution, [scalar])]);

        AssertBlocked(result);
        Assert.Equal(expected, Assert.Single(result.StructuralQuery!.Conditions).Values[0]);
        Assert.Contains("Property:property:priority:Unknown", result.Reasons);
    }

    [Theory]
    [InlineData("date.before", 1)]
    [InlineData("date.on-or-before", 1)]
    [InlineData("date.after", 1)]
    [InlineData("date.on-or-after", 1)]
    [InlineData("date.between", 2)]
    public async Task DateAndRange_UseExistingOperatorsAndTimeZone(string operatorId, int count)
    {
        AuthoringFilterContribution contribution = Contribution(operatorId, AuthorSavedViewFieldKind.Date,
            AuthorSavedViewContract.PublishedAtField, AuthoringFilterScalarKind.LocalDate);
        ImmutableArray<AuthoringFilterScalar> values = count == 1 ? [Date(1)] : [Date(1), Date(9)];
        AuthoringFilterMappingResult result = await Mapper(contribution).MapAsync(s_owner, Query(),
            [Configuration(contribution, values) with { TimeZoneId = "UTC" }]);

        AssertBlocked(result);
        AuthorSavedViewCondition condition = Assert.Single(result.StructuralQuery!.Conditions);
        Assert.Equal(operatorId, condition.OperatorId);
        Assert.Equal(count, condition.Values.Count);
        Assert.Equal("UTC", condition.TimeZoneId);
        Assert.DoesNotContain("filter_saved_view_validation_blocked", result.Reasons);
    }

    [Theory]
    [InlineData("value.is-missing", AuthorSavedViewNullSemantics.MissingOnly)]
    [InlineData("value.is-present", AuthorSavedViewNullSemantics.PresentOnly)]
    public async Task NullSemantics_UseZeroValuesWithoutConvertingNullToMatchAll(
        string operatorId, AuthorSavedViewNullSemantics semantics)
    {
        AuthoringFilterContribution contribution = Contribution(operatorId, AuthorSavedViewFieldKind.Date,
            AuthorSavedViewContract.PublishedAtField, AuthoringFilterScalarKind.Text);
        Assert.Equal(semantics, contribution.Operators[0].NullSemantics);
        AuthoringFilterMappingResult result = await Mapper(contribution).MapAsync(s_owner, Query(),
            [Configuration(contribution, [])]);

        AssertBlocked(result);
        Assert.Empty(Assert.Single(result.StructuralQuery!.Conditions).Values);
        Assert.Equal(operatorId, result.StructuralQuery.Conditions[0].OperatorId);
    }

    [Fact]
    public async Task Set_MapsBoundedValuesWithoutBroadeningOriginalConditionsOrSort()
    {
        AuthoringFilterContribution contribution = Contribution("identity.any-of", AuthorSavedViewFieldKind.LifecycleStatus,
            AuthorSavedViewContract.LifecycleStatusField, AuthoringFilterScalarKind.StableIdentity);
        AuthorSavedViewCondition originalCondition = new(
            new(AuthorSavedViewFieldKind.Date, AuthorSavedViewContract.CreatedAtField),
            "date.after", ["2026-01-01"], "UTC");
        AuthorSavedViewCondition originalStatus = new(
            new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField),
            "identity.equals", ["Published"]);
        AuthorSavedViewQuery original = Query([originalCondition, originalStatus]) with
        {
            PageSize = 73
        };
        string originalDigest = AuthorSavedViewContract.ComputeQueryDigest(original);
        var validator = new CapturingValidator();
        var mapper = new AuthoringFilterContributionQueryMapper([contribution], s_core, validator);
        AuthoringFilterMappingResult result = await mapper.MapAsync(s_owner, original,
            [Configuration(contribution, [Identity("published"), Identity("draft")])]);

        AssertBlocked(result);
        Assert.Equal(3, result.StructuralQuery!.Conditions.Count);
        Assert.Equal(originalCondition.Field, result.StructuralQuery.Conditions[0].Field);
        Assert.Equal(originalCondition.OperatorId, result.StructuralQuery.Conditions[0].OperatorId);
        Assert.Equal(originalCondition.Values, result.StructuralQuery.Conditions[0].Values);
        Assert.Equal(originalCondition.TimeZoneId, result.StructuralQuery.Conditions[0].TimeZoneId);
        Assert.Equal(new[] { "Published" }, result.StructuralQuery.Conditions[1].Values);
        Assert.Equal(new[] { "published", "draft" }, result.StructuralQuery.Conditions[2].Values);
        Assert.Equal(original.Sort, result.StructuralQuery.Sort);
        Assert.Equal(original.Projection, result.StructuralQuery.Projection);
        Assert.Equal(73, result.StructuralQuery.PageSize);
        Assert.Equal(originalDigest, AuthorSavedViewContract.ComputeQueryDigest(original));
        Assert.Equal(AuthorSavedViewContract.ComputeQueryDigest(result.StructuralQuery), result.StructuralQueryDigest);
        Assert.Same(result.StructuralQuery, validator.SeenQuery);
        Assert.Equal(s_owner, validator.SeenOwner);
        Assert.Equal(1, validator.Calls);
    }

    [Fact]
    public async Task ZeroContributions_StillCannotAdmitAnArticleQuery()
    {
        var mapper = new AuthoringFilterContributionQueryMapper([], s_core, Validator());
        AuthoringFilterMappingResult result = await mapper.MapAsync(s_owner, Query(), []);
        AssertBlocked(result);
        Assert.Empty(result.StructuralQuery!.Conditions);
    }

    [Fact]
    public async Task ThousandRegistrations_DoNotAuthorizeThousandConditions()
    {
        AuthoringFilterContribution[] contributions = Enumerable.Range(0, 1000)
            .Select(index => Contribution("identity.equals", AuthorSavedViewFieldKind.Category,
                $"category:{index + 1}", AuthoringFilterScalarKind.StableIdentity, index)).ToArray();
        var validator = new CapturingValidator();
        var mapper = new AuthoringFilterContributionQueryMapper(contributions, s_core, validator);
        AuthoringFilterMappingResult one = await mapper.MapAsync(s_owner, Query(),
            [Configuration(contributions[0], [Identity("category:1")])]);
        AssertBlocked(one);
        Assert.Single(one.StructuralQuery!.Conditions);
        AuthoringFilterMappingResult many = await mapper.MapAsync(s_owner, Query(),
            [.. contributions.Select(item => Configuration(item, [Identity("category:1")]))]);
        AssertRejected(many, "filter_configuration_budget_exceeded");
        Assert.Equal(1, validator.Calls);
        Assert.Throws<AuthoringFilterContractException>(() => new AuthoringFilterContributionQueryMapper(
            [.. contributions, Contribution("identity.equals", AuthorSavedViewFieldKind.Category,
                "category:1001", AuthoringFilterScalarKind.StableIdentity, 1000)], s_core, Validator()));
    }

    [Fact]
    public async Task ConditionBudget_Accepts64AndRejects65BeforeValidator()
    {
        AuthoringFilterContribution[] contributions = Enumerable.Range(0, 65)
            .Select(index => Contribution("identity.equals", AuthorSavedViewFieldKind.Category,
                $"category:{index + 1}", AuthoringFilterScalarKind.StableIdentity, index)).ToArray();
        var validator = new CapturingValidator();
        var mapper = new AuthoringFilterContributionQueryMapper(contributions, s_core, validator);
        ImmutableArray<AuthoringFilterConfiguration> configs = [.. contributions.Take(64)
            .Select(item => Configuration(item, [Identity("category:1")]))];
        AuthoringFilterMappingResult boundary = await mapper.MapAsync(s_owner, Query(), configs);
        AssertBlocked(boundary);
        Assert.Equal(64, boundary.StructuralQuery!.Conditions.Count);
        AuthorSavedViewQuery original = Query([new(new(AuthorSavedViewFieldKind.LifecycleStatus,
            AuthorSavedViewContract.LifecycleStatusField), "identity.equals", ["draft"])]);
        AuthoringFilterMappingResult excess = await mapper.MapAsync(s_owner, original, configs);
        AssertRejected(excess, "saved_view_condition_budget_exceeded");
        Assert.Equal(1, validator.Calls);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(64)]
    [InlineData(65)]
    public async Task SetValues_RespectCanonicalCardinality(int count)
    {
        AuthoringFilterContribution contribution = Contribution("property.any-of", AuthorSavedViewFieldKind.Property,
            "property:priority", AuthoringFilterScalarKind.Number);
        ImmutableArray<AuthoringFilterScalar> values = [.. Enumerable.Range(0, count)
            .Select(index => new AuthoringFilterScalar(AuthoringFilterScalarKind.Number, null, index, null, null))];
        AuthoringFilterMappingResult result = await Mapper(contribution).MapAsync(s_owner, Query(),
            [Configuration(contribution, values)]);
        if (count == 65)
        {
            AssertRejected(result, "filter_value_budget_exceeded");
        }
        else
        {
            AssertBlocked(result);
            Assert.Equal(count, Assert.Single(result.StructuralQuery!.Conditions).Values.Count);
        }
    }

    [Fact]
    public async Task CostAndPerFilterBudgets_RejectBeforeValidation()
    {
        AuthoringFilterContribution first = Contribution("date.before", AuthorSavedViewFieldKind.Date,
            AuthorSavedViewContract.CreatedAtField, AuthoringFilterScalarKind.LocalDate);
        AuthoringFilterContribution second = Contribution("date.after", AuthorSavedViewFieldKind.Date,
            AuthorSavedViewContract.PublishedAtField, AuthoringFilterScalarKind.LocalDate, 1);
        var validator = new CapturingValidator();
        var expensive = new AuthoringFilterContributionQueryMapper(
            [first with { CostPerCondition = 4096 }, second], s_core, validator);
        AssertRejected(await expensive.MapAsync(s_owner, Query(),
            [Configuration(first, [Date(1)]) with { TimeZoneId = "UTC" },
                Configuration(second, [Date(9)]) with { TimeZoneId = "UTC" }]), "filter_query_cost_exceeded");
        AuthoringFilterContribution limited = first with
        {
            MaximumConditions = 1,
            Operators = [first.Operators[0], second.Operators[0] with { Id = "sample.operator.second" }]
        };
        var mapper = new AuthoringFilterContributionQueryMapper([limited], s_core, validator);
        AssertRejected(await mapper.MapAsync(s_owner, Query(),
            [Configuration(limited, [Date(1)]), Configuration(limited, [Date(9)]) with
            { OperatorId = "sample.operator.second" }]), "filter_condition_budget_exceeded");
        Assert.Equal(0, validator.Calls);
    }

    [Fact]
    public async Task ProjectionAndPageBudgets_UseOriginalShapeValidation()
    {
        AuthoringFilterContribution contribution = DefaultContribution();
        var validator = new CapturingValidator();
        var mapper = new AuthoringFilterContributionQueryMapper([contribution], s_core, validator);
        AuthorSavedViewQuery boundary = Query() with
        {
            PageSize = 100,
            Projection = [.. Enumerable.Range(1, 32).Select(index => new AuthorSavedViewFieldReference(
                AuthorSavedViewFieldKind.Property, $"property:p{index}"))]
        };
        AssertBlocked(await mapper.MapAsync(s_owner, boundary, [Configuration(contribution, [Identity("draft")])]));
        AssertRejected(await mapper.MapAsync(s_owner, boundary with
        {
            PageSize = 101
        }, []), "saved_view_page_size_invalid");
        AuthoringFilterMappingResult excess = await mapper.MapAsync(s_owner, boundary with
        {
            Projection = [.. boundary.Projection, new(AuthorSavedViewFieldKind.Property, "property:extra")]
        }, []);
        Assert.Equal(AuthoringFilterMappingStatus.Rejected, excess.Status);
        Assert.Null(excess.StructuralQuery);
        Assert.Equal(1, validator.Calls);
    }

    [Theory]
    [InlineData("unknown")]
    [InlineData("duplicate")]
    [InlineData("target-duplicate")]
    [InlineData("core")]
    [InlineData("type")]
    [InlineData("null")]
    [InlineData("field")]
    [InlineData("shape")]
    [InlineData("version")]
    public void OperatorDeclarations_RejectUnknownDuplicateAndSemanticConflicts(string mutation)
    {
        AuthoringFilterContribution contribution = DefaultContribution();
        AuthoringFilterOperatorDeclaration declaration = contribution.Operators[0];
        contribution = mutation switch
        {
            "duplicate" => contribution with { Operators = [declaration, declaration] },
            "target-duplicate" => contribution with { Operators = [declaration, declaration with { Id = "sample.operator.other" }] },
            "unknown" => contribution with { Operators = [declaration with { SavedViewOperatorId = "plugin.eval" }] },
            "core" => contribution with { Operators = [declaration with { Id = "identity.equals" }] },
            "type" => contribution with { Operators = [declaration with { FieldType = AuthorSavedViewValueKind.Number }] },
            "null" => contribution with { Operators = [declaration with { NullSemantics = AuthorSavedViewNullSemantics.MissingOnly }] },
            "field" => contribution with { Operators = [declaration with { Field = new(AuthorSavedViewFieldKind.Date, AuthorSavedViewContract.CreatedAtField) }] },
            "shape" => contribution with { Operators = [declaration with { Parameter = declaration.Parameter with { Shape = AuthoringFilterParameterShape.Range } }] },
            _ => contribution with { QueryAdapterVersion = 2 }
        };
        Assert.Throws<AuthoringFilterContractException>(() => Mapper(contribution));
    }

    [Fact]
    public void Registry_RejectsGlobalDuplicatesAndCoreOwnedNames()
    {
        AuthoringFilterContribution first = DefaultContribution();
        Assert.Throws<AuthoringFilterContractException>(() => new AuthoringFilterContributionQueryMapper([first, first], s_core, Validator()));
        AuthoringFilterContribution second = first with
        {
            FilterId = "sample.filter.second"
        };
        Assert.Throws<AuthoringFilterContractException>(() => new AuthoringFilterContributionQueryMapper([first, second], s_core, Validator()));
        AuthoringCoreAuthorityRegistry reserved = s_core with
        {
            SavedViewOperatorIds = [first.Operators[0].Id]
        };
        Assert.Throws<AuthoringFilterContractException>(() => new AuthoringFilterContributionQueryMapper([first], reserved, Validator()));
        reserved = s_core with
        {
            RouteIds = [first.FilterId]
        };
        Assert.Throws<AuthoringFilterContractException>(() => new AuthoringFilterContributionQueryMapper([first], reserved, Validator()));
        Assert.Throws<AuthoringFilterContractException>(() => Mapper(first with { FilterId = "article.id" }));
        Assert.Throws<AuthoringFilterContractException>(() => Mapper(first with { PluginId = "fsusblog.core.plugin" }));
    }

    [Theory]
    [InlineData("Sql")]
    [InlineData("JavaScript")]
    [InlineData("Regex")]
    [InlineData("Predicate")]
    [InlineData("ArbitraryJson")]
    public void ClosedJson_RejectsExecutableOrArbitraryMembersAtEveryLevel(string member)
    {
        JsonObject root = JsonSerializer.SerializeToNode(DefaultContribution())!.AsObject();
        root[member] = new JsonObject { ["expression"] = "opaque-data" };
        Assert.Throws<AuthoringFilterContractException>(() => AuthoringFilterContributionContracts.ParseContribution(
            Encoding.UTF8.GetBytes(root.ToJsonString())));
        root.Remove(member);
        root["Operators"]![0]![member] = "opaque-data";
        Assert.Throws<AuthoringFilterContractException>(() => AuthoringFilterContributionContracts.ParseContribution(
            Encoding.UTF8.GetBytes(root.ToJsonString())));
        JsonObject configuration = JsonSerializer.SerializeToNode(Configuration(DefaultContribution(), [Identity("draft")]))!.AsObject();
        configuration["Values"]![0]![member] = new JsonObject();
        Assert.Throws<AuthoringFilterContractException>(() => AuthoringFilterContributionContracts.ParseConfiguration(
            Encoding.UTF8.GetBytes(configuration.ToJsonString())));
    }

    [Fact]
    public void ClosedJson_RoundTripsAndRejectsDuplicateMissingUnknownEnumsAndOversize()
    {
        AuthoringFilterContribution original = DefaultContribution();
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(original);
        Assert.Equal(original.FilterId, AuthoringFilterContributionContracts.ParseContribution(json).FilterId);
        AuthoringFilterConfiguration configuration = Configuration(original, [Identity("draft")]);
        Assert.Equal(configuration.FilterId, AuthoringFilterContributionContracts.ParseConfiguration(
            JsonSerializer.SerializeToUtf8Bytes(configuration)).FilterId);
        string duplicate = Encoding.UTF8.GetString(json).Replace("\"SchemaVersion\":1", "\"SchemaVersion\":1,\"SchemaVersion\":1", StringComparison.Ordinal);
        Assert.Throws<AuthoringFilterContractException>(() => AuthoringFilterContributionContracts.ParseContribution(Encoding.UTF8.GetBytes(duplicate)));
        JsonObject root = JsonSerializer.SerializeToNode(original)!.AsObject();
        root.Remove("RequiredPermissions");
        Assert.Throws<AuthoringFilterContractException>(() => AuthoringFilterContributionContracts.ParseContribution(Encoding.UTF8.GetBytes(root.ToJsonString())));
        root = JsonSerializer.SerializeToNode(original)!.AsObject();
        root["Indexability"] = 999;
        Assert.Throws<AuthoringFilterContractException>(() => AuthoringFilterContributionContracts.ParseContribution(Encoding.UTF8.GetBytes(root.ToJsonString())));
        Assert.Throws<AuthoringFilterContractException>(() => AuthoringFilterContributionContracts.ParseContribution(
            new byte[AuthoringFilterContributionContracts.MaximumJsonBytes + 1]));
    }

    [Theory]
    [InlineData("async")]
    [InlineData("network")]
    [InlineData("file")]
    public void ExternalExecutionRequests_AreRejected(string request)
    {
        AuthoringFilterContribution contribution = DefaultContribution();
        contribution = request switch
        {
            "async" => contribution with { RequestsAsync = true },
            "network" => contribution with { RequestsNetwork = true },
            _ => contribution with { RequestsFile = true }
        };
        Assert.Throws<AuthoringFilterContractException>(() => Mapper(contribution));
    }

    [Theory]
    [InlineData(AuthoringLifecycleState.Disabled, AuthoringFilterMappingStatus.Unsupported)]
    [InlineData(AuthoringLifecycleState.Removed, AuthoringFilterMappingStatus.Unsupported)]
    [InlineData(AuthoringLifecycleState.Uninstalling, AuthoringFilterMappingStatus.Unsupported)]
    [InlineData(AuthoringLifecycleState.MigrationRequired, AuthoringFilterMappingStatus.NeedsUpdate)]
    [InlineData(AuthoringLifecycleState.Updating, AuthoringFilterMappingStatus.NeedsUpdate)]
    [InlineData(AuthoringLifecycleState.Enabled, AuthoringFilterMappingStatus.Blocked)]
    [InlineData(AuthoringLifecycleState.Running, AuthoringFilterMappingStatus.Blocked)]
    public async Task LifecycleObservation_CanOnlyRefuseAndNeverDropConditions(
        AuthoringLifecycleState state, AuthoringFilterMappingStatus expected)
    {
        AuthoringFilterContribution contribution = DefaultContribution();
        AuthoringFilterMappingResult result = await Mapper(contribution).MapAsync(s_owner, Query(),
            [Configuration(contribution, [Identity("draft")])], state);
        Assert.Equal(expected, result.Status);
        Assert.Single(result.StructuralQuery!.Conditions);
        Assert.Contains("filter_lifecycle_facts_unavailable", result.Reasons);
    }

    [Theory]
    [InlineData("plugin-version", "filter_binding_drift")]
    [InlineData("package", "filter_binding_drift")]
    [InlineData("filter-version", "filter_binding_drift")]
    [InlineData("operator-version", "filter_operator_version_drift")]
    public async Task SavedConfigurationDrift_RequiresManualUpdate(string mutation, string reason)
    {
        AuthoringFilterContribution contribution = DefaultContribution();
        AuthoringFilterConfiguration configuration = Configuration(contribution, [Identity("draft")]);
        configuration = mutation switch
        {
            "plugin-version" => configuration with { PluginVersion = "2.0" },
            "package" => configuration with { PackageSha256 = new string('b', 64) },
            "filter-version" => configuration with { FilterVersion = 2 },
            _ => configuration with { OperatorVersion = 2 }
        };
        AuthoringFilterMappingResult result = await Mapper(contribution).MapAsync(s_owner, Query(), [configuration]);
        Assert.Equal(AuthoringFilterMappingStatus.NeedsUpdate, result.Status);
        Assert.Null(result.StructuralQuery);
        Assert.Contains(reason, result.Reasons);
        Assert.Single(configuration.Values);
    }

    [Fact]
    public async Task MissingRegistrationOrOperator_NeverFallsBackToOriginalQuery()
    {
        AuthoringFilterContribution contribution = DefaultContribution();
        var mapper = new AuthoringFilterContributionQueryMapper([], s_core, Validator());
        AuthoringFilterMappingResult missing = await mapper.MapAsync(s_owner, Query(),
            [Configuration(contribution, [Identity("draft")])]);
        Assert.Equal(AuthoringFilterMappingStatus.Unsupported, missing.Status);
        Assert.Null(missing.StructuralQuery);
        AuthoringFilterMappingResult unknown = await Mapper(contribution).MapAsync(s_owner, Query(),
            [Configuration(contribution, [Identity("draft")]) with { OperatorId = "sample.operator.unknown" }]);
        Assert.Equal(AuthoringFilterMappingStatus.Unsupported, unknown.Status);
        Assert.Null(unknown.StructuralQuery);
    }

    [Fact]
    public async Task DuplicateConfigurationOrOriginalTarget_RejectsWithoutConditionDrop()
    {
        AuthoringFilterContribution contribution = DefaultContribution();
        AuthoringFilterConfiguration configuration = Configuration(contribution, [Identity("draft")]);
        var mapper = Mapper(contribution);
        AssertRejected(await mapper.MapAsync(s_owner, Query(), [configuration, configuration]), "filter_configuration_duplicate");
        AuthorSavedViewQuery original = Query([new(contribution.Operators[0].Field, "identity.equals", ["published"])]);
        AssertRejected(await mapper.MapAsync(s_owner, original, [configuration]), "saved_view_condition_duplicate");
        Assert.Equal("published", original.Conditions[0].Values[0]);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("mixed")]
    [InlineData("wrong-type")]
    [InlineData("unknown-type")]
    [InlineData("length")]
    [InlineData("empty")]
    public async Task ScalarAndCardinalityMutations_AreRejected(string mutation)
    {
        AuthoringFilterContribution contribution = DefaultContribution();
        ImmutableArray<AuthoringFilterScalar> values = mutation switch
        {
            "null" => [new(AuthoringFilterScalarKind.StableIdentity, null, null, null, null)],
            "mixed" => [Identity("draft") with { Number = 1 }],
            "wrong-type" => [new(AuthoringFilterScalarKind.Number, null, 1, null, null)],
            "unknown-type" => [Identity("draft") with { Kind = (AuthoringFilterScalarKind)99 }],
            "length" => [Identity(new string('x', 513))],
            _ => []
        };
        AuthoringFilterMappingResult result = await Mapper(contribution).MapAsync(s_owner, Query(),
            [Configuration(contribution, values)]);
        Assert.Equal(AuthoringFilterMappingStatus.Rejected, result.Status);
        Assert.Null(result.StructuralQuery);
    }

    [Fact]
    public async Task RangeOrderSetDuplicatesAndMissingTimezone_UseClosedRules()
    {
        AuthoringFilterContribution range = Contribution("date.between", AuthorSavedViewFieldKind.Date,
            AuthorSavedViewContract.CreatedAtField, AuthoringFilterScalarKind.LocalDate);
        AssertRejected(await Mapper(range).MapAsync(s_owner, Query(),
            [Configuration(range, [Date(9), Date(1)]) with { TimeZoneId = "UTC" }]), "saved_view_date_range_invalid");
        AssertRejected(await Mapper(range).MapAsync(s_owner, Query(),
            [Configuration(range, [Date(1), Date(9)])]), "saved_view_date_timezone_required");
        AuthoringFilterContribution set = Contribution("identity.any-of", AuthorSavedViewFieldKind.LifecycleStatus,
            AuthorSavedViewContract.LifecycleStatusField, AuthoringFilterScalarKind.StableIdentity);
        AssertRejected(await Mapper(set).MapAsync(s_owner, Query(),
            [Configuration(set, [Identity("draft"), Identity("draft")])]), "filter_set_value_duplicate");
    }

    [Theory]
    [InlineData(AuthorSavedViewFieldKind.FullText, "author-search.current", "author-search.match", AuthoringFilterScalarKind.Text)]
    [InlineData(AuthorSavedViewFieldKind.RelationState, "relation:links", "identity.equals", AuthoringFilterScalarKind.StableIdentity)]
    [InlineData(AuthorSavedViewFieldKind.Category, "category:1", "identity.equals", AuthoringFilterScalarKind.StableIdentity)]
    public async Task MissingProductionDependencies_AreTruthfullyBlocked(
        AuthorSavedViewFieldKind kind, string field, string operatorId, AuthoringFilterScalarKind scalarKind)
    {
        AuthoringFilterContribution contribution = Contribution(operatorId, kind, field, scalarKind);
        var scalar = new AuthoringFilterScalar(scalarKind, "query-ref:1", null, null, null);
        AuthoringFilterMappingResult result = await Mapper(contribution).MapAsync(s_owner, Query(),
            [Configuration(contribution, [scalar])]);
        AssertBlocked(result);
        Assert.Contains("filter_saved_view_validation_blocked", result.Reasons);
    }

    [Fact]
    public async Task Cancellation_PropagatesWithoutReturningAStructuralResult()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Mapper(DefaultContribution()).MapAsync(
            s_owner, Query(), [], cancellationToken: cancellation.Token));
    }

    [Fact]
    public async Task CallerListMutation_DoesNotChangeSnapshotAcrossValidatorAwait()
    {
        var values = new List<string> { "published" };
        var conditions = new List<AuthorSavedViewCondition>
        {
            new(new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField),
                "identity.equals", values)
        };
        var projection = new List<AuthorSavedViewFieldReference>
        {
            new(AuthorSavedViewFieldKind.Date, AuthorSavedViewContract.CreatedAtField)
        };
        var validator = new CapturingValidator(() =>
        {
            values.Clear();
            conditions.Clear();
            projection.Clear();
        });
        var mapper = new AuthoringFilterContributionQueryMapper([], s_core, validator);
        AuthoringFilterMappingResult result = await mapper.MapAsync(s_owner,
            Query(conditions) with
            {
                Projection = projection
            }, []);
        AssertBlocked(result);
        Assert.Equal("published", Assert.Single(result.StructuralQuery!.Conditions).Values[0]);
        Assert.Single(result.StructuralQuery.Projection);
        Assert.Empty(conditions);
    }

    [Fact]
    public void RequirementsAndParameterBudgets_CannotBeWeakenedByDeclarations()
    {
        AuthoringFilterContribution contribution = DefaultContribution();
        Assert.Throws<AuthoringFilterContractException>(() => Mapper(contribution with { RequiredPermissions = [] }));
        Assert.Throws<AuthoringFilterContractException>(() => Mapper(contribution with
        {
            RequiredPermissions = [AuthoringFilterPermissionRequirement.AuthorArticleRead,
                AuthoringFilterPermissionRequirement.AuthorArticleRead]
        }));
        Assert.Throws<AuthoringFilterContractException>(() => Mapper(contribution with { LifecyclePolicy = (AuthoringFilterLifecyclePolicy)99 }));
        Assert.Throws<AuthoringFilterContractException>(() => Mapper(contribution with { SchemaVersion = 2 }));
        Assert.Throws<AuthoringFilterContractException>(() => Mapper(contribution with { MaximumConditions = 65 }));
        Assert.Throws<AuthoringFilterContractException>(() => Mapper(contribution with { CostPerCondition = 0 }));
        AuthoringFilterOperatorDeclaration declaration = contribution.Operators[0];
        Assert.Throws<AuthoringFilterContractException>(() => Mapper(contribution with
        {
            Operators = [declaration with { Parameter = declaration.Parameter with { MaximumValueLength = 513 } }]
        }));
        Assert.Throws<AuthoringFilterContractException>(() => Mapper(contribution with
        {
            Operators = [declaration with { Parameter = declaration.Parameter with { MaximumValues = 65 } }]
        }));
    }

    private static AuthoringFilterContribution DefaultContribution()
        => Contribution("identity.equals", AuthorSavedViewFieldKind.LifecycleStatus,
            AuthorSavedViewContract.LifecycleStatusField, AuthoringFilterScalarKind.StableIdentity);

    private static AuthoringFilterContribution Contribution(string operatorId, AuthorSavedViewFieldKind kind,
        string field, AuthoringFilterScalarKind scalarKind, int index = 0)
    {
        AuthorSavedViewOperatorDescriptor descriptor = AuthorSavedViewContract.FindBuiltInOperator(operatorId)!;
        AuthoringFilterParameterShape shape = descriptor.Cardinality switch
        {
            AuthorSavedViewOperatorCardinality.None => AuthoringFilterParameterShape.None,
            AuthorSavedViewOperatorCardinality.Single => AuthoringFilterParameterShape.Scalar,
            AuthorSavedViewOperatorCardinality.OrderedPair => AuthoringFilterParameterShape.Range,
            _ => AuthoringFilterParameterShape.Set
        };
        int values = shape switch
        {
            AuthoringFilterParameterShape.None => 0,
            AuthoringFilterParameterShape.Scalar => 1,
            AuthoringFilterParameterShape.Range => 2,
            _ => 64
        };
        return new(1, "sample", "1.0", new string('a', 64), $"sample.filter.f{index}", 1, 1,
            [new($"sample.operator.o{index}", 1, operatorId, new(kind, field), descriptor.ValueKind,
                descriptor.NullSemantics, new(scalarKind, shape, values, 512))],
            [AuthoringFilterPermissionRequirement.AuthorArticleRead], AuthoringFilterIndexRequirement.OwningServerIndex,
            AuthoringFilterLifecyclePolicy.RetainConditionsRequireRevalidation, 64, 1, false, false, false);
    }

    private static AuthoringFilterConfiguration Configuration(AuthoringFilterContribution contribution,
        ImmutableArray<AuthoringFilterScalar> values)
        => new(1, contribution.PluginId, contribution.PluginVersion, contribution.PackageSha256,
            contribution.FilterId, contribution.FilterVersion, contribution.Operators[0].Id,
            contribution.Operators[0].Version, values, null);

    private static AuthoringFilterScalar Identity(string value)
        => new(AuthoringFilterScalarKind.StableIdentity, value, null, null, null);

    private static AuthoringFilterScalar Date(int day)
        => new(AuthoringFilterScalarKind.LocalDate, null, null, null, new DateOnly(2026, 10, day));

    private static AuthorSavedViewQuery Query(IReadOnlyList<AuthorSavedViewCondition>? conditions = null)
        => new(1, conditions ?? [], new(new(AuthorSavedViewFieldKind.Date, AuthorSavedViewContract.UpdatedAtField),
            AuthorSavedViewSortDirection.Descending, AuthorSavedViewNullPlacement.Last, "temporal", TimeZoneId: "UTC"),
            [new(AuthorSavedViewFieldKind.Date, AuthorSavedViewContract.PublishedAtField)], 25);

    private static AuthorSavedViewQueryValidator Validator()
        => new(new AuthorSavedViewDependencyCatalog([]));

    private static AuthoringFilterContributionQueryMapper Mapper(AuthoringFilterContribution contribution)
        => new([contribution], s_core, Validator());

    private static void AssertBlocked(AuthoringFilterMappingResult result)
    {
        Assert.Equal(AuthoringFilterMappingStatus.Blocked, result.Status);
        Assert.NotNull(result.StructuralQuery);
        Assert.Contains("filter_permission_facts_unavailable", result.Reasons);
        Assert.Contains("filter_indexability_facts_unavailable", result.Reasons);
        Assert.Contains("filter_lifecycle_facts_unavailable", result.Reasons);
        Assert.Contains("filter_canonical_executor_unavailable", result.Reasons);
    }

    private static void AssertRejected(AuthoringFilterMappingResult result, string reason)
    {
        Assert.Equal(AuthoringFilterMappingStatus.Rejected, result.Status);
        Assert.Null(result.StructuralQuery);
        Assert.Null(result.StructuralQueryDigest);
        Assert.Contains(reason, result.Reasons);
    }

    private sealed class CapturingValidator(Action? beforeValidation = null) : IAuthorSavedViewQueryValidator
    {
        public int Calls
        {
            get; private set;
        }
        public AuthorSavedViewQuery? SeenQuery
        {
            get; private set;
        }
        public AuthorSavedViewOwner SeenOwner
        {
            get; private set;
        }

        public Task<AuthorSavedViewQueryValidationResult> ValidateAsync(AuthorSavedViewOwner owner,
            AuthorSavedViewQuery query, CancellationToken cancellationToken = default)
        {
            Calls++;
            SeenOwner = owner;
            SeenQuery = query;
            beforeValidation?.Invoke();
            return Validator().ValidateAsync(owner, query, cancellationToken);
        }
    }
}
