using FsusBlog.Server.Infrastructure.PublicAot;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static partial class PublicAotCrashWorkerProgram
{
    internal static PublicAotFileShellCache BuildCache(
        string root,
        Func<PublicAotArtifactCommitState, CancellationToken, Task>? observer = null)
    {
        IDatabase database = Substitute.For<IDatabase>();
        var subscriber = Substitute.For<ISubscriber>();
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        redis.GetSubscriber(Arg.Any<object?>()).Returns(subscriber);
        database.SetAddAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        database.SetRemoveAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue[]>(), Arg.Any<CommandFlags>())
            .Returns(call => Task.FromResult((long)call.ArgAt<RedisValue[]>(1).Length));
        subscriber.PublishAsync(Arg.Any<RedisChannel>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(1L));
        return new PublicAotFileShellCache(
            new CrashWorkerWebHostEnvironment(root),
            redis,
            NullLogger<PublicAotFileShellCache>.Instance,
            derivedPublisher: null,
            configuration: null,
            timeProvider: null,
            publicArtifactStorage: null,
            observer);
    }
}
