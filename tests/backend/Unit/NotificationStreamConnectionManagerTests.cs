using System.Buffers;
using System.Collections.Concurrent;
using System.Reflection;
using System.Reflection.Emit;

using FsusBlog.Server.Infrastructure.NotificationStream;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests.Unit;

public sealed class NotificationStreamConnectionManagerTests
{
    [Fact]
    public void RegisterAndRemove_MaintainsUserAndGroupIndexesIndependently()
    {
        NotificationStreamConnectionManager manager = CreateManager();
        manager.RegisterConnection("content-user", "42", ["content"]);
        manager.RegisterConnection("admin-user", "99", ["admin"]);

        Assert.Equal(1, Publish(manager, new NotificationStreamUserTarget("42")));
        Assert.Equal(1, Publish(manager, new NotificationStreamGroupTarget("content")));
        Assert.Equal(1, Publish(manager, new NotificationStreamUserTarget("99")));
        Assert.Equal(1, Publish(manager, new NotificationStreamGroupTarget("admin")));

        manager.RemoveConnection("content-user");

        Assert.Equal(0, Publish(manager, new NotificationStreamUserTarget("42")));
        Assert.Equal(0, Publish(manager, new NotificationStreamGroupTarget("content")));
        Assert.Equal(1, Publish(manager, new NotificationStreamUserTarget("99")));
        Assert.Equal(1, Publish(manager, new NotificationStreamGroupTarget("admin")));
    }

    [Fact]
    public void Publish_ObservesIndexSnapshotAfterMembershipChanges()
    {
        NotificationStreamConnectionManager manager = CreateManager();
        manager.RegisterConnection("first", "42", []);
        manager.RegisterConnection("second", "42", []);

        Assert.Equal(2, Publish(manager, new NotificationStreamUserTarget("42")));

        manager.RemoveConnection("first");
        Assert.Equal(1, Publish(manager, new NotificationStreamUserTarget("42")));

        manager.RegisterConnection("third", "42", []);
        Assert.Equal(2, Publish(manager, new NotificationStreamUserTarget("42")));
    }

    [Fact]
    public void Publish_MultiUserTargetDeduplicatesRepeatedUserIdsOnce()
    {
        NotificationStreamConnectionManager manager = CreateManager();
        manager.RegisterConnection("user-10", "10", []);
        manager.RegisterConnection("user-20", "20", []);

        int delivered = Publish(
            manager,
            new NotificationStreamMultiUserTarget(["10", "10", "20", "20", "missing"]));

        Assert.Equal(2, delivered);
    }

    [Fact]
    public void TryRemoveBucketIfCurrent_DoesNotRemoveReplacedBucket()
    {
        const string Key = "user:42";
        var oldBucket = new ConnectionIndexBucket();
        var newBucket = new ConnectionIndexBucket();
        newBucket.Add("conn-new");

        var index = new ConcurrentDictionary<string, ConnectionIndexBucket>(StringComparer.Ordinal);
        index[Key] = oldBucket;
        index[Key] = newBucket;

        bool removed = NotificationStreamConnectionManager.TryRemoveBucketIfCurrent(index, Key, oldBucket);

        Assert.False(removed);
        Assert.True(index.TryGetValue(Key, out ConnectionIndexBucket? currentBucket));
        Assert.Same(newBucket, currentBucket);
    }

    [Fact]
    public void TryRemoveBucketIfCurrent_RemovesWhenCurrent()
    {
        const string Key = "user:99";
        var bucket = new ConnectionIndexBucket();

        var index = new ConcurrentDictionary<string, ConnectionIndexBucket>(StringComparer.Ordinal);
        index[Key] = bucket;

        bool removed = NotificationStreamConnectionManager.TryRemoveBucketIfCurrent(index, Key, bucket);

        Assert.True(removed);
        Assert.False(index.ContainsKey(Key));
    }

    [Fact]
    public void TryRemoveBucketIfCurrent_DoesNotRemoveCurrentNonEmptyBucket()
    {
        const string Key = "user:100";
        var bucket = new ConnectionIndexBucket();
        bucket.Add("conn-new");

        var index = new ConcurrentDictionary<string, ConnectionIndexBucket>(StringComparer.Ordinal);
        index[Key] = bucket;

        bool removed = NotificationStreamConnectionManager.TryRemoveBucketIfCurrent(index, Key, bucket);

        Assert.False(removed);
        Assert.True(index.TryGetValue(Key, out ConnectionIndexBucket? currentBucket));
        Assert.Same(bucket, currentBucket);
        Assert.Contains("conn-new", currentBucket.Snapshot);
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

    private static NotificationStreamConnectionManager CreateManager()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection()
            .Build();
        return new NotificationStreamConnectionManager(
            configuration,
            NullLogger<NotificationStreamConnectionManager>.Instance);
    }

    private static int Publish(NotificationStreamConnectionManager manager, NotificationStreamTarget target)
    {
        SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray([1, 2, 3]);
        int delivered = manager.Publish(frame, target);
        frame.Release();
        return delivered;
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// NotificationStreamConnectionManager integration tests (registration, publish, etc.)
// ──────────────────────────────────────────────────────────────────────────────

public class NotificationStreamConnectionManagerIntegrationTests
{
    private static NotificationStreamConnectionManager MakeManager(
        int? queueCapacity = null,
        int? maxGlobalConnections = null,
        int? maxConnectionsPerIp = null,
        int? maxConnectionsPerAccount = null,
        long? queueByteCapacity = null,
        int? queueMaximumAgeMs = null)
    {
        var values = new Dictionary<string, string?>();
        if (queueCapacity.HasValue)
        {
            values["NotificationStream:QueueCapacity"] = queueCapacity.ToString();
        }

        if (maxGlobalConnections.HasValue)
        {
            values["NotificationStream:MaxConnectionsGlobal"] = maxGlobalConnections.ToString();
        }

        if (maxConnectionsPerIp.HasValue)
        {
            values["NotificationStream:MaxConnectionsPerIp"] = maxConnectionsPerIp.ToString();
        }

        if (maxConnectionsPerAccount.HasValue)
        {
            values["NotificationStream:MaxConnectionsPerAccount"] = maxConnectionsPerAccount.ToString();
        }

        if (queueByteCapacity.HasValue)
        {
            values["NotificationStream:QueueByteCapacity"] = queueByteCapacity.ToString();
        }

        if (queueMaximumAgeMs.HasValue)
        {
            values["NotificationStream:QueueMaximumAgeMs"] = queueMaximumAgeMs.ToString();
        }

        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(values)
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
    public void RegisterConnection_WhenGlobalQuotaExceeded_RejectsBeforeConnectionIsIndexed()
    {
        var mgr = MakeManager(maxGlobalConnections: 1);
        mgr.RegisterConnection("conn1", "user1", []);

        var ex = Assert.Throws<NotificationStreamConnectionLimitExceededException>(() =>
            mgr.RegisterConnection("conn2", "user2", [], clientIp: "203.0.113.20"));

        Assert.Equal(NotificationStreamConnectionLimitScope.Global, ex.Scope);
        Assert.Equal(1, mgr.ConnectionCount);
    }

    [Fact]
    public void RegisterConnection_WhenAccountQuotaExceeded_RejectsSameAccountOnly()
    {
        var mgr = MakeManager(maxConnectionsPerAccount: 1);
        mgr.RegisterConnection("conn1", "user1", []);

        var ex = Assert.Throws<NotificationStreamConnectionLimitExceededException>(() =>
            mgr.RegisterConnection("conn2", "user1", [], clientIp: "203.0.113.21"));

        Assert.Equal(NotificationStreamConnectionLimitScope.Account, ex.Scope);
        Assert.Equal(1, mgr.ConnectionCount);

        mgr.RegisterConnection("conn3", "user2", [], clientIp: "203.0.113.21");
        Assert.Equal(2, mgr.ConnectionCount);
    }

    [Fact]
    public void RegisterConnection_WhenIpQuotaExceeded_RejectsAcrossAccounts()
    {
        var mgr = MakeManager(maxConnectionsPerIp: 1);
        mgr.RegisterConnection("conn1", "user1", [], clientIp: "203.0.113.22");

        var ex = Assert.Throws<NotificationStreamConnectionLimitExceededException>(() =>
            mgr.RegisterConnection("conn2", "user2", [], clientIp: "203.0.113.22"));

        Assert.Equal(NotificationStreamConnectionLimitScope.Ip, ex.Scope);
        Assert.Equal(1, mgr.ConnectionCount);
    }

    [Fact]
    public void RemoveConnection_ReleasesConnectionQuota()
    {
        var mgr = MakeManager(maxGlobalConnections: 1, maxConnectionsPerIp: 1, maxConnectionsPerAccount: 1);
        mgr.RegisterConnection("conn1", "user1", [], clientIp: "203.0.113.23");
        mgr.RemoveConnection("conn1");

        mgr.RegisterConnection("conn2", "user1", [], clientIp: "203.0.113.23");

        Assert.Equal(1, mgr.ConnectionCount);
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
    public void Publish_ToConnection_PreservesPerConnectionFrameOrdering()
    {
        var mgr = MakeManager();
        NotificationStreamConnection connection = mgr.RegisterConnection("ordered", "user-order", []);
        SharedNotificationStreamFrame first = SharedNotificationStreamFrame.FromArray([0x01]);
        SharedNotificationStreamFrame second = SharedNotificationStreamFrame.FromArray([0x02]);

        Assert.Equal(1, mgr.Publish(first, new NotificationStreamUserTarget("user-order")));
        Assert.Equal(1, mgr.Publish(second, new NotificationStreamUserTarget("user-order")));
        first.Release();
        second.Release();

        Assert.True(connection.Reader.TryRead(out SharedNotificationStreamFrame? firstQueued));
        Assert.True(connection.Reader.TryRead(out SharedNotificationStreamFrame? secondQueued));
        Assert.Equal(0x01, firstQueued.Memory.Span[0]);
        Assert.Equal(0x02, secondQueued.Memory.Span[0]);

        connection.AcknowledgeDequeuedFrame();
        firstQueued.Release();
        connection.AcknowledgeDequeuedFrame();
        secondQueued.Release();
        mgr.RemoveConnection("ordered");
    }

    [Fact]
    public async Task RegisterPublishRemove_AllowsConcurrentConnections()
    {
        const int Count = 128;
        var mgr = MakeManager(queueCapacity: 512, maxConnectionsPerIp: Count);

        await Task.WhenAll(Enumerable.Range(0, Count).Select(i =>
            Task.Run(() => mgr.RegisterConnection($"conn-{i}", $"user-{i % 16}", ["group-all"]))));

        Assert.Equal(Count, mgr.ConnectionCount);

        SharedNotificationStreamFrame frame = MakeFrame();
        int delivered = mgr.Publish(frame, new NotificationStreamGroupTarget("group-all"));
        frame.Release();

        Assert.Equal(Count, delivered);

        await Task.WhenAll(Enumerable.Range(0, Count).Select(i =>
            Task.Run(() => mgr.RemoveConnection($"conn-{i}"))));

        Assert.Equal(0, mgr.ConnectionCount);
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
    public void QueueCapacity_Default_Allows256AndRejects257thFrame()
    {
        const int DefaultQueueCapacity = 256;
        NotificationStreamConnectionManager manager = MakeManager();
        NotificationStreamConnection connection = manager.RegisterConnection("default-capacity", null, []);

        try
        {
            for (int i = 0; i < DefaultQueueCapacity; i++)
            {
                SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray([(byte)i]);
                frame.Retain();
                bool accepted = connection.TryEnqueue(frame);
                frame.Release();

                Assert.True(accepted, $"default queue rejected frame {i + 1} before its 256-frame boundary");
            }

            Assert.Equal(DefaultQueueCapacity, connection.QueuedFrameCount);
            Assert.Equal(DefaultQueueCapacity, connection.QueuedBytes);
            Assert.False(connection.IsClosed);

            SharedNotificationStreamFrame rejected = SharedNotificationStreamFrame.FromArray([0xff]);
            rejected.Retain();
            bool overflowAccepted = connection.TryEnqueue(rejected);
            rejected.Release();

            Assert.False(overflowAccepted);
            Assert.Equal(DefaultQueueCapacity, connection.QueuedFrameCount);
            Assert.Equal(DefaultQueueCapacity, connection.QueuedBytes);
            Assert.Equal(1, connection.DroppedCount);
            Assert.True(connection.IsClosed);
            Assert.EndsWith(":connection_frame_budget", connection.CloseInstruction.Reason, StringComparison.Ordinal);
            Assert.Throws<InvalidOperationException>(() => rejected.Release());

            for (int i = 0; i < DefaultQueueCapacity; i++)
            {
                Assert.True(connection.Reader.TryRead(out SharedNotificationStreamFrame? dequeued));
                try
                {
                    Assert.Equal((byte)i, dequeued.Memory.Span[0]);
                }
                finally
                {
                    connection.AcknowledgeDequeuedFrame();
                    dequeued.Release();
                }
            }

            Assert.False(connection.Reader.TryRead(out _));
            Assert.Equal(0, connection.QueuedFrameCount);
            Assert.Equal(0, connection.QueuedBytes);
        }
        finally
        {
            manager.RemoveConnection("default-capacity");
        }

        Assert.Equal(0, manager.ConnectionCount);
    }

    [Fact]
    public void QueueCapacity_ConfiguredBelowMinimum_Allows32AndRejects33rdFrame()
    {
        AssertConfiguredQueueCapacityBoundary(
            configuredCapacity: 5,
            expectedCapacity: 32,
            connectionId: "minimum-capacity");
    }

    [Fact]
    public void QueueCapacity_ConfiguredAboveMaximum_Allows4096AndRejects4097thFrame()
    {
        AssertConfiguredQueueCapacityBoundary(
            configuredCapacity: 99_999,
            expectedCapacity: 4096,
            connectionId: "maximum-capacity");
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

    private static void AssertConfiguredQueueCapacityBoundary(
        int configuredCapacity,
        int expectedCapacity,
        string connectionId)
    {
        NotificationStreamConnectionManager manager = MakeManager(
            queueCapacity: configuredCapacity,
            queueByteCapacity: 64L * 1024 * 1024,
            queueMaximumAgeMs: 300_000);
        NotificationStreamConnection connection =
            manager.RegisterConnection(connectionId, null, []);

        try
        {
            for (int index = 0; index < expectedCapacity; index++)
            {
                SharedNotificationStreamFrame frame =
                    SharedNotificationStreamFrame.FromArray([(byte)index]);
                frame.Retain();
                bool accepted = connection.TryEnqueue(frame);
                frame.Release();

                Assert.True(
                    accepted,
                    $"configured capacity {configuredCapacity} rejected frame {index + 1} before normalized boundary {expectedCapacity}");
            }

            Assert.Equal(expectedCapacity, connection.QueuedFrameCount);
            Assert.Equal(expectedCapacity, connection.QueuedBytes);
            Assert.False(connection.IsClosed);

            SharedNotificationStreamFrame rejected =
                SharedNotificationStreamFrame.FromArray([0xff]);
            rejected.Retain();
            bool overflowAccepted = connection.TryEnqueue(rejected);
            rejected.Release();

            Assert.False(
                overflowAccepted,
                $"configured capacity {configuredCapacity} accepted frame {expectedCapacity + 1} beyond normalized boundary {expectedCapacity}");
            Assert.Equal(expectedCapacity, connection.QueuedFrameCount);
            Assert.Equal(expectedCapacity, connection.QueuedBytes);
            Assert.Equal(1, connection.DroppedCount);
            Assert.True(connection.IsClosed);
            Assert.EndsWith(
                ":connection_frame_budget",
                connection.CloseInstruction.Reason,
                StringComparison.Ordinal);
            Assert.Throws<InvalidOperationException>(() => rejected.Release());

            for (int index = 0; index < expectedCapacity; index++)
            {
                Assert.True(connection.Reader.TryRead(out SharedNotificationStreamFrame? dequeued));
                Assert.Equal((byte)index, dequeued.Memory.Span[0]);
                connection.AcknowledgeDequeuedFrame();
                dequeued.Release();
                Assert.Throws<InvalidOperationException>(() => dequeued.Release());
            }

            Assert.False(connection.Reader.TryRead(out _));
            Assert.Equal(0, connection.QueuedFrameCount);
            Assert.Equal(0, connection.QueuedBytes);
        }
        finally
        {
            manager.RemoveConnection(connectionId);
        }

        Assert.Equal(0, manager.ConnectionCount);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// NotificationStreamTargets tests
// ──────────────────────────────────────────────────────────────────────────────

public class NotificationStreamTargetTests2
{
}
