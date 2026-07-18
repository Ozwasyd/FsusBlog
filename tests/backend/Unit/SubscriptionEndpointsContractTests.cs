using System.Net;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Subscriptions;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class SubscriptionEndpointsContractTests(PostgresSchemaMigrationFixture fixture)
{
    private const string Pepper = "unit-test-subscription-email-hash-pepper-with-enough-entropy";
    private static readonly DateTimeOffset BaselineNow = new(2026, 7, 11, 9, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task SubscribeAsync_RepeatedCurrentHmacSubscriptionPersistsOneEnabledRowWithoutLegacyHash()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        IConfiguration configuration = CreateConfiguration();
        var firstRequest = new SiteSubscriptionBinaryRequest(" Reader@Example.COM ", "EMAIL");
        var secondRequest = new SiteSubscriptionBinaryRequest("reader@example.com", "email");

        SiteSubscriptionBinaryResponse? first = await SubscriptionEndpoints.SubscribeAsync(
            firstRequest,
            db,
            configuration,
            CancellationToken.None);
        SiteSubscriptionBinaryResponse? second = await SubscriptionEndpoints.SubscribeAsync(
            secondRequest,
            db,
            configuration,
            CancellationToken.None);

        SiteSubscription row = await db.Queryable<SiteSubscription>().SingleAsync();
        string expectedHmac = ExpectedHmac("reader@example.com");
        string legacySha256 = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("reader@example.com")));
        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.True(first.Subscribed);
        Assert.True(second.Subscribed);
        Assert.Equal("email", row.Channel);
        Assert.True(row.IsEnabled);
        Assert.Null(row.UnsubscribedAt);
        Assert.Equal(expectedHmac, row.EmailHash);
        Assert.Equal(SiteSubscriptionIdentity.CurrentHashVersion, row.HashVersion);
        Assert.NotEqual(legacySha256, row.EmailHash);
        Assert.Equal(1, await db.Queryable<SiteSubscription>().CountAsync());
        Assert.Equal(0, await db.Queryable<SiteSubscription>().Where(item => item.EmailHash == legacySha256).CountAsync());
    }

    [Theory]
    [InlineData("missing", "proof_replayed_or_missing")]
    [InlineData("expired", "proof_expired")]
    [InlineData("wrong-email", "email_hash_mismatch")]
    [InlineData("wrong-channel", "channel_mismatch")]
    public async Task UnsubscribePipeline_InvalidOwnershipProofDoesNotMutatePostgres(
        string scenario,
        string expectedReason)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        IConfiguration configuration = CreateConfiguration();
        await SeedSubscriptionAsync(db, configuration);
        var cache = new MemoryProofCache();
        var clock = new MutableTimeProvider(BaselineNow);
        var proofService = new SiteSubscriptionProofService(cache, clock, configuration);
        string proofToken;

        switch (scenario)
        {
            case "missing":
                proofToken = "fsu_unsub_missing";
                break;
            case "expired":
                proofToken = (await proofService.IssueUnsubscribeProofAsync(
                    new SiteSubscriptionUnsubscribeProofIssueRequest("reader@example.com", "email", TimeSpan.FromMinutes(15))))
                    .ProofToken;
                clock.UtcNow = BaselineNow.AddMinutes(16);
                break;
            case "wrong-email":
                proofToken = (await proofService.IssueUnsubscribeProofAsync(
                    new SiteSubscriptionUnsubscribeProofIssueRequest("other@example.com", "email", TimeSpan.FromMinutes(15))))
                    .ProofToken;
                break;
            case "wrong-channel":
                proofToken = (await proofService.IssueUnsubscribeProofAsync(
                    new SiteSubscriptionUnsubscribeProofIssueRequest("reader@example.com", "rss", TimeSpan.FromMinutes(15))))
                    .ProofToken;
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(scenario));
        }

        EndpointResponse response = await ExecuteHandlerAsync(
            db,
            configuration,
            proofService,
            new SiteSubscriptionBinaryRequest("reader@example.com", "email"),
            proofToken);

        Assert.Equal(StatusCodes.Status428PreconditionRequired, response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, response.Frame.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(response.Frame.Payload, out var error));
        Assert.Equal(expectedReason, PodBinaryCodec.ToErrorDetail(error).Message);
        SiteSubscription row = await db.Queryable<SiteSubscription>().SingleAsync();
        Assert.True(row.IsEnabled);
        Assert.Null(row.UnsubscribedAt);
    }

    [Fact]
    public async Task UnsubscribePipeline_DatabaseFailureLeavesValidatedProofUncommitted()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        IConfiguration configuration = CreateConfiguration();
        await SeedSubscriptionAsync(db, configuration);
        var cache = new MemoryProofCache();
        var clock = new MutableTimeProvider(BaselineNow);
        var proofService = new SiteSubscriptionProofService(cache, clock, configuration);
        SiteSubscriptionUnsubscribeProofIssueResult issued = await proofService.IssueUnsubscribeProofAsync(
            new SiteSubscriptionUnsubscribeProofIssueRequest("reader@example.com", "email", TimeSpan.FromMinutes(15)));
        var request = new SiteSubscriptionBinaryRequest("reader@example.com", "email");
        DefaultHttpContext context = CreateHttpContext(request, issued.ProofToken);
        var aeds = new AedsEncoder();
        await db.Ado.ExecuteCommandAsync("DROP TABLE site_subscription;");

        await Assert.ThrowsAnyAsync<Exception>(() => BinaryEndpoints.HandleSiteSubscriptionAsync(
            context,
            db,
            aeds,
            configuration,
            subscribe: false,
            CancellationToken.None,
            proofService));

        SiteSubscriptionUnsubscribeProofConsumeResult stillUsable = await proofService.ValidateUnsubscribeProofAsync(
            new SiteSubscriptionUnsubscribeProofConsumeRequest(
                issued.ProofToken,
                "reader@example.com",
                "email"));
        Assert.True(stillUsable.Accepted);
        Assert.Equal(0, cache.ConsumeCalls);
    }

    [Fact]
    public async Task UnsubscribePipeline_SuccessMutatesRowAndConsumesProofExactlyOnce()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        IConfiguration configuration = CreateConfiguration();
        await SeedSubscriptionAsync(db, configuration);
        var cache = new MemoryProofCache();
        var proofService = new SiteSubscriptionProofService(
            cache,
            new MutableTimeProvider(BaselineNow),
            configuration);
        SiteSubscriptionUnsubscribeProofIssueResult issued = await proofService.IssueUnsubscribeProofAsync(
            new SiteSubscriptionUnsubscribeProofIssueRequest("reader@example.com", "email", TimeSpan.FromMinutes(15)));
        var request = new SiteSubscriptionBinaryRequest("reader@example.com", "email");

        EndpointResponse first = await ExecuteHandlerAsync(db, configuration, proofService, request, issued.ProofToken);
        EndpointResponse replay = await ExecuteHandlerAsync(db, configuration, proofService, request, issued.ProofToken);

        Assert.Equal(StatusCodes.Status200OK, first.StatusCode);
        Assert.Equal(AedsFrameType.SiteSubscriptionResponse, first.Frame.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeSiteSubscriptionResponse(first.Frame.Payload, out SiteSubscriptionBinaryResponse body));
        Assert.False(body.Subscribed);
        Assert.True(body.Unsubscribed);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, replay.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, replay.Frame.FrameType);
        SiteSubscription row = await db.Queryable<SiteSubscription>().SingleAsync();
        Assert.False(row.IsEnabled);
        Assert.NotNull(row.UnsubscribedAt);
        Assert.Equal(1, cache.ConsumeCalls);
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(SiteSubscription));
        return db;
    }

    private static async Task SeedSubscriptionAsync(SqlSugarClient db, IConfiguration configuration)
    {
        SiteSubscriptionBinaryResponse? response = await SubscriptionEndpoints.SubscribeAsync(
            new SiteSubscriptionBinaryRequest("reader@example.com", "email"),
            db,
            configuration,
            CancellationToken.None);
        Assert.NotNull(response);
        Assert.True(response.Subscribed);
    }

    private static IConfiguration CreateConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [SiteSubscriptionIdentity.EmailHashPepperConfigurationKey] = Pepper
            })
            .Build();

    private static string ExpectedHmac(string normalizedEmail)
        => Convert.ToHexStringLower(HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(Pepper),
            Encoding.UTF8.GetBytes(normalizedEmail)));

    private static async Task<EndpointResponse> ExecuteHandlerAsync(
        ISqlSugarClient db,
        IConfiguration configuration,
        ISiteSubscriptionProofService proofService,
        SiteSubscriptionBinaryRequest request,
        string proofToken)
    {
        var aeds = new AedsEncoder();
        DefaultHttpContext context = CreateHttpContext(request, proofToken);
        BinaryFrameResult result = await BinaryEndpoints.HandleSiteSubscriptionAsync(
            context,
            db,
            aeds,
            configuration,
            subscribe: false,
            CancellationToken.None,
            proofService);
        await result.ExecuteAsync(context);
        return new EndpointResponse(context.Response.StatusCode, Decode(((MemoryStream)context.Response.Body).ToArray()));
    }

    private static DefaultHttpContext CreateHttpContext(SiteSubscriptionBinaryRequest request, string proofToken)
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        if (!string.IsNullOrWhiteSpace(proofToken))
        {
            context.Request.Headers[SiteSubscriptionProofService.HeaderName] = proofToken;
        }

        context.RequestServices = new ServiceCollection()
            .AddSingleton<IBinaryEndpointRequestContext>(new FixedBinaryRequestContext(request))
            .BuildServiceProvider();
        return context;
    }

    private static AedsDecodeResult Decode(byte[] frame)
    {
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(frame);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value;
    }

    private sealed record EndpointResponse(int StatusCode, AedsDecodeResult Frame);

    private sealed class FixedBinaryRequestContext(SiteSubscriptionBinaryRequest request) : IBinaryEndpointRequestContext
    {
        private readonly BinaryRequestPayload _payload = BinaryRequestPayload.Success(
            PodBinaryCodec.EncodeSiteSubscriptionRequest(request));

        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            AedsFrameType expectedFrameType,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
        {
            Assert.Equal(AedsFrameType.SiteSubscriptionRequest, expectedFrameType);
            Assert.Equal((int?)1024, maxFrameBytes);
            return Task.FromResult(_payload);
        }

        public Task<BinaryRequestPayload> ReadFrameAsync(HttpContext httpContext, IAedsEncoder aeds, IReadOnlyCollection<AedsFrameType> expectedFrameTypes, CancellationToken cancellationToken, int? maxFrameBytes = null) => throw new NotSupportedException();
        public Task<NameMutationPayload> ReadNameMutationAsync(HttpContext httpContext, IAedsEncoder aeds, AedsFrameType expectedFrameType, CancellationToken cancellationToken) => throw new NotSupportedException();
        public string BuildArticleViewerIdentity(HttpContext context, int articleId) => throw new NotSupportedException();
        public ValueTask<long> GetArticleListCacheVersionAsync(IUnifiedCache cache) => throw new NotSupportedException();
        public string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string keyword = "") => throw new NotSupportedException();
        public string BuildArticleHotCacheIdentity(int count) => throw new NotSupportedException();
        public string? GetDeviceFingerprint(HttpContext context) => null;
        public bool TryReadMfaProof(HttpContext context, out string proofToken)
        {
            proofToken = string.Empty;
            return false;
        }
    }

    private sealed class MemoryProofCache : IUnifiedCache
    {
        private readonly Dictionary<string, byte[]> _values = new(StringComparer.Ordinal);

        public int ConsumeCalls
        {
            get; private set;
        }

        public Task SetRawAsync(
            CachePolicyId policyId,
            string identity,
            byte[] value,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
        {
            _values[BuildKey(policyId, identity)] = value.ToArray();
            return Task.CompletedTask;
        }

        public Task<CacheReadResult<T>> TryGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
        {
            if (!_values.TryGetValue(BuildKey(policyId, identity), out byte[]? value))
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            var (success, decoded) = decoder(value);
            return Task.FromResult(success
                ? new CacheReadResult<T>(true, decoded)
                : new CacheReadResult<T>(false, default));
        }

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
        {
            ConsumeCalls++;
            if (!_values.Remove(BuildKey(policyId, identity), out byte[]? value))
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            var (success, decoded) = decoder(value);
            return Task.FromResult(success
                ? new CacheReadResult<T>(true, decoded)
                : new CacheReadResult<T>(false, default));
        }

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{identity}";

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = utcNow;

        public override DateTimeOffset GetUtcNow() => UtcNow;
    }
}

[Trait("Category", "ApiIntegration")]
public sealed class SubscriptionEndpointTestServerTests
{
    private const string Pepper = "unit-test-subscription-email-hash-pepper-with-enough-entropy";

    [Fact]
    public async Task TestServer_UnsubscribeReturnsStablePreconditionAndValidationErrorFrames()
    {
        var request = new SiteSubscriptionBinaryRequest("reader@example.com", "email");
        ISiteSubscriptionProofService missingProofService = Substitute.For<ISiteSubscriptionProofService>();
        missingProofService.ValidateUnsubscribeProofAsync(
                Arg.Any<SiteSubscriptionUnsubscribeProofConsumeRequest>(),
                Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(SiteSubscriptionUnsubscribeProofConsumeResult.Rejected("proof_replayed_or_missing")));
        await using WebApplication missingProofServer = await CreateTestServerAsync(request, missingProofService);
        using HttpClient missingProofClient = missingProofServer.GetTestClient();
        using HttpResponseMessage missingProof = await missingProofClient.DeleteAsync("/api/binary/subscriptions");

        Assert.Equal(StatusCodes.Status428PreconditionRequired, (int)missingProof.StatusCode);
        AedsDecodeResult missingProofFrame = Decode(await missingProof.Content.ReadAsByteArrayAsync());
        Assert.Equal(AedsFrameType.ApiError, missingProofFrame.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(missingProofFrame.Payload, out var missingProofError));
        ErrorDetail missingProofDetail = PodBinaryCodec.ToErrorDetail(missingProofError);
        Assert.Equal(ErrorCode.Forbidden, missingProofDetail.Code);
        Assert.Equal("proof_replayed_or_missing", missingProofDetail.Message);
        await missingProofService.Received(1).ValidateUnsubscribeProofAsync(
            Arg.Is<SiteSubscriptionUnsubscribeProofConsumeRequest>(proof =>
                proof.ProofToken.Length == 0
                && proof.Email == "reader@example.com"
                && proof.Channel == "email"),
            Arg.Any<CancellationToken>());

        var invalidEmailProof = new SiteSubscriptionProofService(
            Substitute.For<IUnifiedCache>(),
            TimeProvider.System,
            CreateConfiguration());
        await using WebApplication invalidEmailServer = await CreateTestServerAsync(
            new SiteSubscriptionBinaryRequest("bad", "email"),
            invalidEmailProof);
        using HttpClient invalidEmailClient = invalidEmailServer.GetTestClient();
        using var invalidEmailRequest = new HttpRequestMessage(HttpMethod.Delete, "/api/binary/subscriptions");
        invalidEmailRequest.Headers.TryAddWithoutValidation(SiteSubscriptionProofService.HeaderName, "fsu_unsub_invalid-email");
        using HttpResponseMessage invalidEmail = await invalidEmailClient.SendAsync(invalidEmailRequest);

        Assert.Equal(HttpStatusCode.BadRequest, invalidEmail.StatusCode);
        AedsDecodeResult invalidEmailFrame = Decode(await invalidEmail.Content.ReadAsByteArrayAsync());
        Assert.Equal(AedsFrameType.ApiError, invalidEmailFrame.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(invalidEmailFrame.Payload, out var invalidEmailError));
        ErrorDetail invalidEmailDetail = PodBinaryCodec.ToErrorDetail(invalidEmailError);
        Assert.Equal(ErrorCode.Validation, invalidEmailDetail.Code);
        Assert.Equal("email_invalid", invalidEmailDetail.Message);
    }

    private static async Task<WebApplication> CreateTestServerAsync(
        SiteSubscriptionBinaryRequest request,
        ISiteSubscriptionProofService proofService)
    {
        IConfiguration configuration = CreateConfiguration();
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        var aeds = new AedsEncoder();
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Configuration.Sources.Clear();
        builder.Services.AddRouting();
        builder.Services.AddSingleton<IBinaryEndpointRequestContext>(new TestServerBinaryRequestContext(request));
        WebApplication app = builder.Build();
        app.UseRouting();
        app.MapDelete("/api/binary/subscriptions", async context =>
                    {
                        BinaryFrameResult result = await BinaryEndpoints.HandleSiteSubscriptionAsync(
                            context,
                            db,
                            aeds,
                            configuration,
                            subscribe: false,
                            context.RequestAborted,
                            proofService);
                        await result.ExecuteAsync(context);
                    });
        await app.StartAsync();
        return app;
    }

    private static IConfiguration CreateConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [SiteSubscriptionIdentity.EmailHashPepperConfigurationKey] = Pepper
            })
            .Build();

    private static AedsDecodeResult Decode(byte[] frame)
    {
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(frame);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value;
    }

    private sealed class TestServerBinaryRequestContext(SiteSubscriptionBinaryRequest request) : IBinaryEndpointRequestContext
    {
        private readonly BinaryRequestPayload _payload = BinaryRequestPayload.Success(
            PodBinaryCodec.EncodeSiteSubscriptionRequest(request));

        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            AedsFrameType expectedFrameType,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
        {
            Assert.Equal(AedsFrameType.SiteSubscriptionRequest, expectedFrameType);
            Assert.Equal((int?)1024, maxFrameBytes);
            return Task.FromResult(_payload);
        }

        public Task<BinaryRequestPayload> ReadFrameAsync(HttpContext httpContext, IAedsEncoder aeds, IReadOnlyCollection<AedsFrameType> expectedFrameTypes, CancellationToken cancellationToken, int? maxFrameBytes = null) => throw new NotSupportedException();
        public Task<NameMutationPayload> ReadNameMutationAsync(HttpContext httpContext, IAedsEncoder aeds, AedsFrameType expectedFrameType, CancellationToken cancellationToken) => throw new NotSupportedException();
        public string BuildArticleViewerIdentity(HttpContext context, int articleId) => throw new NotSupportedException();
        public ValueTask<long> GetArticleListCacheVersionAsync(IUnifiedCache cache) => throw new NotSupportedException();
        public string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string keyword = "") => throw new NotSupportedException();
        public string BuildArticleHotCacheIdentity(int count) => throw new NotSupportedException();
        public string? GetDeviceFingerprint(HttpContext context) => null;
        public bool TryReadMfaProof(HttpContext context, out string proofToken)
        {
            proofToken = string.Empty;
            return false;
        }
    }
}
