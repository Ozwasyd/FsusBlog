using System.Security.Claims;
using System.Net.WebSockets;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Interfaces;
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
    public async Task Admission_AllowsAnonymousWithoutAccountLookup()
    {
        var blacklist = Substitute.For<IBlacklistService>();
        var users = Substitute.For<IUserAccountReader>();
        var admission = new NotificationStreamAdmissionService(blacklist, users);

        var result = await admission.ValidateAsync(null, CancellationToken.None);

        Assert.True(result.IsAllowed);
        await blacklist.DidNotReceive().GetBanStateAsync(Arg.Any<int>());
        await users.DidNotReceive().GetAccountByIdAsync(Arg.Any<int>());
    }

    [Fact]
    public async Task Admission_DeniesBannedAccount()
    {
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42)
            .Returns(Task.FromResult(new BanStateSnapshot(true, "manual", "blocked")));
        var users = Substitute.For<IUserAccountReader>();
        var admission = new NotificationStreamAdmissionService(blacklist, users);

        var result = await admission.ValidateAsync("42", CancellationToken.None);

        Assert.False(result.IsAllowed);
        Assert.Equal(StatusCodes.Status423Locked, result.StatusCode);
        Assert.Equal("account_blocked", result.ErrorCode);
        await users.DidNotReceive().GetAccountByIdAsync(Arg.Any<int>());
    }

    [Fact]
    public async Task Admission_DeniesDeletedAccount()
    {
        var blacklist = Substitute.For<IBlacklistService>();
        blacklist.GetBanStateAsync(42)
            .Returns(Task.FromResult(new BanStateSnapshot(false, null, null)));
        var users = Substitute.For<IUserAccountReader>();
        users.GetAccountByIdAsync(42).Returns(Task.FromResult<UserAccountSnapshot?>(new UserAccountSnapshot(
            42,
            "alice",
            "guest",
            2,
            null,
            false,
            null)));
        var admission = new NotificationStreamAdmissionService(blacklist, users);

        var result = await admission.ValidateAsync("42", CancellationToken.None);

        Assert.False(result.IsAllowed);
        Assert.Equal(StatusCodes.Status401Unauthorized, result.StatusCode);
        Assert.Equal("account_deleted", result.ErrorCode);
    }

    [Fact]
    public void AudienceResolver_MapsAuthenticatedAdminToNotificationStreamGroups()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "42"),
                new Claim(ClaimTypes.Role, "admin")
            ],
            "test"));
        var resolver = new NotificationStreamAudienceResolver();

        IReadOnlySet<string> groups = resolver.ResolveGroups(principal, "42");

        Assert.Contains(NotificationStreamGroups.ContentFeed, groups);
        Assert.Contains(NotificationStreamGroups.AuthenticatedUsers, groups);
        Assert.Contains(NotificationStreamGroups.AdminUsers, groups);
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
        var keyScope = Substitute.For<IRuntimeKeyScope>();
        redis.GetDatabase().Returns(database);
        keyScope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        database.StreamRangeAsync(
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

        Assert.Contains("cursorFloorTask", method, StringComparison.Ordinal);
        Assert.Contains("Order.Descending", method, StringComparison.Ordinal);
        Assert.Contains("HasRetainedCursorFloor", method, StringComparison.Ordinal);
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
        Assert.Contains("RegisterConnection(connectionId, handshake.UserId, handshake.Groups, drillQueueCapacity)", source, StringComparison.Ordinal);
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
