using System.Net;
using System.Security.Claims;
using System.Text.Json;
using System.Threading.RateLimiting;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

public sealed class ModerationConsoleContractTests
{
    [Fact]
    public async Task AuthoringEndpoints_ExposeModerationMethodsPermissionsAndRateLimitMetadata()
    {
        IModerationDictionaryService dictionaries = Substitute.For<IModerationDictionaryService>();
        IAdminPrincipalService adminPrincipals = Substitute.For<IAdminPrincipalService>();
        IAuditEventService auditEvents = Substitute.For<IAuditEventService>();
        ICacheInvalidationDispatcher invalidation = Substitute.For<ICacheInvalidationDispatcher>();
        await using WebApplication server = await CreateServerAsync(dictionaries, adminPrincipals, auditEvents, invalidation);
        IEnumerable<EndpointDataSource> sources = ((IEndpointRouteBuilder)server).DataSources;

        AssertEndpoint(sources, "/api/binary/author/moderation/dictionaries", HttpMethods.Get, rateLimited: false);
        AssertEndpoint(sources, "/api/binary/author/moderation/runtime/status", HttpMethods.Get, rateLimited: false);
        AssertEndpoint(sources, "/api/binary/author/moderation/runtime/global-state", HttpMethods.Post, rateLimited: true);
        AssertEndpoint(sources, "/api/binary/author/moderation/runtime/region-state", HttpMethods.Post, rateLimited: true);
        AssertEndpoint(sources, "/api/binary/author/moderation/dictionaries/reload", HttpMethods.Post, rateLimited: true);
        AssertEndpoint(sources, "/api/binary/author/moderation/dictionaries/rollback", HttpMethods.Post, rateLimited: true);
        AssertEndpoint(sources, "/api/binary/author/moderation/dictionaries/{dictionaryId}/enable", HttpMethods.Post, rateLimited: true);
        AssertEndpoint(sources, "/api/binary/author/moderation/dictionaries/{dictionaryId}/disable", HttpMethods.Post, rateLimited: true);
    }

    [Fact]
    public async Task ReloadAndRollbackEndpoints_EnforcePermissionAndStepUpThenAuditAndInvalidate()
    {
        ModerationDictionaryRuntimeSnapshot snapshot = RuntimeSnapshot();
        IModerationDictionaryService dictionaries = Substitute.For<IModerationDictionaryService>();
        dictionaries.GetRuntimeSnapshot().Returns(snapshot);
        dictionaries.Reload().Returns(Result.Success());
        dictionaries.Rollback().Returns(Result.Success());
        IAdminPrincipalService adminPrincipals = Substitute.For<IAdminPrincipalService>();
        adminPrincipals.ValidateAndConsumeAdminStepUpProofTokenAsync(
                Arg.Any<long>(),
                Arg.Any<string>(),
                "admin-sensitive",
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(true);
        IAuditEventService auditEvents = Substitute.For<IAuditEventService>();
        ICacheInvalidationDispatcher invalidation = Substitute.For<ICacheInvalidationDispatcher>();
        await using WebApplication server = await CreateServerAsync(dictionaries, adminPrincipals, auditEvents, invalidation);
        using HttpClient client = server.GetTestClient();

        using var forbidden = new HttpRequestMessage(HttpMethod.Post, "/api/binary/author/moderation/dictionaries/reload");
        forbidden.Headers.Add("Origin", "https://console.example.test");
        forbidden.Headers.Add("X-Fsus-Mfa-Proof", "proof-forbidden");
        using HttpResponseMessage forbiddenResponse = await client.SendAsync(forbidden);
        Assert.Equal(HttpStatusCode.Forbidden, forbiddenResponse.StatusCode);

        using var missingStepUp = CreateAdminRequest("/api/binary/author/moderation/dictionaries/reload", proof: null);
        using HttpResponseMessage missingStepUpResponse = await client.SendAsync(missingStepUp);
        Assert.Equal((HttpStatusCode)StatusCodes.Status428PreconditionRequired, missingStepUpResponse.StatusCode);

        using var reload = CreateAdminRequest("/api/binary/author/moderation/dictionaries/reload", "proof-reload");
        using var rollback = CreateAdminRequest("/api/binary/author/moderation/dictionaries/rollback", "proof-rollback");
        using HttpResponseMessage reloadResponse = await client.SendAsync(reload);
        using HttpResponseMessage rollbackResponse = await client.SendAsync(rollback);

        Assert.Equal(HttpStatusCode.OK, reloadResponse.StatusCode);
        Assert.Equal(HttpStatusCode.OK, rollbackResponse.StatusCode);
        _ = dictionaries.Received(1).Reload();
        _ = dictionaries.Received(1).Rollback();
        await adminPrincipals.Received(2).ValidateAndConsumeAdminStepUpProofTokenAsync(
            39,
            "admin-session-39",
            "admin-sensitive",
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
        await auditEvents.Received(1).RecordHighValueAsync(
            Arg.Is<AuditEvent>(item => item.Action == "admin.moderation.dictionary_reloaded"
                && item.Outcome == AuditOutcomeCatalog.Success),
            Arg.Any<CancellationToken>());
        await auditEvents.Received(1).RecordHighValueAsync(
            Arg.Is<AuditEvent>(item => item.Action == "admin.moderation.dictionary_rolled_back"
                && item.Outcome == AuditOutcomeCatalog.Success),
            Arg.Any<CancellationToken>());
        await invalidation.Received(2).InvalidateCommentMutationAsync(null, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task GlobalRuntimeEndpoint_DeserializesMutationThenAuditsAndInvalidatesChangedState()
    {
        var request = new ModerationRuntimeGlobalStateRequest(
            State: ModerationGlobalStates.DisabledToPending,
            Reason: "provider incident");
        var requestContext = new FixedJsonRequestContext(
            AedsFrameType.ModerationRuntimeGlobalStateRequest,
            JsonSerializer.SerializeToUtf8Bytes(request, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        IModerationDictionaryService dictionaries = Substitute.For<IModerationDictionaryService>();
        IAdminPrincipalService adminPrincipals = Substitute.For<IAdminPrincipalService>();
        adminPrincipals.ValidateAndConsumeAdminStepUpProofTokenAsync(
                Arg.Any<long>(),
                Arg.Any<string>(),
                "admin-sensitive",
                Arg.Any<string>(),
                Arg.Any<CancellationToken>())
            .Returns(true);
        IAuditEventService auditEvents = Substitute.For<IAuditEventService>();
        ICacheInvalidationDispatcher invalidation = Substitute.For<ICacheInvalidationDispatcher>();
        IModerationRuntimeStateService runtimeState = Substitute.For<IModerationRuntimeStateService>();
        runtimeState.SetGlobalState(
                ModerationGlobalStates.DisabledToPending,
                "provider incident",
                null,
                Arg.Any<string>())
            .Returns(Result<ModerationRuntimeSnapshot>.Success(RuntimeStateSnapshot()));
        await using WebApplication server = await CreateServerAsync(
            dictionaries,
            adminPrincipals,
            auditEvents,
            invalidation,
            runtimeState,
            requestContext);
        using HttpClient client = server.GetTestClient();
        using var mutation = CreateAdminRequest(
            "/api/binary/author/moderation/runtime/global-state",
            "proof-global");

        using HttpResponseMessage response = await client.SendAsync(mutation);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        _ = runtimeState.Received(1).SetGlobalState(
            ModerationGlobalStates.DisabledToPending,
            "provider incident",
            null,
            Arg.Any<string>());
        await auditEvents.Received(1).RecordHighValueAsync(
            Arg.Is<AuditEvent>(item => item.Action == "admin.moderation.runtime_global_state_changed"
                && item.Outcome == AuditOutcomeCatalog.Success),
            Arg.Any<CancellationToken>());
        await invalidation.Received(1).InvalidateCommentMutationAsync(null, Arg.Any<CancellationToken>());
    }

    [Fact]
    public void RuntimeDictionarySerialization_ExposesCountsAndEvidencePolicyWithoutRawTerms()
    {
        string json = JsonSerializer.Serialize(
            RuntimeSnapshot(),
            new JsonSerializerOptions(JsonSerializerDefaults.Web));

        Assert.Contains("\"termCount\":3", json, StringComparison.Ordinal);
        Assert.Contains("\"evidencePolicy\":\"show_category_only\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("raw-secret-term", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("\"terms\"", json, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<WebApplication> CreateServerAsync(
        IModerationDictionaryService dictionaries,
        IAdminPrincipalService adminPrincipals,
        IAuditEventService auditEvents,
        ICacheInvalidationDispatcher invalidation,
        IModerationRuntimeStateService? runtimeState = null,
        IBinaryEndpointRequestContext? requestContext = null)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["CORS_ALLOWED_HOSTS"] = "https://console.example.test"
        });
        builder.Services.AddRouting();
        builder.Services.AddAuthorization();
        builder.Services.AddSingleton<IAuthorizationMiddlewareResultHandler, TestAuthorizationResultHandler>();
        builder.Services.AddRateLimiter(options => options.AddFixedWindowLimiter("fixed_ip", limiter =>
                {
                    limiter.PermitLimit = 100;
                    limiter.QueueLimit = 0;
                    limiter.Window = TimeSpan.FromMinutes(1);
                    limiter.AutoReplenishment = true;
                }));
        builder.Services.AddSingleton<IAedsEncoder>(new AedsEncoder());
        builder.Services.AddSingleton(dictionaries);
        builder.Services.AddSingleton(adminPrincipals);
        builder.Services.AddSingleton(auditEvents);
        builder.Services.AddSingleton(invalidation);
        builder.Services.AddSingleton(runtimeState ?? Substitute.For<IModerationRuntimeStateService>());
        builder.Services.AddSingleton(Substitute.For<IAuthoringAnalyticsReader>());
        builder.Services.AddSingleton(Substitute.For<IAuthoringAssetQuery>());
        builder.Services.AddSingleton(Substitute.For<IAuthoringAssetCommands>());
        builder.Services.AddSingleton(Substitute.For<IAuthoringDraftLifecycle>());
        builder.Services.AddSingleton(Substitute.For<IAuthoringPrepublishPolicy>());
        builder.Services.AddSingleton(Substitute.For<IAuthoringContentExport>());
        builder.Services.AddSingleton(Substitute.For<IAuthoringContentImport>());
        builder.Services.AddSingleton(Substitute.For<IAuthoringAiAssist>());
        builder.Services.AddSingleton(Substitute.For<IAuthoringModerationQueue>());
        builder.Services.AddSingleton(Substitute.For<IAuthoringModerationCommands>());
        builder.Services.AddSingleton(Substitute.For<IArticleResponsibilityAuthoringService>());
        builder.Services.AddSingleton(Substitute.For<IArticleCommentPolicyService>());
        builder.Services.AddSingleton(Substitute.For<ICommentAuthorManagementService>());
        builder.Services.AddSingleton(Substitute.For<ICommentGovernanceService>());
        builder.Services.AddSingleton(Substitute.For<IAdminArtifactOperations>());
        builder.Services.AddSingleton(Substitute.For<IAdminCacheDiagnosticsReader>());
        builder.Services.AddSingleton(Substitute.For<IAdminOperationsHealthReader>());
        builder.Services.AddSingleton(Substitute.For<IAdminBackupStatusReader>());
        builder.Services.AddSingleton(Substitute.For<IAdminDangerousOperationPolicyReader>());
        builder.Services.AddSingleton<IAdminIntegrityOperations>(_ => null!);
        builder.Services.AddSingleton<AuditQueryService>(_ => null!);
        builder.Services.AddSingleton(Substitute.For<IAnonymousCommentPolicyService>());
        builder.Services.AddSingleton(Substitute.For<IAnonymousCredentialService>());
        builder.Services.AddSingleton(Substitute.For<ICommentAnonymousNullifierService>());
        builder.Services.AddSingleton(Substitute.For<IModerationRegionCatalogService>());
        builder.Services.AddSingleton(Substitute.For<IRegionLegalModerationService>());
        builder.Services.AddSingleton(Substitute.For<ISqlSugarClient>());
        if (requestContext is not null)
        {
            builder.Services.AddSingleton(requestContext);
        }
        WebApplication app = builder.Build();
        app.UseRouting();
        app.Use(async (context, next) =>
                {
                    var claims = new List<Claim>
                    {
                        new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                        new("admin_id", "39"),
                        new("admin_sid", "admin-session-39")
                    };
                    if (context.Request.Headers["X-Test-Permission"] == AdminPermissions.SystemConfig)
                    {
                        claims.Add(new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.SystemConfig));
                    }

                    context.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test"));
                    await next();
                });
        app.UseAuthorization();
        app.UseRateLimiter();
        app.MapAuthoringEndpoints();
        await app.StartAsync();
        return app;
    }

    private static HttpRequestMessage CreateAdminRequest(string path, string? proof)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path);
        request.Headers.Add("Origin", "https://console.example.test");
        request.Headers.Add("X-Test-Permission", AdminPermissions.SystemConfig);
        if (proof is not null)
        {
            request.Headers.Add("X-Fsus-Mfa-Proof", proof);
        }

        return request;
    }

    private sealed class TestAuthorizationResultHandler : IAuthorizationMiddlewareResultHandler
    {
        public Task HandleAsync(
            RequestDelegate next,
            HttpContext context,
            AuthorizationPolicy policy,
            PolicyAuthorizationResult authorizeResult)
        {
            if (authorizeResult.Succeeded)
            {
                return next(context);
            }

            context.Response.StatusCode = authorizeResult.Forbidden
                ? StatusCodes.Status403Forbidden
                : StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        }
    }

    private static ModerationDictionaryRuntimeSnapshot RuntimeSnapshot()
        => new(
            SnapshotId: "snapshot-1039",
            Version: "2026-07",
            Checksum: "checksum-1039",
            CreatedAtUtc: DateTime.UtcNow,
            Dictionaries:
            [
                new ModerationDictionaryRuntimeItem(
                    DictionaryId: "global.example",
                    Version: "1",
                    Scope: "global",
                    Region: null,
                    Category: "example",
                    Source: "reviewed-config",
                    ReviewedBy: "reviewer",
                    UpdatedAtUtc: DateTime.UtcNow,
                    Checksum: "dictionary-checksum",
                    EvidencePolicy: ModerationEvidencePolicies.ShowCategoryOnly,
                    TermCount: 3)
            ],
            RegionPolicies: [],
            LastError: null);

    private static ModerationRuntimeSnapshot RuntimeStateSnapshot()
    {
        DateTime now = DateTime.UtcNow;
        var model = new ModerationModelRuntimeSnapshot(
            SnapshotId: "model-1039",
            Enabled: false,
            Provider: "none",
            ModelProfile: "disabled",
            ThresholdProfile: "default",
            ContractVersion: "1",
            ConfigChecksum: "model-checksum",
            LoadedAtUtc: now,
            LoadedBy: "admin",
            Status: "ready",
            TimeoutMs: 800,
            FailOpen: false,
            LastError: null,
            RuntimePath: null,
            RuntimeChannel: "stable",
            BuiltInRuntime: null);
        return new ModerationRuntimeSnapshot(
            SnapshotId: "runtime-1039",
            GlobalState: ModerationGlobalStates.DisabledToPending,
            RegionStates: new Dictionary<string, string>(StringComparer.Ordinal),
            DisabledDictionaryIds: new HashSet<string>(StringComparer.Ordinal),
            Model: model,
            ChangedAtUtc: now,
            ChangedBy: "39",
            Reason: "provider incident",
            ExpiresAtUtc: null,
            LastError: null);
    }

    private static void AssertEndpoint(IEnumerable<EndpointDataSource> sources, string path, string method, bool rateLimited)
    {
        RouteEndpoint endpoint = Assert.Single(
            sources.SelectMany(static source => source.Endpoints).OfType<RouteEndpoint>(),
            item => string.Equals(
                item.RoutePattern.RawText?.Trim('/'),
                path.Trim('/'),
                StringComparison.Ordinal));
        Assert.Contains(method, Assert.IsAssignableFrom<IHttpMethodMetadata>(
            endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()).HttpMethods);
        AuthorizationPolicy policy = Assert.Single(endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>());
        ClaimsAuthorizationRequirement permission = Assert.Single(
            policy.Requirements.OfType<ClaimsAuthorizationRequirement>(),
            item => item.ClaimType == AdminPermissions.PermissionClaimType);
        Assert.Contains(AdminPermissions.SystemConfig, permission.AllowedValues ?? []);
        EnableRateLimitingAttribute? rateLimit = endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>();
        if (rateLimited)
        {
            Assert.Equal("fixed_ip", Assert.IsType<EnableRateLimitingAttribute>(rateLimit).PolicyName);
        }
        else
        {
            Assert.Null(rateLimit);
        }
    }

    private sealed class FixedJsonRequestContext(
        AedsFrameType expectedFrameType,
        byte[] payload) : IBinaryEndpointRequestContext
    {
        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            AedsFrameType expected,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
        {
            Assert.Equal(expectedFrameType, expected);
            return Task.FromResult(BinaryRequestPayload.Success(payload));
        }

        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            IReadOnlyCollection<AedsFrameType> expected,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
        {
            Assert.Contains(expectedFrameType, expected);
            return Task.FromResult(BinaryRequestPayload.Success(payload));
        }

        public Task<NameMutationPayload> ReadNameMutationAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            AedsFrameType expected,
            CancellationToken cancellationToken)
            => throw new NotSupportedException();

        public string BuildArticleViewerIdentity(HttpContext context, int articleId)
            => throw new NotSupportedException();

        public ValueTask<long> GetArticleListCacheVersionAsync(ICacheStringReader cache)
            => throw new NotSupportedException();

        public string BuildArticleListCacheIdentity(
            long version,
            int page,
            int size,
            int? categoryId,
            int? tagId,
            bool isDeleted,
            int? status = null,
            bool includePrivate = false,
            string keyword = "")
            => throw new NotSupportedException();

        public string BuildArticleHotCacheIdentity(int count)
            => throw new NotSupportedException();

        public string? GetDeviceFingerprint(HttpContext context) => null;

        public bool TryReadMfaProof(HttpContext context, out string proofToken)
        {
            proofToken = string.Empty;
            return false;
        }
    }
}
