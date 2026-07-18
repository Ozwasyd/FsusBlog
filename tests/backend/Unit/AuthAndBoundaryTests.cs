using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;

using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public class BoundaryExecutorTests
{
    private static readonly ILogger Logger = NullLogger.Instance;

    // Execute (sync)
    [Fact]
    public void Execute_ActionSucceeds_ReturnsSuccess()
    {
        var result = BoundaryExecutor.Execute(
            () => { /* no-op */ },
            ex => ErrorDetail.Create(ErrorCode.InfraFailure, ex.Message),
            Logger, "test-op");
        Assert.True(result.IsSuccess);
    }

    [Fact]
    public void Execute_ActionThrows_ReturnsFailure()
    {
        var result = BoundaryExecutor.Execute(
            () => throw new InvalidOperationException("boom"),
            ex => ErrorDetail.Create(ErrorCode.InfraFailure, ex.Message),
            Logger, "test-op");
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.InfraFailure, result.Error.Code);
    }

    [Fact]
    public void Execute_OperationCanceled_Rethrows()
    {
        Assert.Throws<OperationCanceledException>(() =>
            BoundaryExecutor.Execute(
                () => throw new OperationCanceledException(),
                ex => ErrorDetail.Create(ErrorCode.InfraFailure, ""),
                Logger, "op"));
    }

    // ExecuteResult (sync)
    [Fact]
    public void ExecuteResult_ActionSucceeds_ReturnsValue()
    {
        var result = BoundaryExecutor.ExecuteResult(
            () => 42,
            ex => ErrorDetail.Create(ErrorCode.InfraFailure, ex.Message),
            Logger, "test-op");
        Assert.True(result.IsSuccess);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ExecuteResult_ActionThrows_ReturnsFailure()
    {
        var result = BoundaryExecutor.ExecuteResult<int>(
            () => throw new Exception("fail"),
            ex => ErrorDetail.Create(ErrorCode.Validation, ex.Message),
            Logger, "test-op");
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    // ExecuteResultAsync (Task)
    [Fact]
    public async Task ExecuteResultAsync_Task_Succeeds()
    {
        var result = await BoundaryExecutor.ExecuteResultAsync(
            () => Task.CompletedTask,
            ex => ErrorDetail.Create(ErrorCode.InfraFailure, ex.Message),
            Logger, "test-op");
        Assert.True(result.IsSuccess);
    }

    [Fact]
    public async Task ExecuteResultAsync_Task_Throws_ReturnsFailure()
    {
        var result = await BoundaryExecutor.ExecuteResultAsync(
            () => Task.FromException(new Exception("async fail")),
            ex => ErrorDetail.Create(ErrorCode.InfraFailure, ex.Message),
            Logger, "test-op");
        Assert.False(result.IsSuccess);
    }

    // ExecuteResultAsync (Task<T>)
    [Fact]
    public async Task ExecuteResultAsyncT_Succeeds()
    {
        var result = await BoundaryExecutor.ExecuteResultAsync(
            () => Task.FromResult("value"),
            ex => ErrorDetail.Create(ErrorCode.InfraFailure, ex.Message),
            Logger, "test-op");
        Assert.True(result.IsSuccess);
        Assert.Equal("value", result.Value);
    }

    [Fact]
    public async Task ExecuteResultAsyncT_Throws_ReturnsFailure()
    {
        var result = await BoundaryExecutor.ExecuteResultAsync(
            () => Task.FromException<int>(new Exception("err")),
            ex => ErrorDetail.Create(ErrorCode.InfraFailure, ex.Message),
            Logger, "test-op");
        Assert.False(result.IsSuccess);
    }

    // ExecuteValueAsync
    [Fact]
    public async Task ExecuteValueAsync_Succeeds_ReturnsValue()
    {
        var result = await BoundaryExecutor.ExecuteValueAsync(
            () => Task.FromResult(99),
            ex => -1,
            Logger, "test-op");
        Assert.Equal(99, result);
    }

    [Fact]
    public async Task ExecuteValueAsync_Throws_ReturnsFallback()
    {
        var result = await BoundaryExecutor.ExecuteValueAsync(
            () => Task.FromException<int>(new Exception("err")),
            ex => -1,
            Logger, "test-op");
        Assert.Equal(-1, result);
    }

    // ExecuteAsync
    [Fact]
    public async Task ExecuteAsync_Succeeds()
    {
        bool ran = false;
        await BoundaryExecutor.ExecuteAsync(
            () => { ran = true; return Task.CompletedTask; },
            Logger, "op");
        Assert.True(ran);
    }

    [Fact]
    public async Task ExecuteAsync_Throws_DoesNotRethrow()
    {
        // ExecuteAsync swallows exceptions
        await BoundaryExecutor.ExecuteAsync(
            () => Task.FromException(new Exception("swallowed")),
            Logger, "op");
        // no exception → test passes
    }
}
