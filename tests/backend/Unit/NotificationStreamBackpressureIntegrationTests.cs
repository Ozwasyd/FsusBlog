using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Shared.Contracts.NotificationStream;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NotificationStreamBackpressureIntegrationTests
{
    [Fact]
    public async Task Publisher_UnrelatedTargetsEnterRedisOrderingScopesConcurrently()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        var database = Substitute.For<IDatabase>();
        var keyScope = Substitute.For<IRuntimeKeyScope>();
        redis.GetDatabase().Returns(database);
        keyScope.PrefixKey(Arg.Any<string>()).Returns(call => call.Arg<string>());
        var bothLockAttemptsEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseLockAttempts = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        int concurrentLockAttempts = 0;
        int maximumConcurrentLockAttempts = 0;
        database.LockTakeAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan>(),
                Arg.Any<CommandFlags>())
            .Returns(async _ =>
            {
                int current = Interlocked.Increment(ref concurrentLockAttempts);
                NotificationStreamBackpressureTestSupport.UpdateMaximum(ref maximumConcurrentLockAttempts, current);
                if (current == 2)
                {
                    bothLockAttemptsEntered.TrySetResult(true);
                }

                await releaseLockAttempts.Task;
                Interlocked.Decrement(ref concurrentLockAttempts);
                return true;
            });
        database.LockReleaseAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<CommandFlags>())
            .Returns(true);
        database.StringIncrementAsync(Arg.Any<RedisKey>(), Arg.Any<long>(), Arg.Any<CommandFlags>())
            .Returns(1L, 2L);
        database.StreamAddAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<RedisValue>(),
                Arg.Any<RedisValue?>(),
                Arg.Any<int?>(),
                Arg.Any<bool>(),
                Arg.Any<CommandFlags>())
            .Returns((RedisValue)"1-0", (RedisValue)"2-0");
        var store = new NotificationStreamBacklogStore(
            RedisOperationExecutor.ForTestConnection(redis),
            keyScope,
            NullLogger<NotificationStreamBacklogStore>.Instance);
        NotificationStreamLocalFanoutQueue fanout = NotificationStreamBackpressureTestSupport.CreateQueue();
        var manager = new NotificationStreamConnectionManager(
            new ConfigurationBuilder().Build(),
            NullLogger<NotificationStreamConnectionManager>.Instance);
        var publisher = new RedisNotificationStreamPublisher(
            store,
            fanout,
            manager,
            new PolicyTestFrameCodec(),
            NullLogger<RedisNotificationStreamPublisher>.Instance);

        Task first = publisher.PublishAsync(
            NotificationStreamEventType.UnreadCountUpdated,
            1,
            new NotificationStreamUserTarget("account-a"));
        Task second = publisher.PublishAsync(
            NotificationStreamEventType.UnreadCountUpdated,
            2,
            new NotificationStreamUserTarget("account-b"));

        try
        {
            await bothLockAttemptsEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        }
        finally
        {
            releaseLockAttempts.TrySetResult(true);
        }
        await Task.WhenAll(first, second);

        Assert.Equal(2, maximumConcurrentLockAttempts);
        for (int i = 0; i < 2; i++)
        {
            NotificationStreamLocalFanoutWorkItem item = await fanout.DequeueAsync(CancellationToken.None);
            item.Frame.Release();
        }
    }
}
