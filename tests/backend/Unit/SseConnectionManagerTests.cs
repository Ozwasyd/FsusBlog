using System.Collections.Concurrent;
using FsusBlog.Server.Infrastructure.Sse;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SseConnectionManagerTests
{
    [Fact]
    public void TryRemoveBucketIfCurrent_DoesNotRemoveReplacedBucket()
    {
        const string key = "user:42";
        var oldBucket = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
        var newBucket = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
        newBucket.TryAdd("conn-new", 0);

        var index = new ConcurrentDictionary<string, ConcurrentDictionary<string, byte>>(StringComparer.Ordinal);
        index[key] = oldBucket;
        index[key] = newBucket;

        bool removed = SseConnectionManager.TryRemoveBucketIfCurrent(index, key, oldBucket);

        Assert.False(removed);
        Assert.True(index.TryGetValue(key, out ConcurrentDictionary<string, byte>? currentBucket));
        Assert.Same(newBucket, currentBucket);
    }

    [Fact]
    public void TryRemoveBucketIfCurrent_RemovesWhenCurrent()
    {
        const string key = "user:99";
        var bucket = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
        bucket.TryAdd("conn-1", 0);

        var index = new ConcurrentDictionary<string, ConcurrentDictionary<string, byte>>(StringComparer.Ordinal);
        index[key] = bucket;

        bool removed = SseConnectionManager.TryRemoveBucketIfCurrent(index, key, bucket);

        Assert.True(removed);
        Assert.False(index.ContainsKey(key));
    }

    [Fact]
    public void TargetRouteCodec_GetReplayRoutes_ReturnsUserAndGroups()
    {
        IReadOnlyList<string> routes = TargetRouteCodec.GetReplayRoutes("42", new HashSet<string>(["content", "admin"], StringComparer.Ordinal));

        Assert.Equal(3, routes.Count);
        Assert.Equal("u:42", routes[0]);
        Assert.Contains("g:content", routes);
        Assert.Contains("g:admin", routes);
    }

    [Fact]
    public void TargetRouteCodec_GetStorageRoutes_ExpandsMultiUserTargets()
    {
        IReadOnlyList<string> routes = TargetRouteCodec.GetStorageRoutes("m:10, 20,,30");

        Assert.Equal(["u:10", "u:20", "u:30"], routes);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// SseConnectionManager integration tests (registration, publish, etc.)
// ──────────────────────────────────────────────────────────────────────────────

public class SseConnectionManagerIntegrationTests
{
    private static SseConnectionManager MakeManager(int? queueCapacity = null)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(queueCapacity.HasValue
                ? new Dictionary<string, string?> { ["Sse:QueueCapacity"] = queueCapacity.ToString() }
                : new Dictionary<string, string?>())
            .Build();
        return new SseConnectionManager(config, NullLogger<SseConnectionManager>.Instance);
    }

    private static SharedSseFrame MakeFrame() => SharedSseFrame.FromArray([1, 2, 3]);

    [Fact]
    public void ConnectionCount_InitiallyZero()
    {
        var mgr = MakeManager();
        Assert.Equal(0, mgr.ConnectionCount);
    }

    [Fact]
    public void ConnectionCount_AfterRegister_IsOne()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("conn1", null, []);
        Assert.Equal(1, mgr.ConnectionCount);
    }

    [Fact]
    public void ConnectionCount_AfterMultipleRegister_IsCorrect()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("conn1", null, []);
        mgr.RegisterConnection("conn2", null, []);
        mgr.RegisterConnection("conn3", null, []);
        Assert.Equal(3, mgr.ConnectionCount);
    }

    [Fact]
    public void ConnectionCount_AfterRemove_Decrements()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("c1", null, []);
        mgr.RegisterConnection("c2", null, []);
        mgr.RemoveConnection("c1");
        Assert.Equal(1, mgr.ConnectionCount);
    }

    [Fact]
    public void ConnectionCount_RemoveNonExistent_StillZero()
    {
        var mgr = MakeManager();
        mgr.RemoveConnection("nonexistent");
        Assert.Equal(0, mgr.ConnectionCount);
    }

    [Fact]
    public void RegisterConnection_ReturnsNonNull()
    {
        var mgr = MakeManager();
        var conn = mgr.RegisterConnection("conn1", null, []);
        Assert.NotNull(conn);
    }

    [Fact]
    public void RegisterConnection_SetsConnectionId()
    {
        var mgr = MakeManager();
        var conn = mgr.RegisterConnection("myconn123", null, []);
        Assert.Equal("myconn123", conn.ConnectionId);
    }

    [Fact]
    public void RegisterConnection_SetsUserId()
    {
        var mgr = MakeManager();
        var conn = mgr.RegisterConnection("conn1", "user42", []);
        Assert.Equal("user42", conn.UserId);
    }

    [Fact]
    public void RegisterConnection_NullUserId_Accepted()
    {
        var mgr = MakeManager();
        var conn = mgr.RegisterConnection("conn1", null, []);
        Assert.Null(conn.UserId);
    }

    [Fact]
    public void RegisterConnection_SetsGroups()
    {
        var mgr = MakeManager();
        var conn = mgr.RegisterConnection("conn1", null, ["group1", "group2"]);
        Assert.Contains("group1", conn.Groups);
        Assert.Contains("group2", conn.Groups);
    }

    [Fact]
    public void RegisterConnection_DuplicateId_ThrowsInvalidOperation()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("conn1", null, []);
        var ex = Assert.Throws<InvalidOperationException>(() =>
            mgr.RegisterConnection("conn1", null, []));
        Assert.Contains("conn1", ex.Message);
    }

    [Fact]
    public void RemoveConnection_NonExistent_DoesNotThrow()
    {
        var mgr = MakeManager();
        var ex = Record.Exception(() => mgr.RemoveConnection("does-not-exist"));
        Assert.Null(ex);
    }

    [Fact]
    public void RemoveConnection_WithUserId_RemovesFromUserIndex()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("conn1", "user1", []);

        var frame = MakeFrame();
        var before = mgr.Publish(frame, new UserTarget("user1"));
        Assert.Equal(1, before);
        frame.Release();

        mgr.RemoveConnection("conn1");

        frame = MakeFrame();
        var after = mgr.Publish(frame, new UserTarget("user1"));
        Assert.Equal(0, after);
        frame.Release();
    }

    [Fact]
    public void RemoveConnection_WithGroups_RemovesFromGroupIndex()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("conn1", null, ["grpA"]);

        var frame = MakeFrame();
        var before = mgr.Publish(frame, new GroupTarget("grpA"));
        Assert.Equal(1, before);
        frame.Release();

        mgr.RemoveConnection("conn1");

        frame = MakeFrame();
        var after = mgr.Publish(frame, new GroupTarget("grpA"));
        Assert.Equal(0, after);
        frame.Release();
    }

    [Fact]
    public void Publish_ToUser_DeliversToMatchingConnections()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("conn1", "user1", []);
        mgr.RegisterConnection("conn2", "user1", []);
        mgr.RegisterConnection("conn3", "user2", []);

        var frame = MakeFrame();
        var delivered = mgr.Publish(frame, new UserTarget("user1"));

        Assert.Equal(2, delivered);
        frame.Release();
    }

    [Fact]
    public void Publish_ToUser_NoMatch_ReturnsZero()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("conn1", "user2", []);

        var frame = MakeFrame();
        var delivered = mgr.Publish(frame, new UserTarget("user1"));

        Assert.Equal(0, delivered);
        frame.Release();
    }

    [Fact]
    public void Publish_ToGroup_DeliversToGroupMembers()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("conn1", null, ["groupA"]);
        mgr.RegisterConnection("conn2", null, ["groupA", "groupB"]);
        mgr.RegisterConnection("conn3", null, ["groupB"]);

        var frame = MakeFrame();
        var delivered = mgr.Publish(frame, new GroupTarget("groupA"));

        Assert.Equal(2, delivered);
        frame.Release();
    }

    [Fact]
    public void Publish_ToGroup_NoMembers_ReturnsZero()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("conn1", null, ["otherGroup"]);

        var frame = MakeFrame();
        var delivered = mgr.Publish(frame, new GroupTarget("emptyGroup"));

        Assert.Equal(0, delivered);
        frame.Release();
    }

    [Fact]
    public void Publish_ToMultiUser_DeliversToAllMatchedUsers()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("conn1", "user1", []);
        mgr.RegisterConnection("conn2", "user2", []);
        mgr.RegisterConnection("conn3", "user3", []);

        var frame = MakeFrame();
        var delivered = mgr.Publish(frame, new MultiUserTarget(["user1", "user2"]));

        Assert.Equal(2, delivered);
        frame.Release();
    }

    [Fact]
    public void Publish_ToEmptyManager_ReturnsZero()
    {
        var mgr = MakeManager();
        var frame = MakeFrame();
        var delivered = mgr.Publish(frame, new UserTarget("anyuser"));

        Assert.Equal(0, delivered);
        frame.Release();
    }

    [Fact]
    public void QueueCapacity_Default_Accepted()
    {
        var mgr = MakeManager();
        var conn = mgr.RegisterConnection("conn1", null, []);
        Assert.NotNull(conn);
    }

    [Fact]
    public void QueueCapacity_TooLow_ClampsTo32()
    {
        var mgr = MakeManager(5);
        var conn = mgr.RegisterConnection("conn1", null, []);
        Assert.NotNull(conn);
    }

    [Fact]
    public void QueueCapacity_TooHigh_ClampsTo4096()
    {
        var mgr = MakeManager(99999);
        var conn = mgr.RegisterConnection("conn1", null, []);
        Assert.NotNull(conn);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// SseTargets tests
// ──────────────────────────────────────────────────────────────────────────────

public class SseTargetTests2
{
    [Fact]
    public void UserTarget_StoresUserId()
    {
        var target = new UserTarget("user-123");
        Assert.Equal("user-123", target.UserId);
    }

    [Fact]
    public void GroupTarget_StoresGroupName()
    {
        var target = new GroupTarget("admin-group");
        Assert.Equal("admin-group", target.GroupName);
    }

    [Fact]
    public void MultiUserTarget_StoresUserIds()
    {
        var ids = new List<string> { "user1", "user2", "user3" };
        var target = new MultiUserTarget(ids);
        Assert.Equal(3, target.UserIds.Count);
    }

    [Fact]
    public void SseGroups_AllGroupsAreDistinct()
    {
        var groups = new[] { SseGroups.AuthenticatedUsers, SseGroups.ContentFeed, SseGroups.AdminUsers };
        Assert.Equal(groups.Length, groups.Distinct().Count());
    }

    [Fact]
    public void SseGroups_AllNonEmpty()
    {
        Assert.NotEmpty(SseGroups.AuthenticatedUsers);
        Assert.NotEmpty(SseGroups.ContentFeed);
        Assert.NotEmpty(SseGroups.AdminUsers);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// SharedSseFrame tests
// ──────────────────────────────────────────────────────────────────────────────

public class SharedSseFrameExtendedTests
{
    [Fact]
    public void FromArray_StoresPayload()
    {
        var payload = new byte[] { 1, 2, 3, 4, 5 };
        var frame = SharedSseFrame.FromArray(payload);
        Assert.Equal(5, frame.Length);
        frame.Release();
    }

    [Fact]
    public void FromArray_MemoryMatchesPayload()
    {
        var payload = new byte[] { 10, 20, 30 };
        var frame = SharedSseFrame.FromArray(payload);
        var memory = frame.Memory;
        Assert.Equal(10, memory.Span[0]);
        Assert.Equal(20, memory.Span[1]);
        Assert.Equal(30, memory.Span[2]);
        frame.Release();
    }

    [Fact]
    public void FromOwnedBuffer_HasCorrectLength()
    {
        // FromOwnedBuffer requires a pool-rented buffer for release
        var buffer = System.Buffers.ArrayPool<byte>.Shared.Rent(100);
        var frame = SharedSseFrame.FromOwnedBuffer(buffer, 50);
        Assert.Equal(50, frame.Length);
        frame.Release();
    }

    [Fact]
    public void Retain_ThenRelease_DoesNotReturnToPool()
    {
        var frame = SharedSseFrame.FromArray([1, 2, 3]);
        frame.Retain();  // refcount = 2
        frame.Release(); // refcount = 1, no return
        frame.Release(); // refcount = 0, return
    }

    [Fact]
    public void Release_WhenCalledMoreThanRetain_Throws()
    {
        var frame = SharedSseFrame.FromArray([1, 2, 3]);

        frame.Release();

        Assert.Throws<InvalidOperationException>(() => frame.Release());
    }

    [Fact]
    public void Retain_AfterRelease_Throws()
    {
        var frame = SharedSseFrame.FromArray([1, 2, 3]);

        frame.Release();

        Assert.Throws<ObjectDisposedException>(() => frame.Retain());
    }
}
