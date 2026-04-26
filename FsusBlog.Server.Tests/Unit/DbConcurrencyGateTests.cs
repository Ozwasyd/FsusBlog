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
}
