using System.Buffers.Binary;
using System.Security.Claims;
using System.Net.WebSockets;
using System.Text;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.NotificationStream;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using StackExchange.Redis;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public class NotificationStreamBoundaryTests
{
    [Fact]
    public void SignalRIdentityProviders_DoNotRegisterLegacyAnonymousAccountIds()
    {
        string runtimeServices = BackendTestPaths.ReadAllTextFromRoot(
            "src/backend/Infrastructure/Bootstrap/RuntimeInfrastructureServiceCollectionExtensions.cs");
        string signalRInitializer = BackendTestPaths.ReadAllTextFromRoot(
            "src/backend/Infrastructure/Helpers/Initializer/SignalRInitializer.cs");
        string fastUserIdProvider = BackendTestPaths.ReadAllTextFromRoot(
            "src/backend/Infrastructure/FastUserIdProvider.cs");
        string snowflakeProvider = BackendTestPaths.FromRoot(
            "src/backend/Infrastructure/NotificationStream/SnowflakeUserIdProvider.cs");

        Assert.False(File.Exists(snowflakeProvider), "SnowflakeUserIdProvider must be removed.");
        Assert.DoesNotContain("SnowflakeUserIdProvider", runtimeServices, StringComparison.Ordinal);
        Assert.DoesNotContain("AddSingleton<IUserIdProvider", runtimeServices, StringComparison.Ordinal);
        Assert.DoesNotContain("AddSingleton<IUserIdProvider", signalRInitializer, StringComparison.Ordinal);
        Assert.DoesNotContain(": IUserIdProvider", fastUserIdProvider, StringComparison.Ordinal);
        Assert.DoesNotContain("HubConnectionContext", fastUserIdProvider, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Admission_AllowsAnonymousWithoutAccountLookup()
    {
        var blacklist = Substitute.For<IBlacklistService>();
        var users = Substitute.For<IUserAccountReader>();
        var admission = new NotificationStreamAdmissionService(blacklist, users);

        var result = await admission.ValidateAsync(null, CancellationToken.None);

        Assert.True(result.IsAllowed);
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>(), Arg.Any<string>());
        await users.DidNotReceive().GetAccountByIdAsync(Arg.Any<int>());
    }

    [Fact]
    public async Task Admission_DeniesBannedAccount()
    {
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, "subject-hash-42")
            .Returns(Task.FromResult(new BanStateSnapshot(true, "manual", "blocked")));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(new UserAccountSnapshot(
            42,
            1,
            "blocked",
            false,
            null,
            AccountSubjectHash: "subject-hash-42")));
        var admission = new NotificationStreamAdmissionService(blacklist, users);

        var result = await admission.ValidateAsync("42", CancellationToken.None);

        Assert.False(result.IsAllowed);
        Assert.Equal(StatusCodes.Status423Locked, result.StatusCode);
        Assert.Equal("account_blocked", result.ErrorCode);
        await users.Received(1).GetAccountByIdAsync(42);
    }

    [Fact]
    public async Task Admission_DeniesDeletedAccount()
    {
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, "subject-hash-42")
            .Returns(Task.FromResult(new BanStateSnapshot(false, null, null)));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(new UserAccountSnapshot(
            42,
            2,
            null,
            false,
            null,
            AccountSubjectHash: "subject-hash-42")));
        var admission = new NotificationStreamAdmissionService(blacklist, users);

        var result = await admission.ValidateAsync("42", CancellationToken.None);

        Assert.False(result.IsAllowed);
        Assert.Equal(StatusCodes.Status401Unauthorized, result.StatusCode);
        Assert.Equal("account_deleted", result.ErrorCode);
    }

    [Fact]
    public async Task Admission_CachesAccountStateAcrossReconnectsButStillChecksBanState()
    {
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42, "subject-hash-42")
            .Returns(Task.FromResult(new BanStateSnapshot(false, null, null)));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(new UserAccountSnapshot(
            42,
            1,
            "active",
            false,
            null,
            AccountSubjectHash: "subject-hash-42")));
        var admission = new NotificationStreamAdmissionService(blacklist, users, new NotificationStreamAccountAdmissionCache());

        NotificationStreamAdmissionResult first = await admission.ValidateAsync("42", CancellationToken.None);
        NotificationStreamAdmissionResult second = await admission.ValidateAsync("42", CancellationToken.None);

        Assert.True(first.IsAllowed);
        Assert.True(second.IsAllowed);
        await users.Received(1).GetAccountByIdAsync(42);
        await blacklist.Received(2).GetBanStateAsync(42, "subject-hash-42");
    }

    [Fact]
    public void AudienceResolver_DoesNotMapRoleOnlyUserToAdminGroup()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "42"),
                new Claim(ClaimTypes.Role, "admin"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind)
            ],
            "test"));
        var resolver = new NotificationStreamAudienceResolver();

        IReadOnlySet<string> groups = resolver.ResolveGroups(principal, "42");

        Assert.Single(groups);
        Assert.Contains(NotificationStreamTargetCollections.ContentFeed, groups);
        Assert.DoesNotContain(NotificationStreamTargetCollections.AdminUsers, groups);
    }

    [Fact]
    public void AudienceResolver_MapsAdminPrincipalToNotificationStreamTargetCollections()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "42"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "42")
            ],
            "test"));
        var resolver = new NotificationStreamAudienceResolver();

        IReadOnlySet<string> groups = resolver.ResolveGroups(principal, "42");

        Assert.Contains(NotificationStreamTargetCollections.ContentFeed, groups);
        Assert.Contains(NotificationStreamTargetCollections.AdminUsers, groups);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Handshake_DeniesCrossSiteOriginForStreamAndPreflight(bool requireWebSocket)
    {
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"]);
        DefaultHttpContext context = CreateHandshakeContext("https://evil.example", "example.com");

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None, requireWebSocket);

        Assert.False(result.IsSuccess);
        Assert.Equal(StatusCodes.Status403Forbidden, result.StatusCode);
        Assert.Equal("origin_not_allowed", result.ErrorCode);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Handshake_AllowsConfiguredOriginForStreamAndPreflight(bool requireWebSocket)
    {
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"]);
        DefaultHttpContext context = CreateHandshakeContext("https://example.com", "example.com");

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None, requireWebSocket);

        Assert.True(result.IsSuccess);
        Assert.Equal("42", result.Handshake!.UserId);
    }

    [Fact]
    public async Task Handshake_AdminPrincipalDoesNotUseSysUserAdmission()
    {
        var admission = new CapturingAdmissionService();
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            admissionService: admission);
        DefaultHttpContext context = CreateHandshakeContext("https://example.com", "example.com");
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "42"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "42")
            ],
            "test"));

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Null(result.Handshake!.UserId);
        Assert.Contains(NotificationStreamTargetCollections.AdminUsers, result.Handshake.Groups);
        Assert.Equal([null], admission.Requests);
    }

    [Fact]
    public async Task Handshake_AllowsDevelopmentLocalhostOrigin()
    {
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Development },
            []);
        DefaultHttpContext context = CreateHandshakeContext("http://localhost:5173", "localhost:7568");

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None);

        Assert.True(result.IsSuccess);
    }

    [Fact]
    public void Handshake_SourceChecksOriginBeforeAnonymousPow()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Infrastructure", "NotificationStream", "NotificationStreamHandshakeService.cs"));
        string validate = ExtractMethodBlock(source, "public async Task<NotificationStreamHandshakeResult> ValidateAsync");
        string validateOrigin = ExtractMethodBlock(source, "private NotificationStreamHandshakeResult? ValidateOrigin");
        string observability = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Observability/FsusObservability.cs");
        string runtimeServices = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Bootstrap/RuntimeInfrastructureServiceCollectionExtensions.cs");

        Assert.Contains("ValidateOrigin(context)", validate, StringComparison.Ordinal);
        Assert.Contains("origin_not_allowed", source, StringComparison.Ordinal);
        Assert.True(
            validate.IndexOf("ValidateOrigin(context)", StringComparison.Ordinal) <
            validate.IndexOf("ValidateAnonymousSubscribeGateAsync", StringComparison.Ordinal));
        Assert.Contains("PowValidationLogic.ValidateFromQueryAsync", source, StringComparison.Ordinal);
        Assert.Contains("Seo:BaseUrl", source, StringComparison.Ordinal);
        Assert.Contains("Fido2:Origins", source, StringComparison.Ordinal);
        Assert.Contains("CORS_ALLOWED_HOSTS", source, StringComparison.Ordinal);
        Assert.Contains("IsDevelopment()", source, StringComparison.Ordinal);
        Assert.Contains("localhost", source, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("NotificationStreamOriginSnapshot", source, StringComparison.Ordinal);
        Assert.Contains("originSnapshotProvider.Current", validateOrigin, StringComparison.Ordinal);
        Assert.Contains("ChangeToken.OnChange(configuration.GetReloadToken", source, StringComparison.Ordinal);
        Assert.Contains("fsus.notification_stream.handshake.origin_validation_elapsed_ms", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.notification.handshake.origin_cache.elapsed", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.notification.handshake.origin_cache.hit_ratio", observability, StringComparison.Ordinal);
        Assert.Contains("RecordNotificationStreamOriginCacheAccess", source, StringComparison.Ordinal);
        Assert.Contains("RecordNotificationStreamOriginCacheRebuild", source, StringComparison.Ordinal);
        Assert.Contains("fsus.notification_stream.admission.account_state_cache", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.notification_stream.admission.db_read_count", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.notification_stream.admission.rejected_reason_count", observability, StringComparison.Ordinal);
        Assert.Contains("AddSingleton<NotificationStreamOriginSnapshotProvider>", runtimeServices, StringComparison.Ordinal);
        Assert.Contains("AddSingleton<NotificationStreamAccountAdmissionCache>", runtimeServices, StringComparison.Ordinal);
        Assert.DoesNotContain("BuildAllowedOrigins", validateOrigin, StringComparison.Ordinal);
        Assert.DoesNotContain("BuildAllowedHosts", validateOrigin, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Handshake_PreflightAcceptsRiskControlHeaderProofWithoutConsumingIt()
    {
        var proof = new CapturingProofService();
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            riskScore: 50,
            proof);
        DefaultHttpContext context = CreateAnonymousHandshakeContext("https://example.com", "example.com");
        AddRiskControlHeaders(context);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None, requireWebSocket: false);

        Assert.True(result.IsSuccess);
        Assert.Empty(proof.ConsumeRequests);
    }

    [Fact]
    public async Task Handshake_WebSocketConsumesRiskControlQueryProofForAnonymousSubscribe()
    {
        var proof = new CapturingProofService();
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            riskScore: 50,
            proof);
        DefaultHttpContext context = CreateAnonymousHandshakeContext("https://example.com", "example.com");
        AddRiskControlQuery(context);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None);

        Assert.True(result.IsSuccess);
        SecurityChallengeProofConsumeRequest request = Assert.Single(proof.ConsumeRequests);
        Assert.Equal("proof-ok", request.ProofToken);
        Assert.Equal("notification-challenge", request.ChallengeId);
        Assert.Equal("sha256PowV1", request.Kind);
        Assert.Equal(RiskActionNames.NotificationSubscribe, request.Action);
        Assert.Equal("notification.subscribe", request.RouteKey);
    }

    [Fact]
    public async Task Handshake_WebSocketAcceptsLegacyPowQueryForAnonymousSubscribe()
    {
        var powService = Substitute.For<IPowService>();
        powService.VerifyAsync(Arg.Any<IPowRequest>(), "198.51.100.17").Returns(Task.FromResult(true));
        var proof = new CapturingProofService();
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            riskScore: 50,
            proof,
            powService);
        DefaultHttpContext context = CreateAnonymousHandshakeContext("https://example.com", "example.com");
        AddLegacyPowQuery(context);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None);

        Assert.True(result.IsSuccess);
        Assert.Empty(proof.ConsumeRequests);
        await powService.Received(1).VerifyAsync(
            Arg.Is<IPowRequest>(request =>
                request.Difficulty == 16 &&
                request.PowSalt == "salt" &&
                request.PowNonce == "nonce" &&
                request.PowSignature == "signature" &&
                request.BrowserFp == "fp"),
            "198.51.100.17");
    }

    [Fact]
    public async Task Handshake_HighRiskAnonymousSubscribeWithoutProofReturnsRiskChallengeRequired()
    {
        var riskSink = new CapturingRiskSink();
        NotificationStreamHandshakeService service = CreateHandshakeService(
            new TestWebHostEnvironment { EnvironmentName = Environments.Production },
            ["Seo:BaseUrl=https://example.com", "CORS_ALLOWED_HOSTS=https://example.com", "Fido2:Origins:0=https://example.com"],
            riskScore: 50,
            riskSink: riskSink);
        DefaultHttpContext context = CreateAnonymousHandshakeContext("https://example.com", "example.com");

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None, requireWebSocket: false);

        Assert.False(result.IsSuccess);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, result.StatusCode);
        Assert.Equal("risk_challenge_required", result.ErrorCode);
        SecurityRiskSignal signal = Assert.Single(riskSink.Signals);
        Assert.Equal(SecurityRiskReason.SecurityChallengeRejected, signal.Reason);
        Assert.Equal(SecurityRiskSources.RiskControl, signal.Source);
        Assert.Equal(0, signal.Score);
        Assert.Equal("challenge_proof_missing", signal.Detail);
    }

    [Fact]
    public void Handshake_SourceKeepsLegacyPowCompatibilityAndNotificationRiskAction()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Infrastructure", "NotificationStream", "NotificationStreamHandshakeService.cs"));

        Assert.Contains("PowValidationLogic.ValidateFromQueryAsync", source, StringComparison.Ordinal);
        Assert.Contains("RiskActionNames.NotificationSubscribe", source, StringComparison.Ordinal);
        Assert.Contains("X-Fsus-Challenge-Proof", source, StringComparison.Ordinal);
        Assert.Contains("challengeProof", source, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SessionService_SwallowsAcceptWebSocketFailureAndRemovesConnection()
    {
        var manager = new NotificationStreamConnectionManager(new ConfigurationBuilder().Build(), NullLogger<NotificationStreamConnectionManager>.Instance);
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(Substitute.For<IDatabase>());
        var backlog = new NotificationStreamBacklogStore(redis, Substitute.For<IRuntimeKeyScope>(), NullLogger<NotificationStreamBacklogStore>.Instance);
        var service = new NotificationStreamSessionService(manager, backlog, new TestNotificationFrameCodec(), new TestWebHostEnvironment(), NullLogger<NotificationStreamSessionService>.Instance);
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpWebSocketFeature>(new ThrowingWebSocketFeature());
        var handshake = new NotificationStreamHandshake("fsus-aeds.v2", "42", new HashSet<string>(StringComparer.Ordinal));

        Exception? exception = await Record.ExceptionAsync(() => service.RunAsync(context, handshake, CancellationToken.None));

        Assert.Null(exception);
        Assert.Equal(0, manager.ConnectionCount);
    }

    [Fact]
    public async Task BacklogReplay_DoesNotMissGapWhenCursorFloorEntryIsStillRetained()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        var database = Substitute.For<IDatabase>();
        var batch = Substitute.For<IBatch>();
        var keyScope = Substitute.For<IRuntimeKeyScope>();
        redis.GetDatabase().Returns(database);
        database.CreateBatch(Arg.Any<object?>()).Returns(batch);
        keyScope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        batch.StreamRangeAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<RedisValue>(),
                Arg.Any<int?>(),
                Arg.Any<Order>(),
                Arg.Any<CommandFlags>())
            .Returns(
                Task.FromResult(new[] { StreamEntry("100-0", [0x64]) }),
                Task.FromResult(new[] { StreamEntry("51-0", [0x33]) }),
                Task.FromResult(new[] { StreamEntry("50-0", [0x32]) }));
        var store = new NotificationStreamBacklogStore(redis, keyScope, NullLogger<NotificationStreamBacklogStore>.Instance);

        NotificationStreamReplayBatch replay = await store.ReplayAsync(new NotificationStreamCursor(50), "42", new HashSet<string>(StringComparer.Ordinal));

        try
        {
            Assert.False(replay.MissedGap);
            Assert.Single(replay.Frames);
        }
        finally
        {
            foreach (SharedNotificationStreamFrame frame in replay.Frames)
            {
                frame.Release();
            }
        }
    }

    [Fact]
    public void BacklogReplay_MissedGapRequiresCursorFloorProbe()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Infrastructure", "NotificationStream", "NotificationStreamBacklogStore.cs"));
        string method = ExtractMethodBlock(source, "private async Task<RouteReplayRead> ReadRouteReplayAsync");

        Assert.Contains("IBatch batch = _database.CreateBatch()", method, StringComparison.Ordinal);
        Assert.Contains("batch.Execute()", method, StringComparison.Ordinal);
        Assert.Contains("cursorFloorTask", method, StringComparison.Ordinal);
        Assert.Contains("Order.Descending", method, StringComparison.Ordinal);
        Assert.Contains("HasRetainedCursorFloor", method, StringComparison.Ordinal);
        Assert.DoesNotContain("_database.StreamRangeAsync(streamKey, count: 1)", method, StringComparison.Ordinal);
    }

    [Fact]
    public void BacklogReplay_SourceBatchesRouteReadsAndRecordsRedisCommandCount()
    {
        string backlog = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Infrastructure", "NotificationStream", "NotificationStreamBacklogStore.cs"));
        string metrics = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Infrastructure", "NotificationStream", "NotificationStreamMetrics.cs"));
        string replay = ExtractMethodBlock(backlog, "public async Task<NotificationStreamReplayBatch> ReplayAsync");

        Assert.Contains("ReadRouteReplaysAsync", backlog, StringComparison.Ordinal);
        Assert.Contains("IBatch batch = _database.CreateBatch()", backlog, StringComparison.Ordinal);
        Assert.Contains("redisCommandCount", replay, StringComparison.Ordinal);
        Assert.Contains("RecordReplay(frames.Count, missedGap, replayRoutes.Count, scannedEntries, dedupedEntries, redisCommandCount)", replay, StringComparison.Ordinal);
        Assert.Contains("fsus.notification_stream.replay_redis_commands", metrics, StringComparison.Ordinal);
        Assert.Contains("fsus.notification_stream.publish_fanout", metrics, StringComparison.Ordinal);
        Assert.Contains("fsus.notification_stream.publish_allocation_estimate_bytes", metrics, StringComparison.Ordinal);
    }

    [Fact]
    public void BacklogAppend_SourceUsesSingleFieldStreamAddWithoutPerPublishNameValueArray()
    {
        string backlog = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Infrastructure", "NotificationStream", "NotificationStreamBacklogStore.cs"));
        string append = ExtractMethodBlock(backlog, "public async Task<Result> AppendAsync");

        Assert.Contains("StreamAddAsync(", append, StringComparison.Ordinal);
        Assert.Contains("\"f\"", append, StringComparison.Ordinal);
        Assert.Contains("frame.BufferMemory", append, StringComparison.Ordinal);
        Assert.DoesNotContain("NameValueEntry[]", append, StringComparison.Ordinal);
        Assert.DoesNotContain("new(\"f\", frame.BufferMemory)", append, StringComparison.Ordinal);
        Assert.DoesNotContain("string.Create(CultureInfo.InvariantCulture", append, StringComparison.Ordinal);
    }

    [Fact]
    public void SessionService_SourceClosesSocketUnderSendGate()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Infrastructure", "NotificationStream", "NotificationStreamSessionService.cs"));
        string pump = ExtractMethodBlock(source, "private async Task PumpConnectionAsync");
        string close = ExtractMethodBlock(source, "private static async Task CloseSocketAsync");

        Assert.Contains("CloseSocketAsync(socket, sendGate)", pump, StringComparison.Ordinal);
        Assert.Contains("connection.IsClosed", pump, StringComparison.Ordinal);
        Assert.Contains("sendGate.WaitAsync", close, StringComparison.Ordinal);
        Assert.Contains("socket.CloseAsync", close, StringComparison.Ordinal);
    }

    [Fact]
    public void DrillPublishEndpoint_SourceIsTestOnlyAndSecretProtected()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Modules", "Endpoints", "NotificationStreamDrillEndpoints.cs"));

        Assert.Contains("IsDevelopment()", source, StringComparison.Ordinal);
        Assert.Contains("IsEnvironment(\"Test\")", source, StringComparison.Ordinal);
        Assert.Contains("X-Fsus-Notification-Drill-Secret", source, StringComparison.Ordinal);
        Assert.Contains("INotificationStreamPublisher", source, StringComparison.Ordinal);
        Assert.Contains("NotificationStreamTargetRouteCodec.TryEncode", source, StringComparison.Ordinal);
        Assert.Contains("/_fsus/testing/notification-stream/publish", source, StringComparison.Ordinal);
    }

    [Fact]
    public void SessionService_SourceGatesDrillSendDelayToDevelopmentOrTest()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Infrastructure", "NotificationStream", "NotificationStreamSessionService.cs"));

        Assert.Contains("drillSlowConsumer", source, StringComparison.Ordinal);
        Assert.Contains("drillQueueCapacity", source, StringComparison.Ordinal);
        Assert.Contains("manager.RegisterConnection(", source, StringComparison.Ordinal);
        Assert.Contains("context.GetClientIp()", source, StringComparison.Ordinal);
        Assert.Contains("IsDevelopment()", source, StringComparison.Ordinal);
        Assert.Contains("IsEnvironment(\"Test\")", source, StringComparison.Ordinal);
    }

    private sealed class ThrowingWebSocketFeature : IHttpWebSocketFeature
    {
        public bool IsWebSocketRequest => true;

        public Task<WebSocket> AcceptAsync(WebSocketAcceptContext context)
            => Task.FromException<WebSocket>(new IOException("client disconnected before websocket accept completed"));
    }

    private sealed class TestWebHostEnvironment : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = Environments.Production;
        public string ApplicationName { get; set; } = "FsusBlog.Server.Tests";
        public string WebRootPath { get; set; } = string.Empty;
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = BackendTestPaths.RepositoryRoot;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class TestNotificationFrameCodec : INotificationFrameCodec
    {
        public byte[] EncodeHeartbeatFrame() => [0x01];

        public SharedNotificationStreamFrame EncodeEventFrame<TPayload>(long eventId, NotificationStreamEventType eventType, TPayload payload)
            => SharedNotificationStreamFrame.FromArray([0x01]);
    }

    private static StreamEntry StreamEntry(string id, byte[] payload)
        => new(id, [new NameValueEntry("f", payload)]);

    private static NotificationStreamHandshakeService CreateHandshakeService(
        IWebHostEnvironment environment,
        IEnumerable<string> settings,
        int riskScore = 0,
        CapturingProofService? proof = null,
        IPowService? powService = null,
        INotificationStreamAdmissionService? admissionService = null,
        CapturingRiskSink? riskSink = null)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(settings.Select(static item =>
            {
                int separator = item.IndexOf('=', StringComparison.Ordinal);
                return new KeyValuePair<string, string?>(
                    item[..separator],
                    item[(separator + 1)..]);
            }))
            .Build();
        return new NotificationStreamHandshakeService(
            powService ?? Substitute.For<IPowService>(),
            new AdaptivePowGovernor(Substitute.For<IUnifiedCache>()),
            new FixedRiskScoreReader(riskScore),
            new FixedRiskPolicyProvider(CreateNotificationRiskPolicy()),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            proof ?? new CapturingProofService(),
            riskSink ?? new CapturingRiskSink(),
            admissionService ?? new AllowingAdmissionService(),
            new NotificationStreamAudienceResolver(),
            new NotificationStreamOriginSnapshotProvider(configuration),
            environment,
            NullLoggerFactory.Instance);
    }

    private static DefaultHttpContext CreateHandshakeContext(string origin, string host)
    {
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpWebSocketFeature>(new ThrowingWebSocketFeature());
        context.Request.Headers.Origin = origin;
        context.Request.Headers.Host = host;
        context.Request.Headers.SecWebSocketProtocol = "fsus-aeds.v2";
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, "42")],
            "test"));
        return context;
    }

    private static DefaultHttpContext CreateAnonymousHandshakeContext(string origin, string host)
    {
        var context = new DefaultHttpContext();
        context.Features.Set<IHttpWebSocketFeature>(new ThrowingWebSocketFeature());
        context.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("198.51.100.17");
        context.Request.Headers.Origin = origin;
        context.Request.Headers.Host = host;
        context.Request.Headers.SecWebSocketProtocol = "fsus-aeds.v2";
        context.Request.Headers.UserAgent = "Mozilla/5.0";
        return context;
    }

    private static void AddRiskControlHeaders(DefaultHttpContext context)
    {
        context.Request.Headers["X-Fsus-Challenge-Proof"] = "proof-ok";
        context.Request.Headers["X-Fsus-Challenge-Id"] = "notification-challenge";
        context.Request.Headers["X-Fsus-Challenge-Kind"] = "sha256PowV1";
    }

    private static void AddRiskControlQuery(DefaultHttpContext context)
    {
        context.Request.QueryString = new QueryString("?challengeProof=proof-ok&challengeId=notification-challenge&challengeKind=sha256PowV1");
    }

    private static void AddLegacyPowQuery(DefaultHttpContext context)
    {
        context.Request.QueryString = new QueryString($"?pow={Uri.EscapeDataString(CreateEncodedPowProof())}");
    }

    private static string CreateEncodedPowProof()
    {
        byte[] salt = Encoding.UTF8.GetBytes("salt");
        byte[] nonce = Encoding.UTF8.GetBytes("nonce");
        byte[] signature = Encoding.UTF8.GetBytes("signature");
        byte[] browserFp = Encoding.UTF8.GetBytes("fp");
        int length = 17
            + sizeof(ushort) + salt.Length
            + sizeof(ushort) + nonce.Length
            + sizeof(ushort) + signature.Length
            + sizeof(ushort) + browserFp.Length;
        byte[] buffer = new byte[length];
        buffer[0] = (byte)'F';
        buffer[1] = (byte)'P';
        buffer[2] = (byte)'O';
        buffer[3] = (byte)'W';
        buffer[4] = 1;
        BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(5), 16);
        BinaryPrimitives.WriteInt64LittleEndian(buffer.AsSpan(9), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        int offset = 17;
        WriteString(buffer, salt, ref offset);
        WriteString(buffer, nonce, ref offset);
        WriteString(buffer, signature, ref offset);
        WriteString(buffer, browserFp, ref offset);
        return Convert.ToBase64String(buffer);
    }

    private static void WriteString(byte[] target, byte[] value, ref int offset)
    {
        BinaryPrimitives.WriteUInt16LittleEndian(target.AsSpan(offset), (ushort)value.Length);
        offset += sizeof(ushort);
        value.CopyTo(target.AsSpan(offset));
        offset += value.Length;
    }

    private static SecurityRiskPolicySnapshotV2 CreateNotificationRiskPolicy()
    {
        var defaultAction = new SecurityRiskActionPolicy(
            "*",
            new SecurityRiskActionThresholds(49, 50, 100, 100, 100),
            "sha256PowV1",
            1,
            null,
            AnonymousWriteAllowed: true);
        var notification = defaultAction with
        {
            ActionName = RiskActionNames.NotificationSubscribe,
            Thresholds = new SecurityRiskActionThresholds(0, 0, 100, 100, 100)
        };

        return new SecurityRiskPolicySnapshotV2(
            "risk:notification-test",
            SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion,
            DateTimeOffset.UnixEpoch,
            SecuritySystemModes.Enforce,
            200,
            125,
            "risk:lkg",
            defaultAction,
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.NotificationSubscribe] = notification
            },
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.RiskControl] = SecuritySystemModes.Enforce,
                [SecurityRiskSources.PoSpace] = SecuritySystemModes.Disabled
            });
    }

    private sealed class AllowingAdmissionService : INotificationStreamAdmissionService
    {
        public Task<NotificationStreamAdmissionResult> ValidateAsync(string? userId, CancellationToken cancellationToken)
            => Task.FromResult(NotificationStreamAdmissionResult.Allowed);
    }

    private sealed class CapturingAdmissionService : INotificationStreamAdmissionService
    {
        public List<string?> Requests { get; } = [];

        public Task<NotificationStreamAdmissionResult> ValidateAsync(string? userId, CancellationToken cancellationToken)
        {
            Requests.Add(userId);
            return Task.FromResult(NotificationStreamAdmissionResult.Allowed);
        }
    }

    private sealed class FixedRiskScoreReader(int score) : ISecurityRiskScoreReader
    {
        public Task<int> GetRiskScoreAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
            => Task.FromResult(score);

        public Task<int> GetRiskScoreAsync(HttpContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(score);

        public Task ResetRiskAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
            => Task.CompletedTask;
    }

    private sealed class FixedRiskPolicyProvider(SecurityRiskPolicySnapshotV2 policy) : ISecurityRiskPolicyProvider
    {
        public SecurityRiskPolicySnapshot CurrentRiskPolicy => SecurityRiskPolicySnapshotV2Adapter.ToLegacy(policy);

        public SecurityRiskPolicySnapshotV2 CurrentRiskPolicyV2 => policy;
    }

    private sealed class CapturingRiskSink : ISecurityRiskSignalSink
    {
        public List<SecurityRiskSignal> Signals { get; } = [];

        public ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default)
        {
            Signals.Add(signal);
            return ValueTask.CompletedTask;
        }
    }

    private sealed class CapturingProofService : ISecurityChallengeProofService
    {
        public List<SecurityChallengeProofConsumeRequest> ConsumeRequests { get; } = [];

        public Task<SecurityChallengeProofMintResult> MintProofAsync(SecurityChallengeProofMintRequest request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<SecurityChallengeProofConsumeResult> ConsumeProofAsync(SecurityChallengeProofConsumeRequest request, CancellationToken cancellationToken = default)
        {
            ConsumeRequests.Add(request);
            return Task.FromResult(SecurityChallengeProofConsumeResult.Success(new SecurityChallengeProofClaims(
                request.ChallengeId,
                request.Kind,
                request.Action,
                request.RouteKey,
                request.SubjectHash,
                request.ClientIpHash,
                request.DeviceFpHash,
                DateTimeOffset.UtcNow.AddMinutes(-1),
                DateTimeOffset.UtcNow.AddMinutes(5),
                "nonce",
                request.PolicyVersion)));
        }
    }

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Unable to locate method signature: {signature}");
        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart > start, $"Unable to locate method body: {signature}");

        int depth = 0;
        for (int i = braceStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Unable to extract method body: {signature}");
    }
}
