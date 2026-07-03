using FsusBlog.Server.Infrastructure.Execution;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests;

public sealed class DbConcurrencyGateTests
{
    [Fact]
    public async Task ExecuteAsync_WhenTimedOut_UsesFallback()
    {
        var gate = new DbConcurrencyGate(
            new DbConcurrencyGateOptions(1, TimeSpan.FromMilliseconds(50)),
            NullLogger<DbConcurrencyGate>.Instance);
        var hold = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        Task<string> first = gate.ExecuteAsync(
            "hold",
            async _ =>
            {
                entered.SetResult(true);
                await hold.Task;
                return "leader";
            },
            _ => Task.FromResult("timeout"));

        await entered.Task;

        string second = await gate.ExecuteAsync(
            "timeout",
            _ => Task.FromResult("should-not-run"),
            _ => Task.FromResult("fallback"));

        hold.SetResult(true);
        string leader = await first;

        Assert.Equal("leader", leader);
        Assert.Equal("fallback", second);
    }

    [Fact]
    public async Task ExecuteAsync_IsReentrantWithinSameAsyncFlow()
    {
        var gate = new DbConcurrencyGate(
            new DbConcurrencyGateOptions(1, TimeSpan.FromMilliseconds(50)),
            NullLogger<DbConcurrencyGate>.Instance);

        string result = await gate.ExecuteAsync(
            "outer",
            async ct =>
            {
                return await gate.ExecuteAsync(
                    "inner",
                    _ => Task.FromResult("nested"),
                    _ => Task.FromResult("timeout"),
                    ct);
            },
            _ => Task.FromResult("outer-timeout"));

        Assert.Equal("nested", result);
    }

    [Fact]
    public async Task ExecuteAsync_SerializesConcurrentReentrantCallsWithinSameReservation()
    {
        var gate = new DbConcurrencyGate(
            new DbConcurrencyGateOptions(1, TimeSpan.FromMilliseconds(50)),
            NullLogger<DbConcurrencyGate>.Instance);
        var firstEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int active = 0;
        int peakActive = 0;

        string result = await gate.ExecuteAsync(
            "outer",
            async ct =>
            {
                Task<string> first = gate.ExecuteAsync(
                    "inner-one",
                    async _ =>
                    {
                        TrackActive(ref active, ref peakActive);
                        firstEntered.SetResult();
                        try
                        {
                            await releaseFirst.Task;
                            return "one";
                        }
                        finally
                        {
                            Interlocked.Decrement(ref active);
                        }
                    },
                    _ => Task.FromResult("timeout-one"),
                    ct);

                await firstEntered.Task;
                Task<string> second = gate.ExecuteAsync(
                    "inner-two",
                    _ =>
                    {
                        TrackActive(ref active, ref peakActive);
                        secondEntered.SetResult();
                        Interlocked.Decrement(ref active);
                        return Task.FromResult("two");
                    },
                    _ => Task.FromResult("timeout-two"),
                    ct);

                try
                {
                    await Task.Yield();
                    Assert.False(secondEntered.Task.IsCompleted);
                }
                finally
                {
                    releaseFirst.SetResult();
                }

                string[] values = await Task.WhenAll(first, second);
                return string.Join(",", values);
            },
            _ => Task.FromResult("outer-timeout"));

        Assert.Equal("one,two", result);
        Assert.Equal(1, peakActive);
    }

    [Fact]
    public async Task ExecuteAsync_ReentrantQueueWaitsForLocalSerialSlotBeyondGlobalTimeout()
    {
        var gate = new DbConcurrencyGate(
            new DbConcurrencyGateOptions(1, TimeSpan.FromMilliseconds(20)),
            NullLogger<DbConcurrencyGate>.Instance);
        var firstEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        string result = await gate.ExecuteAsync(
            "outer",
            async ct =>
            {
                Task<string> first = gate.ExecuteAsync(
                    "inner-one",
                    async _ =>
                    {
                        firstEntered.SetResult();
                        await releaseFirst.Task;
                        return "one";
                    },
                    _ => Task.FromResult("timeout-one"),
                    ct);

                await firstEntered.Task;
                Task<string> second = gate.ExecuteAsync(
                    "inner-two",
                    _ => Task.FromResult("two"),
                    _ => Task.FromResult("timeout-two"),
                    ct);

                await Task.Delay(75, ct);
                releaseFirst.SetResult();

                string[] values = await Task.WhenAll(first, second);
                return string.Join(",", values);
            },
            _ => Task.FromResult("outer-timeout"));

        Assert.Equal("one,two", result);
    }

    private static void TrackActive(ref int active, ref int peakActive)
    {
        int current = Interlocked.Increment(ref active);
        int observed;
        do
        {
            observed = Volatile.Read(ref peakActive);
            if (current <= observed)
            {
                return;
            }
        } while (Interlocked.CompareExchange(ref peakActive, current, observed) != observed);
    }
}
