using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthorSavedViewExecutionPreparationTests
{
    private static readonly AuthorSavedViewOwner s_owner = new(42, "https://site.test");

    [Fact]
    public async Task Preparation_PreservesClosedQueryAndBindingsWithOnlyBoundedAuthorityReads()
    {
        var fixture = await CreateAsync();
        AuthorSavedViewExecutionPreparationRequest request = Request(fixture.Source);
        AuthorSavedViewExecutionPreparation result = await fixture.Service.PrepareAsync(request);
        Assert.Equal(AuthorSavedViewPreparationStatus.Resolved, result.Status);
        AuthorSavedViewResolvedPlan plan = Assert.IsType<AuthorSavedViewResolvedPlan>(result.Plan);
        Assert.Equal(request.RequestId, result.RequestId);
        Assert.Equal(request.RequestSequence, result.RequestSequence);
        Assert.Equal(fixture.Source.Owner, plan.Owner);
        Assert.Equal(fixture.Source.Id, plan.ViewId);
        Assert.Equal(fixture.Source.Revision, plan.ViewRevision);
        Assert.Equal(fixture.Source.QueryDigest, plan.QueryDigest);
        Assert.Equal(fixture.Source.Query.Conditions.Count, plan.Query.Conditions.Count);
        Assert.Equal(AuthorSavedViewExecutionPreparationVerifier.ComputePreparationDigest(result), result.ContentDigest);
        Assert.True(AuthorSavedViewExecutionPreparationVerifier.VerifyResolvedPlan(
            plan, fixture.Source, await fixture.Validator.ValidateAsync(s_owner, fixture.Source.Query), request.Limit).Valid);
        Assert.Equal(3, fixture.Boundary.Store.Calls.Count);
        Assert.All(fixture.Boundary.Store.Calls, call => Assert.Equal(fixture.Source.Id, Assert.IsType<Guid>(call.Input)));

        AuthorSavedViewExecutionPreparation next = await fixture.Service.PrepareAsync(request with
        {
            RequestId = Guid.NewGuid(),
            RequestSequence = 2
        });
        Assert.Equal(plan.ContentDigest, next.Plan!.ContentDigest);
        Assert.NotEqual(result.ContentDigest, next.ContentDigest);
    }

    [Theory]
    [InlineData(AuthorSavedViewDependencyStatus.Current, AuthorSavedViewPreparationStatus.Resolved)]
    [InlineData(AuthorSavedViewDependencyStatus.RenamedLabelOnly, AuthorSavedViewPreparationStatus.Resolved)]
    [InlineData(AuthorSavedViewDependencyStatus.Retired, AuthorSavedViewPreparationStatus.Invalid)]
    [InlineData(AuthorSavedViewDependencyStatus.Deleted, AuthorSavedViewPreparationStatus.Invalid)]
    [InlineData(AuthorSavedViewDependencyStatus.PermissionRevoked, AuthorSavedViewPreparationStatus.Blocked)]
    [InlineData(AuthorSavedViewDependencyStatus.TypeOrOperatorIncompatible, AuthorSavedViewPreparationStatus.NeedsUpdate)]
    [InlineData(AuthorSavedViewDependencyStatus.MigrationRequired, AuthorSavedViewPreparationStatus.NeedsUpdate)]
    [InlineData(AuthorSavedViewDependencyStatus.Unknown, AuthorSavedViewPreparationStatus.Blocked)]
    [InlineData(AuthorSavedViewDependencyStatus.DuplicateAuthority, AuthorSavedViewPreparationStatus.Blocked)]
    public async Task DependencyStates_AreExplicitAndNeverDropConditions(
        AuthorSavedViewDependencyStatus dependencyStatus,
        AuthorSavedViewPreparationStatus expectedStatus)
    {
        var fixture = await CreateAsync();
        fixture.Provider.Status = dependencyStatus;
        AuthorSavedViewExecutionPreparation result = await fixture.Service.PrepareAsync(Request(fixture.Source));
        Assert.Equal(expectedStatus, result.Status);
        Assert.Equal(dependencyStatus, result.Dependencies[0].Status);
        Assert.Equal(fixture.Source.Query.Conditions[0].Field, result.Dependencies[0].Dependency);
        if (expectedStatus == AuthorSavedViewPreparationStatus.Resolved)
        {
            Assert.Equal(fixture.Source.QueryDigest, result.Plan!.QueryDigest);
            Assert.Single(result.Plan.Query.Conditions);
        }
        else
        {
            Assert.Null(result.Plan);
            Assert.Equal("saved_view_dependencies_invalid", result.ReasonCode);
        }
        Assert.All(fixture.Boundary.Store.Calls, call => Assert.IsType<Guid>(call.Input));
    }

    [Fact]
    public async Task MissingProductionProvider_RemainsBlockedWithoutLocalOrTitleFallback()
    {
        var fixture = await CreateAsync();
        var service = new AuthorSavedViewExecutionPreparationService(fixture.Boundary.Facade,
            new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([])));
        AuthorSavedViewExecutionPreparation result = await service.PrepareAsync(Request(fixture.Source));
        Assert.Equal(AuthorSavedViewPreparationStatus.Blocked, result.Status);
        Assert.Null(result.Plan);
        Assert.Equal(AuthorSavedViewDependencyStatus.Unknown, result.Dependencies[0].Status);
    }

    [Theory]
    [InlineData("request-id")]
    [InlineData("view-id")]
    [InlineData("revision")]
    [InlineData("sequence")]
    [InlineData("future-schema")]
    [InlineData("limit")]
    [InlineData("digest")]
    public async Task MalformedRequest_IsRejectedBeforeAuthorityReads(string mutation)
    {
        var fixture = await CreateAsync();
        AuthorSavedViewExecutionPreparationRequest request = Request(fixture.Source);
        request = mutation switch
        {
            "request-id" => request with { RequestId = Guid.Empty },
            "view-id" => request with { ViewId = Guid.Empty },
            "revision" => request with { ExpectedViewRevision = 0 },
            "sequence" => request with { RequestSequence = 0 },
            "future-schema" => request with { QuerySchemaVersion = 2 },
            "limit" => request with { Limit = 101 },
            _ => request with { ExpectedQueryDigest = "private malformed query" }
        };
        AuthorSavedViewValidationException error = await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() =>
            fixture.Service.PrepareAsync(request));
        Assert.Equal("saved_view_execution_request_invalid", error.Code);
        Assert.DoesNotContain("private", error.Message, StringComparison.Ordinal);
        Assert.Empty(fixture.Boundary.Store.Calls);
    }

    [Fact]
    public async Task MissingRetiredStaleAndOversizedRequests_DoNotResolveOrBroadenQuery()
    {
        var fixture = await CreateAsync();
        fixture.Boundary.Store.View = null;
        Assert.Equal(AuthorSavedViewPreparationStatus.NotFound,
            (await fixture.Service.PrepareAsync(Request(fixture.Source))).Status);
        fixture.Boundary.Store.View = fixture.Source;
        Assert.Equal(AuthorSavedViewPreparationStatus.Stale,
            (await fixture.Service.PrepareAsync(Request(fixture.Source) with
            {
                ExpectedViewRevision = 2
            })).Status);
        fixture.Boundary.Store.View = Reseal(fixture.Source with
        {
            LifecycleState = AuthorSavedViewLifecycleState.Retired
        });
        Assert.Equal(AuthorSavedViewPreparationStatus.Retired,
            (await fixture.Service.PrepareAsync(Request(fixture.Source))).Status);
        fixture.Boundary.Store.View = fixture.Source;
        Assert.Equal("saved_view_execution_limit_exceeds_query",
            (await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() =>
                fixture.Service.PrepareAsync(Request(fixture.Source) with
                {
                    Limit = 26
                }))).Code);
        Assert.Equal(1, fixture.Provider.Calls);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task ViewRevisionChangeDuringEitherDependencyAwait_IsStale(int resolveCall)
    {
        var fixture = await CreateAsync();
        fixture.Provider.Calls = 0;
        fixture.Provider.BeforeReturn = () =>
        {
            if (fixture.Provider.Calls == resolveCall)
            {
                fixture.Boundary.Store.View = Reseal(fixture.Source with
                {
                    Revision = 2
                });
            }
        };
        AuthorSavedViewExecutionPreparation result = await fixture.Service.PrepareAsync(Request(fixture.Source));
        Assert.Equal(AuthorSavedViewPreparationStatus.Stale, result.Status);
        Assert.Null(result.Plan);
        Assert.Empty(result.Dependencies);
    }

    [Fact]
    public async Task DependencyRevisionChangeBetweenResolutions_IsStale()
    {
        var fixture = await CreateAsync();
        fixture.Provider.Calls = 0;
        fixture.Provider.BeforeReturn = () => fixture.Provider.Revision = $"taxonomy-{fixture.Provider.Calls}";
        AuthorSavedViewExecutionPreparation result = await fixture.Service.PrepareAsync(Request(fixture.Source));
        Assert.Equal(AuthorSavedViewPreparationStatus.Stale, result.Status);
        Assert.Equal("saved_view_dependencies_stale", result.ReasonCode);
        Assert.Null(result.Plan);
    }

    [Fact]
    public async Task CancellationAfterProviderAwait_AndCrossOwnerResponses_AreRefused()
    {
        var fixture = await CreateAsync();
        using var cancellation = new CancellationTokenSource();
        fixture.Provider.BeforeReturn = cancellation.Cancel;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            fixture.Service.PrepareAsync(Request(fixture.Source), cancellation.Token));
        fixture.Provider.BeforeReturn = null;
        fixture.Boundary.Store.View = Reseal(fixture.Source with
        {
            Owner = new(81, s_owner.SiteScope)
        });
        await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() =>
            fixture.Service.PrepareAsync(Request(fixture.Source)));
    }

    [Theory]
    [InlineData("drop-condition")]
    [InlineData("drop-dependency")]
    [InlineData("canonical-values")]
    [InlineData("false-success")]
    [InlineData("sort-owner")]
    public async Task ForgedValidatorFacts_CannotCertifyAPlan(string mutation)
    {
        var fixture = await CreateAsync();
        var validator = new AlteredValidator(fixture.Validator, result =>
        {
            AuthorSavedViewDependencyResolution[] resolutions = result.Resolutions.ToArray();
            switch (mutation)
            {
                case "drop-condition":
                    return result with
                    {
                        Query = result.Query with
                        {
                            Conditions = []
                        }
                    };
                case "drop-dependency":
                    return result with
                    {
                        Resolutions = resolutions[1..]
                    };
                case "canonical-values":
                    resolutions[0] = resolutions[0] with
                    {
                        CanonicalValues = ["category:99"]
                    };
                    break;
                case "false-success":
                    return result with
                    {
                        IsValid = false
                    };
                default:
                    resolutions[1] = resolutions[1] with
                    {
                        Operator = resolutions[1].Operator with
                        {
                            QueryOwner = "second-query"
                        }
                    };
                    break;
            }
            return result with
            {
                Resolutions = resolutions
            };
        });
        var service = new AuthorSavedViewExecutionPreparationService(fixture.Boundary.Facade, validator);
        Assert.Equal("saved_view_execution_resolution_tampered",
            (await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() => service.PrepareAsync(Request(fixture.Source)))).Code);
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("view-revision")]
    [InlineData("query")]
    [InlineData("dependency-values")]
    [InlineData("limit")]
    [InlineData("digest")]
    public async Task IndependentVerifier_RejectsRehashedPlanTamper(string mutation)
    {
        var fixture = await CreateAsync();
        AuthorSavedViewResolvedPlan plan = (await fixture.Service.PrepareAsync(Request(fixture.Source))).Plan!;
        AuthorSavedViewQueryValidationResult dependencies = await fixture.Validator.ValidateAsync(s_owner, fixture.Source.Query);
        plan = mutation switch
        {
            "owner" => plan with { Owner = new(81, s_owner.SiteScope) },
            "view-revision" => plan with { ViewRevision = 2 },
            "query" => plan with { Query = plan.Query with { Conditions = [] } },
            "dependency-values" => plan with
            {
                Dependencies = [plan.Dependencies[0] with { CanonicalValues = ["category:99"] }, .. plan.Dependencies.Skip(1)]
            },
            "limit" => plan with { Limit = 100 },
            _ => plan with { ContentDigest = new string('a', 64) }
        };
        if (mutation != "digest")
        {
            plan = plan with
            {
                ContentDigest = AuthorSavedViewExecutionPreparationVerifier.ComputePlanDigest(plan)
            };
        }
        Assert.False(AuthorSavedViewExecutionPreparationVerifier.VerifyResolvedPlan(plan, fixture.Source, dependencies, 25).Valid);
    }

    [Fact]
    public async Task Plan_IsDetachedFromMutableSourceAndDependencyBuffers()
    {
        var fixture = await CreateAsync();
        string[] values = ["category:7"];
        fixture.Boundary.Store.View = fixture.Source with
        {
            Query = fixture.Source.Query with
            {
                Conditions = [fixture.Source.Query.Conditions[0] with { Values = values }]
            }
        };
        AuthorSavedViewResolvedPlan plan = (await fixture.Service.PrepareAsync(Request(fixture.Source))).Plan!;
        values[0] = "category:99";
        Assert.Equal("category:7", Assert.Single(plan.Query.Conditions[0].Values));
        Assert.Equal("category:7", Assert.Single(plan.Dependencies[0].CanonicalValues));
        Assert.Equal(plan.QueryDigest, AuthorSavedViewContract.ComputeQueryDigest(plan.Query));
    }

    private static async Task<Fixture> CreateAsync()
    {
        var provider = new MutableProvider();
        var validator = new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([provider]));
        var query = new AuthorSavedViewQuery(AuthorSavedViewContract.SchemaVersion,
            [new(new(AuthorSavedViewFieldKind.Category, "category:7"), "identity.equals", ["category:7"])],
            new(new(AuthorSavedViewFieldKind.Date, AuthorSavedViewContract.UpdatedAtField),
                AuthorSavedViewSortDirection.Descending, AuthorSavedViewNullPlacement.Last, "temporal", TimeZoneId: "UTC"),
            [new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField)], 25);
        AuthorSavedViewQueryValidationResult validated = await validator.ValidateAsync(s_owner, query);
        var source = Reseal(new(Guid.NewGuid(), s_owner, 1, 1, "Private saved view", validated.Query,
            validated.QueryDigest, validated.DependencyDigest, false, 0,
            AuthorSavedViewLifecycleState.Active, DateTime.UnixEpoch, DateTime.UnixEpoch, string.Empty));
        var boundary = new PreparationBoundary();
        boundary.Store.View = source;
        return new(source, boundary, provider, validator,
            new AuthorSavedViewExecutionPreparationService(boundary.Facade, validator));
    }

    private static AuthorSavedView Reseal(AuthorSavedView source)
        => source with
        {
            ContentDigest = AuthorSavedViewStorageContract.ComputeViewDigest(source.Owner, source.Id, source.Revision,
                source.Name, source.QueryDigest, source.DependencyDigest, source.Pinned, source.OrderKey, source.LifecycleState)
        };

    private static AuthorSavedViewExecutionPreparationRequest Request(AuthorSavedView source)
        => new(source.Id, source.Revision, source.QueryDigest, 1, 25, Guid.NewGuid(), 1);

    private sealed record Fixture(
        AuthorSavedView Source,
        PreparationBoundary Boundary,
        MutableProvider Provider,
        AuthorSavedViewQueryValidator Validator,
        AuthorSavedViewExecutionPreparationService Service);

    private sealed class PreparationBoundary
    {
        public CapturingStore Store
        {
            get;
        } = new();

        public AuthorSavedViewApplicationFacade Facade
        {
            get;
        }

        public PreparationBoundary()
        {
            var accessor = new RequestContextAccessor
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                    [
                        new Claim("identity_kind", "admin_principal"),
                        new Claim("admin_id", "42"),
                        new Claim("admin_sid", "session-42"),
                        new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
                    ], "test"))
                }
            };
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["SITE_BASEURL"] = " https://site.test/ "
                }).Build();
            Facade = new(Store, accessor, configuration);
        }
    }

    private sealed class RequestContextAccessor : IHttpContextAccessor
    {
        public HttpContext? HttpContext
        {
            get; set;
        }
    }

    private sealed record Call(AuthorSavedViewOwner Owner, object? Input, CancellationToken Token);

    private sealed class CapturingStore : IAuthorSavedViewStore
    {
        public AuthorSavedView? View
        {
            get; set;
        }

        public List<Call> Calls
        {
            get;
        } = [];

        public Action? BeforeReturn
        {
            get; set;
        }

        public async Task<AuthorSavedView?> GetAsync(
            AuthorSavedViewOwner owner,
            Guid viewId,
            CancellationToken cancellationToken = default)
        {
            Calls.Add(new(owner, viewId, cancellationToken));
            await Task.Yield();
            BeforeReturn?.Invoke();
            return View;
        }

        // Preparation may only read individual saved views; an unexpected operation must fail.
        public Task<AuthorSavedViewPage> ListAsync(
            AuthorSavedViewOwner owner, AuthorSavedViewPageCursor? cursor, int limit,
            CancellationToken cancellationToken = default)
            => throw UnexpectedOperation();

        public Task<AuthorSavedViewVerificationResult> VerifyAsync(
            AuthorSavedViewOwner owner, CancellationToken cancellationToken = default)
            => throw UnexpectedOperation();

        public Task<AuthorSavedViewWriteReceipt> CreateAsync(
            CreateAuthorSavedViewCommand command, CancellationToken cancellationToken = default)
            => throw UnexpectedOperation();

        public Task<AuthorSavedViewWriteReceipt> UpdateAsync(
            UpdateAuthorSavedViewCommand command, CancellationToken cancellationToken = default)
            => throw UnexpectedOperation();

        public Task<AuthorSavedViewWriteReceipt> RenameAsync(
            RenameAuthorSavedViewCommand command, CancellationToken cancellationToken = default)
            => throw UnexpectedOperation();

        public Task<AuthorSavedViewWriteReceipt> SetPinnedAsync(
            SetAuthorSavedViewPinnedCommand command, CancellationToken cancellationToken = default)
            => throw UnexpectedOperation();

        public Task<AuthorSavedViewWriteReceipt> ReorderPinnedAsync(
            ReorderAuthorSavedViewsCommand command, CancellationToken cancellationToken = default)
            => throw UnexpectedOperation();

        public Task<AuthorSavedViewWriteReceipt> MovePinnedAsync(
            MoveAuthorSavedViewsCommand command, CancellationToken cancellationToken = default)
            => throw UnexpectedOperation();

        public Task<AuthorSavedViewWriteReceipt> SetDefaultAsync(
            SetDefaultAuthorSavedViewCommand command, CancellationToken cancellationToken = default)
            => throw UnexpectedOperation();

        public Task<AuthorSavedViewWriteReceipt> RetireAsync(
            RetireAuthorSavedViewCommand command, CancellationToken cancellationToken = default)
            => throw UnexpectedOperation();

        public Task<AuthorSavedViewWriteReceipt> DeleteAsync(
            DeleteAuthorSavedViewCommand command, CancellationToken cancellationToken = default)
            => throw UnexpectedOperation();

        private static InvalidOperationException UnexpectedOperation()
            => new("Preparation fixture admits GetAsync only.");
    }

    private sealed class MutableProvider : IAuthorSavedViewDependencyProvider
    {
        public AuthorSavedViewDependencyStatus Status { get; set; } = AuthorSavedViewDependencyStatus.Current;
        public string Revision { get; set; } = "taxonomy-1";
        public int Calls
        {
            get; set;
        }
        public Action? BeforeReturn
        {
            get; set;
        }

        public async ValueTask<AuthorSavedViewDependencyFact?> ResolveConditionAsync(
            AuthorSavedViewOwner owner, AuthorSavedViewCondition condition, CancellationToken cancellationToken = default)
        {
            Calls++;
            await Task.Yield();
            BeforeReturn?.Invoke();
            return new(condition.Field, condition.OperatorId, Status, Revision, [.. condition.Values]);
        }
        public ValueTask<AuthorSavedViewDependencyFact?> ResolveSortAsync(
            AuthorSavedViewOwner owner, AuthorSavedViewSort sort, CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyFact?>(null);
        public ValueTask<AuthorSavedViewDependencyFact?> ResolveProjectionAsync(
            AuthorSavedViewOwner owner, AuthorSavedViewFieldReference field, CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyFact?>(null);
    }

    private sealed class AlteredValidator(
        IAuthorSavedViewQueryValidator inner,
        Func<AuthorSavedViewQueryValidationResult, AuthorSavedViewQueryValidationResult> alteration) : IAuthorSavedViewQueryValidator
    {
        public async Task<AuthorSavedViewQueryValidationResult> ValidateAsync(
            AuthorSavedViewOwner owner, AuthorSavedViewQuery query, CancellationToken cancellationToken = default)
            => alteration(await inner.ValidateAsync(owner, query, cancellationToken));
    }
}
