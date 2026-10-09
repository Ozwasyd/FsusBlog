using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests;

public sealed class ArticlePropertySavedViewDependencyProviderTests
{
    internal const string SiteScope = "https://property-provider.test";
    internal static AuthorSavedViewOwner Owner
    {
        get;
    } = new(42, SiteScope);

    [Fact]
    public async Task All_Eight_Types_Cardinalities_And_Flags_Keep_Execution_Closed()
    {
        foreach (ArticlePropertyValueType type in Enum.GetValues<ArticlePropertyValueType>())
            foreach (ArticlePropertyCardinality cardinality in Enum.GetValues<ArticlePropertyCardinality>())
                for (int flags = 0; flags < 8; flags++)
                {
                    ArticlePropertyDefinition definition = Definition(type, cardinality, flags);
                    var persistence = Persistence((owner, _) => owner == definition.Owner ? definition : null);
                    var provider = Provider(persistence);
                    AuthorSavedViewFieldReference field = Field(definition.DefinitionId);
                    bool validCardinality = type == ArticlePropertyValueType.ArticleReference
                        || cardinality == (type == ArticlePropertyValueType.MultiSelect
                            ? ArticlePropertyCardinality.Multiple : ArticlePropertyCardinality.Single);
                    if (!validCardinality)
                    {
                        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(
                            () => provider.ResolveProjectionAsync(Owner, field).AsTask());
                        continue;
                    }
                    AuthorSavedViewDependencyFact projection = (await provider.ResolveProjectionAsync(Owner, field))!;
                    Assert.Equal(AuthorSavedViewDependencyStatus.Current, projection.Status);
                    Assert.Contains(definition.ContentDigest, projection.AuthorityRevision);
                    Assert.Empty(projection.CanonicalValues);
                    foreach (string operatorId in new[] { "property.equals", "property.any-of", "value.is-missing", "value.is-present", "projection", "sort", "number.equals" })
                    {
                        AuthorSavedViewDependencyFact condition = (await provider.ResolveConditionAsync(
                            Owner, new(field, operatorId, operatorId.StartsWith("value.", StringComparison.Ordinal) ? [] : ["stable-option-id"])))!;
                        Assert.Equal(definition.Filterable ? AuthorSavedViewDependencyStatus.MigrationRequired
                            : AuthorSavedViewDependencyStatus.TypeOrOperatorIncompatible, condition.Status);
                        Assert.Empty(condition.CanonicalValues);
                    }
                    AuthorSavedViewDependencyFact sort = (await provider.ResolveSortAsync(Owner, Sort(field)))!;
                    Assert.Equal(definition.Sortable ? AuthorSavedViewDependencyStatus.MigrationRequired
                        : AuthorSavedViewDependencyStatus.TypeOrOperatorIncompatible, sort.Status);
                }
    }

    [Fact]
    public async Task Original_Store_Filters_Deleted_And_Only_Actual_Deprecated_Is_Retired()
    {
        ArticlePropertyDefinition definition = Definition();
        foreach (ArticlePropertyDefinitionStatus status in Enum.GetValues<ArticlePropertyDefinitionStatus>())
        {
            ArticlePropertyDefinition current = Digest(definition with
            {
                Status = status
            });
            var provider = Provider(Persistence((owner, _) => owner == current.Owner ? current : null));
            Assert.Equal(status switch
            {
                ArticlePropertyDefinitionStatus.Active => AuthorSavedViewDependencyStatus.Current,
                ArticlePropertyDefinitionStatus.Deprecated => AuthorSavedViewDependencyStatus.Retired,
                _ => AuthorSavedViewDependencyStatus.Unknown
            }, (await provider.ResolveProjectionAsync(Owner, Field(current.DefinitionId)))!.Status);
        }
        Assert.Equal(AuthorSavedViewDependencyStatus.Unknown,
            (await Provider(Persistence((_, _) => null)).ResolveProjectionAsync(Owner, Field(Guid.NewGuid())))!.Status);
    }

    [Fact]
    public async Task Site_Definitions_Use_Actual_Actor_And_Other_Users_Are_Never_Read()
    {
        ArticlePropertyDefinition definition = Definition() with
        {
            Owner = ArticlePropertyDefinitionOwner.Site(SiteScope)
        };
        definition = Digest(definition);
        var persistence = Persistence((owner, _) => owner == definition.Owner ? definition : null);
        var provider = Provider(persistence);
        Assert.Equal(AuthorSavedViewDependencyStatus.Current,
            (await provider.ResolveProjectionAsync(Owner, Field(definition.DefinitionId)))!.Status);
        Assert.Equal(4, persistence.ReceivedCalls().Count());
        Assert.All(persistence.ReceivedCalls(), call =>
            Assert.Contains((ArticlePropertyDefinitionOwner)call.GetArguments()[0]!, new[]
            {
                ArticlePropertyDefinitionOwner.User(42, SiteScope), ArticlePropertyDefinitionOwner.Site(SiteScope)
            }));
    }

    [Fact]
    public async Task Missing_Or_Mismatched_Request_Fails_Before_Property_Read()
    {
        ArticlePropertyDefinition definition = Definition();
        for (int failure = 0; failure < 7; failure++)
        {
            var accessor = Request();
            ClaimsIdentity identity = (ClaimsIdentity)accessor.HttpContext!.User.Identity!;
            switch (failure)
            {
                case 0:
                    accessor.HttpContext = null;
                    break;
                case 1:
                    accessor.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(identity.Claims));
                    break;
                case 2:
                    identity.RemoveClaim(identity.FindFirst("identity_kind")!);
                    break;
                case 3:
                    identity.RemoveClaim(identity.FindFirst("admin_id")!);
                    identity.AddClaim(new("admin_id", "43"));
                    break;
                case 4:
                    identity.RemoveClaim(identity.FindFirst("admin_sid")!);
                    break;
                case 5:
                    identity.RemoveClaim(identity.FindFirst(AdminPermissions.PermissionClaimType)!);
                    break;
                case 6:
                    identity.RemoveClaim(identity.FindFirst("admin_sid")!);
                    identity.AddClaim(new("admin_sid", " "));
                    break;
            }
            var persistence = Persistence((_, _) => definition);
            var provider = Provider(persistence, accessor);
            Assert.Equal(AuthorSavedViewDependencyStatus.PermissionRevoked,
                (await provider.ResolveProjectionAsync(Owner, Field(definition.DefinitionId)))!.Status);
            Assert.Empty(persistence.ReceivedCalls());
        }
        var wrongSitePersistence = Persistence((_, _) => definition);
        Assert.Equal(AuthorSavedViewDependencyStatus.PermissionRevoked,
            (await Provider(wrongSitePersistence).ResolveProjectionAsync(
                Owner with
                {
                    SiteScope = "https://other.test"
                }, Field(definition.DefinitionId)))!.Status);
        Assert.Empty(wrongSitePersistence.ReceivedCalls());
    }

    [Fact]
    public async Task Request_Drift_Across_Await_Revokes_Fact()
    {
        for (int change = 0; change < 6; change++)
        {
            var accessor = Request();
            var configuration = Configuration();
            ArticlePropertyDefinition definition = Definition();
            var persistence = Substitute.For<IArticlePropertyDefinitionPersistence>();
            persistence.GetAsync(Arg.Any<ArticlePropertyDefinitionOwner>(), Arg.Any<Guid>(), Arg.Any<CancellationToken>())
                .Returns(async call =>
                {
                    await Task.Yield();
                    var identity = (ClaimsIdentity)accessor.HttpContext!.User.Identity!;
                    switch (change)
                    {
                        case 0:
                            identity.RemoveClaim(identity.FindFirst("admin_sid")!);
                            identity.AddClaim(new("admin_sid", "another-session"));
                            break;
                        case 1:
                            identity.RemoveClaim(identity.FindFirst(AdminPermissions.PermissionClaimType)!);
                            break;
                        case 2:
                            accessor.HttpContext = new DefaultHttpContext { User = accessor.HttpContext.User };
                            break;
                        case 3:
                            accessor.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(identity.Claims, "test"));
                            break;
                        case 4:
                            configuration["SITE_BASEURL"] = "https://other.test";
                            break;
                        case 5:
                            identity.RemoveClaim(identity.FindFirst("admin_id")!);
                            identity.AddClaim(new("admin_id", "43"));
                            break;
                    }
                    return definition;
                });
            Assert.Equal(AuthorSavedViewDependencyStatus.PermissionRevoked,
                (await Provider(persistence, accessor, configuration).ResolveProjectionAsync(Owner, Field(definition.DefinitionId)))!.Status);
            Assert.Single(persistence.ReceivedCalls());
        }
    }

    [Fact]
    public async Task Observed_Schema_Drift_And_Owner_Collision_Are_Closed()
    {
        ArticlePropertyDefinition first = Definition();
        ArticlePropertyDefinition second = Digest(first with
        {
            SchemaRevision = 2
        });
        int userReads = 0;
        var changing = Provider(Persistence((owner, _) => owner.UserId.HasValue
            ? ++userReads == 1 ? first : second : null));
        Assert.Equal(AuthorSavedViewDependencyStatus.MigrationRequired,
            (await changing.ResolveProjectionAsync(Owner, Field(first.DefinitionId)))!.Status);
        var collision = Provider(Persistence((owner, _) => Digest(first with { Owner = owner })));
        Assert.Equal(AuthorSavedViewDependencyStatus.DuplicateAuthority,
            (await collision.ResolveProjectionAsync(Owner, Field(first.DefinitionId)))!.Status);
    }

    [Fact]
    public async Task Stable_Ids_And_Revision_Digest_Track_Metadata_Without_Values()
    {
        ArticlePropertyDefinition current = Definition(ArticlePropertyValueType.SingleSelect);
        current = Digest(current with
        {
            DefinitionId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        });
        var provider = Provider(Persistence((owner, _) => owner == current.Owner ? current : null));
        AuthorSavedViewFieldReference field = Field(current.DefinitionId);
        AuthorSavedViewDependencyFact before = (await provider.ResolveProjectionAsync(Owner, field))!;
        Guid optionId = current.Options[0].OptionId;
        current = Digest(current with
        {
            SchemaRevision = 2,
            Options = [current.Options[0] with { Label = "Different label" }],
            DisplayNames = [new("en", "Different name")]
        });
        AuthorSavedViewDependencyFact after = (await provider.ResolveProjectionAsync(Owner, field))!;
        Assert.Equal(before.Dependency, after.Dependency);
        Assert.Equal(optionId, current.Options[0].OptionId);
        Assert.NotEqual(before.AuthorityRevision, after.AuthorityRevision);
        Assert.Contains(current.ContentDigest, after.AuthorityRevision);
        Assert.Equal(after, await provider.ResolveProjectionAsync(Owner, field));
        current = Digest(current with
        {
            Presence = current.Presence with
            {
                Missing = ArticlePropertyMissingBehavior.ApplyDefault
            },
            DefaultValue = new(ArticlePropertyDefaultKind.OptionIds, OptionIds: [optionId])
        });
        AuthorSavedViewDependencyFact digestOnly = (await provider.ResolveProjectionAsync(Owner, field))!;
        Assert.NotEqual(after.AuthorityRevision, digestOnly.AuthorityRevision);
        Assert.Contains(current.ContentDigest, digestOnly.AuthorityRevision);
        foreach (string alias in new[] { current.MachineKey, current.PrimaryDisplayName.Value,
            current.DefinitionId.ToString("N"), current.DefinitionId.ToString("D").ToUpperInvariant(), "unknown" })
        {
            Assert.Equal(AuthorSavedViewDependencyStatus.Unknown,
                (await provider.ResolveProjectionAsync(Owner, new(AuthorSavedViewFieldKind.Property, $"property:{alias}")))!.Status);
        }
    }

    [Fact]
    public async Task Cancellation_Propagates_Before_And_After_Read()
    {
        using var cancellation = new CancellationTokenSource();
        ArticlePropertyDefinition definition = Definition();
        var persistence = Persistence((_, _) => { cancellation.Cancel(); return definition; });
        var provider = Provider(persistence);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => provider.ResolveProjectionAsync(
            Owner, Field(definition.DefinitionId), cancellation.Token).AsTask());
        Assert.Single(persistence.ReceivedCalls());
        persistence.ClearReceivedCalls();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => provider.ResolveProjectionAsync(
            Owner, Field(definition.DefinitionId), cancellation.Token).AsTask());
        Assert.Empty(persistence.ReceivedCalls());
    }

    [Fact]
    public async Task Other_Kinds_Return_Null_With_Zero_Property_Reads()
    {
        var persistence = Persistence((_, _) => throw new InvalidOperationException("unexpected property read"));
        var provider = Provider(persistence);
        foreach (AuthorSavedViewFieldKind kind in Enum.GetValues<AuthorSavedViewFieldKind>().Where(
            static kind => kind != AuthorSavedViewFieldKind.Property))
        {
            var field = new AuthorSavedViewFieldReference(kind, "irrelevant");
            Assert.Null(await provider.ResolveProjectionAsync(Owner, field));
            Assert.Null(await provider.ResolveSortAsync(Owner, Sort(field)));
            Assert.Null(await provider.ResolveConditionAsync(Owner, new(field, "irrelevant", [])));
        }
        Assert.Empty(persistence.ReceivedCalls());
    }

    [Fact]
    public async Task Original_Catalog_Validator_Reject_Duplicate_And_Unavailable_Execution()
    {
        ArticlePropertyDefinition definition = Definition();
        var provider = Provider(Persistence((owner, _) => owner == definition.Owner ? definition : null));
        var field = Field(definition.DefinitionId);
        var catalog = new AuthorSavedViewDependencyCatalog([provider]);
        var validator = new AuthorSavedViewQueryValidator(catalog);
        var query = new AuthorSavedViewQuery(1, [], Sort(new(AuthorSavedViewFieldKind.LifecycleStatus,
            AuthorSavedViewContract.LifecycleStatusField)), [field], 20);
        Assert.True((await validator.ValidateAsync(Owner, query)).IsValid);
        var unavailable = await validator.ValidateAsync(Owner, query with
        {
            Conditions = [new(field, "property.equals", ["unchanged-stable-value"])],
            Sort = Sort(field)
        });
        Assert.False(unavailable.IsValid);
        Assert.Contains(unavailable.Resolutions, static resolution => resolution.Status == AuthorSavedViewDependencyStatus.MigrationRequired);
        Assert.Equal("unchanged-stable-value", unavailable.Query.Conditions[0].Values[0]);
        var duplicate = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([provider, provider]));
        var rejected = await duplicate.ValidateAsync(Owner, query);
        Assert.False(rejected.IsValid);
        Assert.Contains(rejected.Resolutions, static resolution => resolution.Status == AuthorSavedViewDependencyStatus.DuplicateAuthority);
    }

    [Fact]
    public async Task Original_Store_And_Provider_Refuse_Owner_Identity_And_Digest_Tampering()
    {
        ArticlePropertyDefinition original = Definition();
        foreach (ArticlePropertyDefinition invalid in new[]
        {
            Digest(original with { Owner = ArticlePropertyDefinitionOwner.User(43, SiteScope) }),
            Digest(original with { DefinitionId = Guid.NewGuid() })
        })
        {
            var provider = Provider(Persistence((_, _) => invalid));
            await Assert.ThrowsAnyAsync<InvalidOperationException>(
                () => provider.ResolveProjectionAsync(Owner, Field(original.DefinitionId)).AsTask());
        }
        await Assert.ThrowsAsync<ArticlePropertyDefinitionValidationException>(() => Provider(
            Persistence((_, _) => original with { ContentDigest = new string('0', 64) }))
            .ResolveProjectionAsync(Owner, Field(original.DefinitionId)).AsTask());
    }

    private static IArticlePropertyDefinitionPersistence Persistence(
        Func<ArticlePropertyDefinitionOwner, Guid, ArticlePropertyDefinition?> read)
    {
        var persistence = Substitute.For<IArticlePropertyDefinitionPersistence>();
        persistence.GetAsync(Arg.Any<ArticlePropertyDefinitionOwner>(), Arg.Any<Guid>(), Arg.Any<CancellationToken>())
            .Returns(call => Task.FromResult(read(call.Arg<ArticlePropertyDefinitionOwner>(), call.Arg<Guid>())));
        return persistence;
    }

    private static ArticlePropertySavedViewDependencyProvider Provider(
        IArticlePropertyDefinitionPersistence persistence,
        HttpContextAccessor? accessor = null,
        IConfiguration? configuration = null)
        => new(Store(persistence), accessor ?? Request(), configuration ?? Configuration());

    internal static ArticlePropertyDefinitionStore Store(IArticlePropertyDefinitionPersistence persistence)
        => new(persistence, new ArticlePropertyDefinitionPermissionAuthority(),
            new UnavailableArticlePropertyDefinitionImpactAuthority(),
            new ArticlePropertyDefinitionVerifier(Configuration()), TestTemporalContext.FromEnvironment().BusinessClock);

    internal static IConfigurationRoot Configuration()
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SITE_BASEURL"] = SiteScope,
            ["Audit:TamperEvidenceKey"] = "property-provider-isolated-test-audit-key"
        }).Build();

    internal static HttpContextAccessor Request()
        => new()
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(new[]
                {
                    new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                    new Claim("admin_id", "42"), new Claim("admin_sid", "actual-test-request-session"),
                    new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
                }, "test"))
            }
        };

    internal static AuthorSavedViewFieldReference Field(Guid id) => new(AuthorSavedViewFieldKind.Property, $"property:{id:D}");

    internal static AuthorSavedViewSort Sort(AuthorSavedViewFieldReference field)
        => new(field, AuthorSavedViewSortDirection.Ascending, AuthorSavedViewNullPlacement.Last, "ordinal");

    internal static ArticlePropertyDefinition Digest(ArticlePropertyDefinition definition)
        => definition with
        {
            ContentDigest = ArticlePropertyDefinitionContract.ComputeDefinitionDigest(definition)
        };

    internal static ArticlePropertyDefinition Definition(
        ArticlePropertyValueType type = ArticlePropertyValueType.Text,
        ArticlePropertyCardinality cardinality = ArticlePropertyCardinality.Single,
        int flags = 7)
    {
        var definition = new ArticlePropertyDefinition(1, Guid.NewGuid(),
            ArticlePropertyDefinitionOwner.User(42, SiteScope), "stable-key", [new("en", "Definition label")],
            type, cardinality, false,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            null, new(), type is ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect
                ? [new(Guid.NewGuid(), "Option label", 0, ArticlePropertyOptionStatus.Active)] : [],
            type == ArticlePropertyValueType.ArticleReference
                ? new(cardinality, ArticlePropertyReferencePermission.SourceActorMustReadTarget, false, false, false, false, false) : null,
            type == ArticlePropertyValueType.Url
                ? new(["https"], false, true, 1024, ArticlePropertyUrlNormalization.LowerSchemeHost) : null,
            (flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0,
            ArticlePropertyDisplayPlacement.Metadata, ArticlePropertyVisibilityScope.SiteEditors,
            ArticlePropertyDefinitionStatus.Active, 1, DateTime.UnixEpoch, DateTime.UnixEpoch, string.Empty);
        return Digest(definition);
    }
}
