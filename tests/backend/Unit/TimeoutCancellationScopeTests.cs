using System.Reflection;

using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests.Unit;

public sealed class TimeoutCancellationScopeTests
{
    [Fact]
    public void TenThousandCompletedScopesDisposeTheirTimerOwnersImmediately()
    {
        var handles = new List<WaitHandle>();
        for (int index = 0; index < 10_000; index++)
        {
            using var scope = TimeoutCancellationScope.Create(TimeSpan.FromSeconds(5));
            handles.Add(scope.Token.WaitHandle);
        }

        Assert.All(handles, static handle => Assert.True(handle.SafeWaitHandle.IsClosed));
    }

    [Fact]
    public async Task EarlyCompletionReleasesTheTimeoutTimerWithoutWaitingForItsDeadline()
    {
        WaitHandle handle;
        using (TimeoutCancellationScope scope = TimeoutCancellationScope.Create(TimeSpan.FromSeconds(5)))
        {
            handle = scope.Token.WaitHandle;
            await Task.CompletedTask;
            Assert.False(scope.Token.IsCancellationRequested);
        }

        Assert.True(handle.SafeWaitHandle.IsClosed);
    }

    [Fact]
    public async Task CallerCancellationAndTimeoutRemainDistinguishable()
    {
        using var caller = new CancellationTokenSource();
        using (TimeoutCancellationScope scope = TimeoutCancellationScope.Create(TimeSpan.FromSeconds(5), caller.Token))
        {
            caller.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Task.Delay(Timeout.InfiniteTimeSpan, scope.Token));
            Assert.True(scope.IsCallerCancellationRequested);
            Assert.False(scope.IsTimeoutCancellationRequested);
        }

        using (TimeoutCancellationScope scope = TimeoutCancellationScope.Create(TimeSpan.FromMilliseconds(10)))
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Task.Delay(Timeout.InfiniteTimeSpan, scope.Token));
            Assert.False(scope.IsCallerCancellationRequested);
            Assert.True(scope.IsTimeoutCancellationRequested);
        }
    }

    [Fact]
    public void ProductionTimeoutDurationsRemainFiveSeconds()
    {
        Assert.Equal(
            TimeSpan.FromSeconds(5),
            ReadStaticTimeout(typeof(CommentCommandService), "s_shortOperationTimeout"));
        Assert.Equal(
            TimeSpan.FromSeconds(5),
            ReadStaticTimeout(typeof(NotificationStreamSessionService), "s_closeTimeout"));
    }

    private static TimeSpan ReadStaticTimeout(Type owner, string fieldName)
        => Assert.IsType<TimeSpan>(owner
            .GetField(fieldName, BindingFlags.Static | BindingFlags.NonPublic)!
            .GetValue(null));
}
