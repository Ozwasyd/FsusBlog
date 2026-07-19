using System.Collections.Concurrent;
using System.Collections.Frozen;
using System.Net;
using System.Net.Http.Headers;
using System.Threading.RateLimiting;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Modules.Endpoints.Binary;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotReadCrossCuttingControlTests
{
    private static readonly DateTimeOffset s_cutoff = new(2026, 7, 15, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void StartupCatalog_CoversEveryControlAndExecutesRouteBoundaryProbes()
    {
        PublicHotReadCrossCuttingControlCatalog.ValidateOrThrow(
            WebApplicationCompositionExtensions.ApplicationPipelineStageDescriptors,
            WebApplicationCompositionExtensions.EndpointPipelineStageDescriptors);

        Assert.Equal(
            4,
            PublicHotReadCrossCuttingControlCatalog.All.Count(static control =>
                control.Coverage == PublicHotReadControlCoverage.GlobalBeforeBranch));
        Assert.Equal(
            2,
            PublicHotReadCrossCuttingControlCatalog.All.Count(static control =>
                control.Coverage == PublicHotReadControlCoverage.EarlyReplayed));
        Assert.Equal(
            7,
            PublicHotReadCrossCuttingControlCatalog.All.Count(static control =>
                control.Coverage == PublicHotReadControlCoverage.EndpointOnlyNotApplicable));
    }

    [Fact]
    public void StartupCatalog_FailsClosedWhenControlRoutePolicyOrEndpointMetadataDrifts()
    {
        PublicHotReadPipelineStageDescriptor[] applicationStages =
            [.. WebApplicationCompositionExtensions.ApplicationPipelineStageDescriptors];
        PublicHotReadPipelineStageDescriptor[] endpointStages =
            [.. WebApplicationCompositionExtensions.EndpointPipelineStageDescriptors];
        PublicHotReadRoutePolicy[] policies = [.. PublicHotReadRouteSecurityCatalog.All];
        Endpoint[] endpoints = [.. PublicHotReadEarlyEndpointCatalog.All];

        PublicHotReadCrossCuttingControl[] missingControl = PublicHotReadCrossCuttingControlCatalog.All
            .Where(static control => control.ControlId != "authorization")
            .ToArray();
        Assert.Throws<InvalidOperationException>(() => PublicHotReadCrossCuttingControlCatalog.ValidateOrThrow(
            applicationStages,
            endpointStages,
            missingControl,
            policies,
            endpoints));

        PublicHotReadPipelineStageDescriptor[] unregisteredSecurityStage =
        [
            .. endpointStages,
            new(
                "future-endpoint-security-control",
                PublicHotReadPipelineStageClassification.CrossCuttingControl,
                "future-endpoint-security-control")
        ];
        Assert.Throws<InvalidOperationException>(() => PublicHotReadCrossCuttingControlCatalog.ValidateOrThrow(
            applicationStages,
            unregisteredSecurityStage,
            PublicHotReadCrossCuttingControlCatalog.All,
            policies,
            endpoints));

        PublicHotReadRoutePolicy[] relaxedPolicies = [.. policies];
        relaxedPolicies[0] = relaxedPolicies[0] with
        {
            RequiresAnonymousRequest = false
        };
        Assert.Throws<InvalidOperationException>(() => PublicHotReadCrossCuttingControlCatalog.ValidateOrThrow(
            applicationStages,
            endpointStages,
            PublicHotReadCrossCuttingControlCatalog.All,
            relaxedPolicies,
            endpoints));

        Endpoint original = endpoints[0];
        PublicFastPathRouteMetadata metadata = Assert.IsType<PublicFastPathRouteMetadata>(
            original.Metadata.GetMetadata<PublicFastPathRouteMetadata>());
        object[] tamperedMetadata = original.Metadata
            .Where(static item => item is not PublicFastPathRouteMetadata)
            .Append(metadata with
            {
                RequiresSafeMethod = false
            })
            .ToArray();
        endpoints[0] = new Endpoint(
            original.RequestDelegate ?? throw new InvalidOperationException("synthetic endpoint delegate missing"),
            new EndpointMetadataCollection(tamperedMetadata),
            original.DisplayName);
        Assert.Throws<InvalidOperationException>(() => PublicHotReadCrossCuttingControlCatalog.ValidateOrThrow(
            applicationStages,
            endpointStages,
            PublicHotReadCrossCuttingControlCatalog.All,
            policies,
            endpoints));
    }

    [Fact]
    public void EndpointRateLimiterGuard_SuppressesASecondLeaseAfterEarlyReplay()
    {
        var context = new DefaultHttpContext();
        var endpoint = new Endpoint(static _ => Task.CompletedTask, new EndpointMetadataCollection(), "probe");
        var state = new PublicHotReadEarlyPipelineState(endpoint);
        state.MarkRateLimitEvaluated();
        context.Features.Set(state);

        Assert.False(PublicWebRuntime.ShouldRunEndpointRateLimiter(context));
        Assert.Equal(1, state.EndpointRateLimiterSkipCount);
    }

    [Fact]
    public async Task RequestPipeline_FastAndCanonicalCategoryResponsesAreByteIdentical()
    {
        byte[] payload = PodBinaryCodec.EncodeCategoryList([]);
        byte[] canonicalFrame = new AedsEncoder().Encode(AedsFrameType.CategoryList, payload);
        IUnifiedCache canonicalCache = Substitute.For<IUnifiedCache>();
        IOwnedFrameCache ownedFrameCache = Substitute.For<IOwnedFrameCache>();
        canonicalCache.GetStringAsync(
                CachePolicyId.TaxonomyFrameVersion,
                "main",
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<string?>(null));
        OwnedAedsFrame owner = OwnedAedsFrame.TakeOwnership(canonicalFrame, AedsFrameType.CategoryList);
        OwnedAedsFrameReadLease canonicalLease = owner.AcquireReadLease();
        owner.Retire();
        ownedFrameCache.TryGetOwnedFrameAsync(
                CachePolicyId.CategoryFrame,
                Arg.Any<string>(),
                AedsFrameType.CategoryList,
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new OwnedFrameCacheReadResult(true, canonicalLease)));
        IResult canonicalResult = await BinaryEndpoints.ReadCategoryAsync(
            Substitute.For<ISqlSugarClient>(),
            canonicalCache,
            ownedFrameCache,
            new AedsEncoder());
        var canonicalContext = new DefaultHttpContext();
        canonicalContext.Request.Method = HttpMethods.Get;
        canonicalContext.Request.Path = "/api/binary/category";
        canonicalContext.Response.Body = new MemoryStream();
        await canonicalResult.ExecuteAsync(canonicalContext);
        byte[] canonicalBytes = ((MemoryStream)canonicalContext.Response.Body).ToArray();

        PublicHotReadStore store = CreateCategoryStore(payload);
        var fallbackRequests = new ConcurrentQueue<string>();
        await using WebApplication app = await CreateRequestPipelineAsync(store, canonicalFrame, fallbackRequests);
        using HttpClient client = app.GetTestClient();

        using HttpResponseMessage fast = await client.GetAsync("/api/binary/category.aeds");
        byte[] fastBytes = await fast.Content.ReadAsByteArrayAsync();

        Assert.Equal(HttpStatusCode.OK, fast.StatusCode);
        Assert.Equal(StatusCodes.Status200OK, canonicalContext.Response.StatusCode);
        Assert.Equal(canonicalFrame, fastBytes);
        Assert.Equal(canonicalFrame, canonicalBytes);
        Assert.Equal(canonicalBytes, fastBytes);
        Assert.Empty(fallbackRequests);
        await ownedFrameCache.Received(1).TryGetOwnedFrameAsync(
            CachePolicyId.CategoryFrame,
            Arg.Any<string>(),
            AedsFrameType.CategoryList,
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task RequestPipeline_OnlyAnonymousSafeSameOriginArtifactReadUsesEarlyBranch()
    {
        byte[] payload = PodBinaryCodec.EncodeCategoryList([]);
        byte[] canonicalFrame = new AedsEncoder().Encode(AedsFrameType.CategoryList, payload);
        var canonicalRequests = new ConcurrentQueue<string>();
        await using WebApplication app = await CreateRequestPipelineAsync(
            CreateCategoryStore(payload),
            canonicalFrame,
            canonicalRequests);
        using HttpClient client = app.GetTestClient();

        using HttpResponseMessage anonymous = await client.GetAsync("/api/binary/category.aeds");
        Assert.False(anonymous.Headers.Contains("X-Test-Canonical-Pipeline"));

        using var loggedIn = new HttpRequestMessage(HttpMethod.Get, "/api/binary/category.aeds");
        loggedIn.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "test-session");
        using HttpResponseMessage loggedInResponse = await client.SendAsync(loggedIn);
        Assert.True(loggedInResponse.Headers.Contains("X-Test-Canonical-Pipeline"));

        using HttpResponseMessage admin = await client.GetAsync("/api/binary/admin/users");
        Assert.True(admin.Headers.Contains("X-Test-Canonical-Pipeline"));

        using HttpResponseMessage notification = await client.GetAsync("/api/notifications/stream");
        Assert.True(notification.Headers.Contains("X-Test-Canonical-Pipeline"));

        using HttpResponseMessage dynamicBinary = await client.GetAsync("/api/binary/article/42/related.aeds");
        Assert.True(dynamicBinary.Headers.Contains("X-Test-Canonical-Pipeline"));

        using var cors = new HttpRequestMessage(HttpMethod.Get, "/api/binary/category.aeds");
        cors.Headers.TryAddWithoutValidation("Origin", "https://cross-origin.invalid");
        using HttpResponseMessage corsResponse = await client.SendAsync(cors);
        Assert.True(corsResponse.Headers.Contains("X-Test-Canonical-Pipeline"));

        using var rejectedGatewayHeader = new HttpRequestMessage(HttpMethod.Get, "/api/binary/category.aeds");
        rejectedGatewayHeader.Headers.TryAddWithoutValidation("X-Fsus-User-Id", "42");
        using HttpResponseMessage rejectedGatewayHeaderResponse = await client.SendAsync(rejectedGatewayHeader);
        Assert.True(rejectedGatewayHeaderResponse.Headers.Contains("X-Test-Canonical-Pipeline"));

        using HttpResponseMessage unsafeMethod = await client.PostAsync(
            "/api/binary/category.aeds",
            new ByteArrayContent([]));
        Assert.True(unsafeMethod.Headers.Contains("X-Test-Canonical-Pipeline"));

        Assert.Equal(7, canonicalRequests.Count);
    }

    [Fact]
    public async Task RequestPipeline_ArtifactMissRunsRequestAuditContextExactlyOnce()
    {
        var store = new PublicHotReadStore(timeProvider: new FixedTimeProvider(s_cutoff));
        store.Publish(VerifiedSnapshot(category: default));
        byte[] canonicalFrame = new AedsEncoder().Encode(
            AedsFrameType.CategoryList,
            PodBinaryCodec.EncodeCategoryList([]));
        var canonicalRequests = new ConcurrentQueue<string>();
        PublicHotReadEarlyPipelineState? observedState = null;
        await using WebApplication app = await CreateRequestPipelineAsync(
            store,
            canonicalFrame,
            canonicalRequests,
            state => observedState = state);
        using HttpClient client = app.GetTestClient();

        using HttpResponseMessage response = await client.GetAsync("/api/binary/article/42.aeds");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Single(canonicalRequests);
        PublicHotReadEarlyPipelineState state = Assert.IsType<PublicHotReadEarlyPipelineState>(observedState);
        Assert.Equal(1, state.RequestAuditContextExecutionCount);
        Assert.Equal(1, state.EndpointRequestAuditContextSkipCount);
    }

    [Fact]
    public async Task RequestPipeline_RateLimiterRunsExactlyOnceForArtifactHitAndMiss()
    {
        byte[] payload = PodBinaryCodec.EncodeCategoryList([]);
        byte[] canonicalFrame = new AedsEncoder().Encode(AedsFrameType.CategoryList, payload);

        int hitLeaseCount = 0;
        PublicHotReadEarlyPipelineState? hitState = null;
        var hitCanonicalRequests = new ConcurrentQueue<string>();
        await using (WebApplication hitApp = await CreateRequestPipelineAsync(
            CreateCategoryStore(payload),
            canonicalFrame,
            hitCanonicalRequests,
            state => hitState = state,
            () => Interlocked.Increment(ref hitLeaseCount)))
        {
            using HttpClient client = hitApp.GetTestClient();
            using HttpResponseMessage response = await client.GetAsync("/api/binary/category.aeds");

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Empty(hitCanonicalRequests);
            Assert.Equal(1, hitLeaseCount);
            PublicHotReadEarlyPipelineState state = Assert.IsType<PublicHotReadEarlyPipelineState>(hitState);
            Assert.True(state.RateLimitEvaluated);
            Assert.Equal(0, state.EndpointRateLimiterSkipCount);
        }

        int missLeaseCount = 0;
        PublicHotReadEarlyPipelineState? missState = null;
        var missCanonicalRequests = new ConcurrentQueue<string>();
        var missStore = new PublicHotReadStore(timeProvider: new FixedTimeProvider(s_cutoff));
        missStore.Publish(VerifiedSnapshot(category: default));
        await using (WebApplication missApp = await CreateRequestPipelineAsync(
            missStore,
            canonicalFrame,
            missCanonicalRequests,
            state => missState = state,
            () => Interlocked.Increment(ref missLeaseCount)))
        {
            using HttpClient client = missApp.GetTestClient();
            using HttpResponseMessage response = await client.GetAsync("/api/binary/article/42.aeds");

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Single(missCanonicalRequests);
            Assert.Equal(1, missLeaseCount);
            PublicHotReadEarlyPipelineState state = Assert.IsType<PublicHotReadEarlyPipelineState>(missState);
            Assert.True(state.RateLimitEvaluated);
            Assert.Equal(1, state.EndpointRateLimiterSkipCount);
        }
    }

    [Fact]
    public void ProjectorMaterializer_OnlyPublishedDueSourcesEnterFrames()
    {
        DateTime cutoff = s_cutoff.UtcDateTime;
        ArticleDetailReadModel[] candidates =
        [
            Candidate(1, ArticleStatus.Draft),
            Candidate(6, ArticleStatus.Scheduled),
            Candidate(2, ArticleStatus.Archived),
            Candidate(7, ArticleStatus.Deleted),
            Candidate(3, ArticleStatus.Published, isDeleted: true),
            Candidate(4, ArticleStatus.Published, publishedAt: cutoff.AddMinutes(1)),
            Candidate(5, ArticleStatus.Published, scheduledPublishAt: cutoff.AddMinutes(1))
        ];

        Assert.Equal(
            Enum.GetValues<ArticleStatus>()
                .Where(static status => status != ArticleStatus.Published)
                .OrderBy(static status => status),
            candidates
                .Where(static candidate => candidate.Status != ArticleStatus.Published)
                .Select(static candidate => candidate.Status)
                .Distinct()
                .OrderBy(static status => status));

        Dictionary<int, PublicBinaryArtifact> materialized =
            PublicHotArtifactProjector.MaterializeVisibilityCheckedArticleFrames(
                candidates,
                cutoff,
                s_cutoff.ToUnixTimeMilliseconds(),
                new PublicHotReadOptions(),
                new AedsEncoder());

        Assert.Empty(materialized);
    }

    [Fact]
    public void PublicationEvidence_BindsPublicSourceVisibilityAndVersionFailClosed()
    {
        long version = s_cutoff.ToUnixTimeMilliseconds();
        PublicHotReadPublicationEvidence evidence =
            PublicHotReadPublicationEvidence.CreateVerified(version, s_cutoff);
        Assert.Equal(PublicHotReadPublicationEvidence.PublicSourceVisibility, evidence.SourceVisibility);
        Assert.Equal(version, evidence.SourceVersion);
        Assert.True(evidence.IsVerifiedFor(version));

        var store = new PublicHotReadStore(timeProvider: new FixedTimeProvider(s_cutoff));
        PublicHotReadSnapshot invalid = new(
            version,
            FrozenDictionary<int, PublicBinaryArtifact>.Empty,
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            default,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            evidence with
            {
                SourceVisibility = "private"
            });

        Assert.Throws<InvalidOperationException>(() => store.Publish(invalid));
        Assert.False(store.IsReady);
    }

    private static async Task<WebApplication> CreateRequestPipelineAsync(
        PublicHotReadStore store,
        byte[] canonicalFrame,
        ConcurrentQueue<string> canonicalRequests,
        Action<PublicHotReadEarlyPipelineState?>? observeState = null,
        Action? observeRateLimitLease = null)
    {
        var applicationOptions = new WebApplicationOptions
        {
            EnvironmentName = Environments.Development
        };
        WebApplicationBuilder builder = WebApplication.CreateBuilder(applicationOptions);
        builder.WebHost.UseTestServer();
        builder.Services.Configure<PublicHotReadOptions>(static options => options.Enabled = true);
        builder.Services.AddSingleton(store);
        builder.Services.AddSingleton<PublicHotReadCounters>();
        builder.Services.AddSingleton<PublicHotReadClassifierCounters>();
        builder.Services.AddSingleton<PublicHotReadEarlyDataPlaneRuntimeState>();
        builder.Services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.AddPolicy(
                "public_read",
                _ =>
                {
                    observeRateLimitLease?.Invoke();
                    return RateLimitPartition.GetNoLimiter("unit");
                });
        });

        WebApplication app = builder.Build();
        app.UseFsusPublicHotReadClassifier();
        app.UseFsusPublicHotReadRequestAuditContext();
        app.UseFsusPublicHotReadRateLimiter();
        app.Use(async (context, next) =>
        {
            observeState?.Invoke(context.Features.Get<PublicHotReadEarlyPipelineState>());
            await next(context);
        });
        app.UseFsusPublicHotReadFastPath();
        app.UseFsusPublicHotReadFallbackRestore();
        app.UseFsusEndpointRateLimiter();
        app.UseFsusEndpointRequestAuditContext();
        app.Run(async context =>
        {
            canonicalRequests.Enqueue(context.Request.Path.Value ?? string.Empty);
            context.Response.Headers["X-Test-Canonical-Pipeline"] = "1";
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "application/octet-stream";
            context.Response.ContentLength = canonicalFrame.Length;
            await context.Response.BodyWriter.WriteAsync(canonicalFrame, context.RequestAborted);
        });
        await app.StartAsync();
        return app;
    }

    private static PublicHotReadStore CreateCategoryStore(byte[] payload)
    {
        long version = s_cutoff.ToUnixTimeMilliseconds();
        var options = new PublicHotReadOptions();
        PublicBinaryArtifact category = PublicHotReadBinaryArtifactFactory.FromPayload(
            new AedsEncoder(),
            AedsFrameType.CategoryList,
            payload,
            options.CacheControl,
            version,
            options);
        var store = new PublicHotReadStore(timeProvider: new FixedTimeProvider(s_cutoff));
        store.Publish(VerifiedSnapshot(category));
        return store;
    }

    private static PublicHotReadSnapshot VerifiedSnapshot(PublicBinaryArtifact category)
    {
        long version = s_cutoff.ToUnixTimeMilliseconds();
        return new(
            version,
            FrozenDictionary<int, PublicBinaryArtifact>.Empty,
            FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty,
            category,
            default,
            FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(version, s_cutoff));
    }

    private static ArticleDetailReadModel Candidate(
        int id,
        ArticleStatus status,
        bool isDeleted = false,
        DateTime? publishedAt = null,
        DateTime? scheduledPublishAt = null)
        => new()
        {
            Id = id,
            Status = status,
            IsDeleted = isDeleted,
            PublishedAt = publishedAt ?? s_cutoff.UtcDateTime.AddMinutes(-1),
            ScheduledPublishAt = scheduledPublishAt
        };

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
