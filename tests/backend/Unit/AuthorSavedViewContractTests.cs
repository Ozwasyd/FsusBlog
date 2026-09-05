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
            new AuthorSavedViewCondition(
                new AuthorSavedViewFieldReference(AuthorSavedViewFieldKind.Date,
                    AuthorSavedViewContract.PublishedAtField),
                "date.between",
                ["2026-01-01", "2026-12-31"],
                "UTC")
        ]);

        AuthorSavedViewQueryValidationResult result = await validator.ValidateAsync(s_owner, query);

        Assert.True(result.IsValid, string.Join(',', result.Reasons));
        Assert.Equal(7, result.Query.Conditions.Count);
        Assert.DoesNotContain(
            typeof(AuthorSavedViewQuery).GetProperties(),
            property => property.Name.Contains("Group", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Expression", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Sql", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Script", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Result", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Permission", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(10, AuthorSavedViewContract.Operators.Count);
        Assert.All(AuthorSavedViewContract.Operators.Values, descriptor =>
        {
            Assert.NotEmpty(descriptor.PermissionOwner);
            Assert.NotEmpty(descriptor.QueryOwner);
            Assert.True(Enum.IsDefined(descriptor.NullSemantics));
            Assert.True(Enum.IsDefined(descriptor.CaseSemantics));
            Assert.True(Enum.IsDefined(descriptor.DateBoundary));
            Assert.True(Enum.IsDefined(descriptor.Cardinality));
        });
        IDictionary registry = Assert.IsAssignableFrom<IDictionary>(AuthorSavedViewContract.Operators);
        Assert.Throws<NotSupportedException>(() => registry.Add("second.registry", new object()));
        IList<AuthorSavedViewFieldKind> fieldKinds = Assert.IsAssignableFrom<IList<AuthorSavedViewFieldKind>>(
            AuthorSavedViewContract.Operators["identity.equals"].FieldKinds);
        Assert.Throws<NotSupportedException>(() => fieldKinds.Add(AuthorSavedViewFieldKind.Property));
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
            new AuthorSavedViewDependencyCatalog([new TestDependencyProvider { Tamper = true }]));
        await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() => tamperingValidator.ValidateAsync(
            s_owner,
            Query([Condition(AuthorSavedViewFieldKind.Tag, "tag:stable", "identity.equals", "tag:stable")])));
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
        public bool Tamper
        {
            get; set;
        }
        public bool ReuseMutableCanonicalBuffer
        {
            get; set;
        }
        public List<string> MutableCanonicalBuffer { get; } = ["tag:b", "tag:a"];

        public ValueTask<AuthorSavedViewDependencyResolution?> ResolveConditionAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewCondition condition,
            CancellationToken cancellationToken = default)
        {
            if (condition.Field.Kind is AuthorSavedViewFieldKind.LifecycleStatus or AuthorSavedViewFieldKind.Date)
            {
                return ValueTask.FromResult<AuthorSavedViewDependencyResolution?>(null);
            }
            AuthorSavedViewOperatorDescriptor descriptor = Descriptor(condition);
            IReadOnlyList<string> canonical = ReuseMutableCanonicalBuffer
                ? MutableCanonicalBuffer
                : condition.Values;
            return ValueTask.FromResult<AuthorSavedViewDependencyResolution?>(new(
                Tamper ? new(condition.Field.Kind, "tampered") : condition.Field,
                condition.OperatorId,
                Status,
                LabelRevision,
                descriptor,
                canonical));
        }

        public ValueTask<AuthorSavedViewDependencyResolution?> ResolveSortAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewSort sort,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyResolution?>(null);

        public ValueTask<AuthorSavedViewDependencyResolution?> ResolveProjectionAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewFieldReference field,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyResolution?>(null);

        private static AuthorSavedViewOperatorDescriptor Descriptor(AuthorSavedViewCondition condition)
            => AuthorSavedViewContract.FindBuiltInOperator(condition.OperatorId)
                ?? new(
                    condition.OperatorId,
                    [condition.Field.Kind],
                    AuthorSavedViewValueKind.StableIdentity,
                    AuthorSavedViewOperatorCardinality.Single,
                    AuthorSavedViewNullSemantics.AuthorityOwned,
                    AuthorSavedViewCaseSemantics.AuthorityOwned,
                    AuthorSavedViewDateBoundary.AuthorityOwned,
                    "typed-property-authority",
                    "typed-property-query");
    }

    private sealed class CancellingProvider(CancellationTokenSource cancellation)
        : IAuthorSavedViewDependencyProvider
    {
        public ValueTask<AuthorSavedViewDependencyResolution?> ResolveConditionAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewCondition condition,
            CancellationToken cancellationToken = default)
        {
            cancellation.Cancel();
            return ValueTask.FromResult<AuthorSavedViewDependencyResolution?>(new(
                condition.Field,
                condition.OperatorId,
                AuthorSavedViewDependencyStatus.Current,
                "authority-v1",
                AuthorSavedViewContract.FindBuiltInOperator(condition.OperatorId)!,
                condition.Values));
        }

        public ValueTask<AuthorSavedViewDependencyResolution?> ResolveSortAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewSort sort,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyResolution?>(null);

        public ValueTask<AuthorSavedViewDependencyResolution?> ResolveProjectionAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewFieldReference field,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyResolution?>(null);
    }
}
