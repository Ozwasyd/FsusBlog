using System.Collections.Concurrent;
using FsusBlog.Server.Infrastructure.NotificationStream;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NotificationStreamConnectionManagerTests
{
    [Fact]
    public void Source_RegistersAndRemovesConnectionsUnderIndexGate()
    {
        string source = ReadManagerSource();
        int duplicateCheck = source.IndexOf("_byConnectionId.ContainsKey(connectionId)", StringComparison.Ordinal);
        int allocation = source.IndexOf("new NotificationStreamConnection(connectionId", StringComparison.Ordinal);

        Assert.Contains("private readonly object _indexGate", source, StringComparison.Ordinal);
        Assert.True(duplicateCheck >= 0, "RegisterConnection must check for a duplicate connection id before allocating the channel-backed connection.");
        Assert.True(allocation > duplicateCheck, "NotificationStreamConnection allocation must happen after the duplicate check.");
        Assert.Contains("lock (_indexGate)", source, StringComparison.Ordinal);
        Assert.Contains("AddToIndex(_byUserId, userId, connectionId)", source, StringComparison.Ordinal);
        Assert.Contains("RemoveFromIndex(_byUserId, connection.UserId, connectionId)", source, StringComparison.Ordinal);
    }

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

        bool removed = NotificationStreamConnectionManager.TryRemoveBucketIfCurrent(index, key, oldBucket);

        Assert.False(removed);
        Assert.True(index.TryGetValue(key, out ConcurrentDictionary<string, byte>? currentBucket));
        Assert.Same(newBucket, currentBucket);
    }

    [Fact]
    public void TryRemoveBucketIfCurrent_RemovesWhenCurrent()
    {
        const string key = "user:99";
        var bucket = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);

        var index = new ConcurrentDictionary<string, ConcurrentDictionary<string, byte>>(StringComparer.Ordinal);
        index[key] = bucket;

        bool removed = NotificationStreamConnectionManager.TryRemoveBucketIfCurrent(index, key, bucket);

        Assert.True(removed);
        Assert.False(index.ContainsKey(key));
    }

    [Fact]
    public void TryRemoveBucketIfCurrent_DoesNotRemoveCurrentNonEmptyBucket()
    {
        const string key = "user:100";
        var bucket = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
        bucket.TryAdd("conn-new", 0);

        var index = new ConcurrentDictionary<string, ConcurrentDictionary<string, byte>>(StringComparer.Ordinal);
        index[key] = bucket;

        bool removed = NotificationStreamConnectionManager.TryRemoveBucketIfCurrent(index, key, bucket);

        Assert.False(removed);
        Assert.True(index.TryGetValue(key, out ConcurrentDictionary<string, byte>? currentBucket));
        Assert.Same(bucket, currentBucket);
        Assert.True(currentBucket.ContainsKey("conn-new"));
    }

    [Fact]
    public void NotificationStreamTargetRouteCodec_GetReplayRoutes_ReturnsUserAndGroups()
    {
        IReadOnlyList<string> routes = NotificationStreamTargetRouteCodec.GetReplayRoutes("42", new HashSet<string>(["content", "admin"], StringComparer.Ordinal));

        Assert.Equal(3, routes.Count);
        Assert.Equal("u:42", routes[0]);
        Assert.Contains("g:content", routes);
        Assert.Contains("g:admin", routes);
    }

    [Fact]
    public void NotificationStreamTargetRouteCodec_GetStorageRoutes_ExpandsNotificationStreamMultiUserTargets()
    {
        IReadOnlyList<string> routes = NotificationStreamTargetRouteCodec.GetStorageRoutes("m:10, 20,,30");

        Assert.Equal(["u:10", "u:20", "u:30"], routes);
    }

    private static string ReadManagerSource()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            string root = directory.FullName;
            string path = Path.Combine(root, "src", "backend", "Infrastructure", "NotificationStream", "NotificationStreamConnectionManager.cs");
            if (File.Exists(path))
            {
                return File.ReadAllText(path);
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("Unable to locate NotificationStreamConnectionManager.cs.");
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// NotificationStreamConnectionManager integration tests (registration, publish, etc.)
// ──────────────────────────────────────────────────────────────────────────────

public class NotificationStreamConnectionManagerIntegrationTests
{
    private static NotificationStreamConnectionManager MakeManager(int? queueCapacity = null)
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(queueCapacity.HasValue
                ? new Dictionary<string, string?> { ["NotificationStream:QueueCapacity"] = queueCapacity.ToString() }
                : new Dictionary<string, string?>())
            .Build();
        return new NotificationStreamConnectionManager(config, NullLogger<NotificationStreamConnectionManager>.Instance);
    }

    private static SharedNotificationStreamFrame MakeFrame() => SharedNotificationStreamFrame.FromArray([1, 2, 3]);

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
        var before = mgr.Publish(frame, new NotificationStreamUserTarget("user1"));
        Assert.Equal(1, before);
        frame.Release();

        mgr.RemoveConnection("conn1");

        frame = MakeFrame();
        var after = mgr.Publish(frame, new NotificationStreamUserTarget("user1"));
        Assert.Equal(0, after);
        frame.Release();
    }

    [Fact]
    public void RemoveConnection_WithGroups_RemovesFromGroupIndex()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("conn1", null, ["grpA"]);

        var frame = MakeFrame();
        var before = mgr.Publish(frame, new NotificationStreamGroupTarget("grpA"));
        Assert.Equal(1, before);
        frame.Release();

        mgr.RemoveConnection("conn1");

        frame = MakeFrame();
        var after = mgr.Publish(frame, new NotificationStreamGroupTarget("grpA"));
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
        var delivered = mgr.Publish(frame, new NotificationStreamUserTarget("user1"));

        Assert.Equal(2, delivered);
        frame.Release();
    }

    [Fact]
    public void Publish_ToUser_NoMatch_ReturnsZero()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("conn1", "user2", []);

        var frame = MakeFrame();
        var delivered = mgr.Publish(frame, new NotificationStreamUserTarget("user1"));

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
        var delivered = mgr.Publish(frame, new NotificationStreamGroupTarget("groupA"));

        Assert.Equal(2, delivered);
        frame.Release();
    }

    [Fact]
    public void Publish_ToGroup_NoMembers_ReturnsZero()
    {
        var mgr = MakeManager();
        mgr.RegisterConnection("conn1", null, ["otherGroup"]);

        var frame = MakeFrame();
        var delivered = mgr.Publish(frame, new NotificationStreamGroupTarget("emptyGroup"));

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
        var delivered = mgr.Publish(frame, new NotificationStreamMultiUserTarget(["user1", "user2"]));

        Assert.Equal(2, delivered);
        frame.Release();
    }

    [Fact]
    public void Publish_ToEmptyManager_ReturnsZero()
    {
        var mgr = MakeManager();
        var frame = MakeFrame();
        var delivered = mgr.Publish(frame, new NotificationStreamUserTarget("anyuser"));

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

    [Fact]
    public void TryEnqueue_WhenQueueCapacityRejects_ReleasesTransferredRetain()
    {
        var connection = new NotificationStreamConnection("conn1", "user1", [], queueCapacity: 1);
        SharedNotificationStreamFrame queued = MakeFrame();
        queued.Retain();
        Assert.True(connection.TryEnqueue(queued));
        queued.Release();

        SharedNotificationStreamFrame rejected = MakeFrame();
        rejected.Retain();

        Assert.False(connection.TryEnqueue(rejected));

        rejected.Release();
        Assert.Throws<InvalidOperationException>(() => rejected.Release());

        Assert.True(connection.Reader.TryRead(out SharedNotificationStreamFrame? dequeued));
        connection.AcknowledgeDequeuedFrame();
        dequeued.Release();
        Assert.Throws<InvalidOperationException>(() => queued.Release());
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// NotificationStreamTargets tests
// ──────────────────────────────────────────────────────────────────────────────

public class NotificationStreamTargetTests2
{
    [Fact]
    public void NotificationStreamUserTarget_StoresUserId()
    {
        var target = new NotificationStreamUserTarget("user-123");
        Assert.Equal("user-123", target.UserId);
    }

    [Fact]
    public void NotificationStreamGroupTarget_StoresGroupName()
    {
        var target = new NotificationStreamGroupTarget("admin-group");
        Assert.Equal("admin-group", target.GroupName);
    }

    [Fact]
    public void NotificationStreamMultiUserTarget_StoresUserIds()
    {
        var ids = new List<string> { "user1", "user2", "user3" };
        var target = new NotificationStreamMultiUserTarget(ids);
        Assert.Equal(3, target.UserIds.Count);
    }

    [Fact]
    public void NotificationStreamGroups_AllGroupsAreDistinct()
    {
        var groups = new[] { NotificationStreamGroups.AuthenticatedUsers, NotificationStreamGroups.ContentFeed, NotificationStreamGroups.AdminUsers };
        Assert.Equal(groups.Length, groups.Distinct().Count());
    }

    [Fact]
    public void NotificationStreamGroups_AllNonEmpty()
    {
        Assert.NotEmpty(NotificationStreamGroups.AuthenticatedUsers);
        Assert.NotEmpty(NotificationStreamGroups.ContentFeed);
        Assert.NotEmpty(NotificationStreamGroups.AdminUsers);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// SharedNotificationStreamFrame tests
// ──────────────────────────────────────────────────────────────────────────────

public class SharedNotificationStreamFrameExtendedTests
{
    [Fact]
    public void FromArray_StoresPayload()
    {
        var payload = new byte[] { 1, 2, 3, 4, 5 };
        var frame = SharedNotificationStreamFrame.FromArray(payload);
        Assert.Equal(5, frame.Length);
        frame.Release();
    }

    [Fact]
    public void FromArray_MemoryMatchesPayload()
    {
        var payload = new byte[] { 10, 20, 30 };
        var frame = SharedNotificationStreamFrame.FromArray(payload);
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
        var frame = SharedNotificationStreamFrame.FromOwnedBuffer(buffer, 50);
        Assert.Equal(50, frame.Length);
        frame.Release();
    }

    [Fact]
    public void Retain_ThenRelease_DoesNotReturnToPool()
    {
        var frame = SharedNotificationStreamFrame.FromArray([1, 2, 3]);
        frame.Retain();  // refcount = 2
        frame.Release(); // refcount = 1, no return
        frame.Release(); // refcount = 0, return
    }

    [Fact]
    public void Release_WhenCalledMoreThanRetain_Throws()
    {
        var frame = SharedNotificationStreamFrame.FromArray([1, 2, 3]);

        frame.Release();

        Assert.Throws<InvalidOperationException>(() => frame.Release());
    }

    [Fact]
    public void Retain_AfterRelease_Throws()
    {
        var frame = SharedNotificationStreamFrame.FromArray([1, 2, 3]);

        frame.Release();

        Assert.Throws<ObjectDisposedException>(() => frame.Retain());
    }
}
