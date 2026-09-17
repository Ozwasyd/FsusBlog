using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;

using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests.Unit;

public class BoundaryExecutorTests
{
    private static readonly ILogger s_logger = NullLogger.Instance;

    // Execute (sync)
    [Fact]
    public void Execute_ActionSucceeds_ReturnsSuccess()
    {
        var result = BoundaryExecutor.Execute(
            () =>
            {
                // no-op
            },
            ex => ErrorDetail.Create(ErrorCode.InfraFailure, ex.Message),
            s_logger, "test-op");
        Assert.True(result.IsSuccess);
    }

    [Fact]
    public void Execute_ActionThrows_ReturnsFailure()
    {
        var result = BoundaryExecutor.Execute(
            () => throw new InvalidOperationException("boom"),
            ex => ErrorDetail.Create(ErrorCode.InfraFailure, ex.Message),
            s_logger, "test-op");
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
                s_logger, "op"));
    }

    // ExecuteResult (sync)
    [Fact]
    public void ExecuteResult_ActionSucceeds_ReturnsValue()
    {
        var result = BoundaryExecutor.ExecuteResult(
            () => 42,
            ex => ErrorDetail.Create(ErrorCode.InfraFailure, ex.Message),
            s_logger, "test-op");
        Assert.True(result.IsSuccess);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ExecuteResult_ActionThrows_ReturnsFailure()
    {
        var result = BoundaryExecutor.ExecuteResult<int>(
            () => throw new Exception("fail"),
            ex => ErrorDetail.Create(ErrorCode.Validation, ex.Message),
            s_logger, "test-op");
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
            s_logger, "test-op");
        Assert.True(result.IsSuccess);
    }

    [Fact]
    public async Task ExecuteResultAsync_Task_Throws_ReturnsFailure()
    {
        var result = await BoundaryExecutor.ExecuteResultAsync(
            () => Task.FromException(new Exception("async fail")),
            ex => ErrorDetail.Create(ErrorCode.InfraFailure, ex.Message),
            s_logger, "test-op");
        Assert.False(result.IsSuccess);
    }

    // ExecuteResultAsync (Task<T>)
    [Fact]
    public async Task ExecuteResultAsyncT_Succeeds()
    {
        var result = await BoundaryExecutor.ExecuteResultAsync(
            () => Task.FromResult("value"),
            ex => ErrorDetail.Create(ErrorCode.InfraFailure, ex.Message),
            s_logger, "test-op");
        Assert.True(result.IsSuccess);
        Assert.Equal("value", result.Value);
    }

    [Fact]
    public async Task ExecuteResultAsyncT_Throws_ReturnsFailure()
    {
        var result = await BoundaryExecutor.ExecuteResultAsync(
            () => Task.FromException<int>(new Exception("err")),
            ex => ErrorDetail.Create(ErrorCode.InfraFailure, ex.Message),
            s_logger, "test-op");
        Assert.False(result.IsSuccess);
    }

    // ExecuteValueAsync
    [Fact]
    public async Task ExecuteValueAsync_Succeeds_ReturnsValue()
    {
        var result = await BoundaryExecutor.ExecuteValueAsync(
            () => Task.FromResult(99),
            ex => -1,
            s_logger, "test-op");
        Assert.Equal(99, result);
    }

    [Fact]
    public async Task ExecuteValueAsync_Throws_ReturnsFallback()
    {
        var result = await BoundaryExecutor.ExecuteValueAsync(
            () => Task.FromException<int>(new Exception("err")),
            ex => -1,
            s_logger, "test-op");
        Assert.Equal(-1, result);
    }

    // ExecuteAsync
    [Fact]
    public async Task ExecuteAsync_Succeeds()
    {
        bool ran = false;
        await BoundaryExecutor.ExecuteAsync(
            () =>
            {
                ran = true;
                return Task.CompletedTask;
            },
            s_logger, "op");
        Assert.True(ran);
    }

    [Fact]
    public async Task ExecuteAsync_Throws_LogsOnceAndDoesNotRethrow()
    {
        const string Operation = "boundary-sentinel-operation";
        var logger = new CapturingLogger();
        var sentinel = new InvalidOperationException("sentinel-exception-text");
        int actionCount = 0;

        Exception? error = await Record.ExceptionAsync(
            () => BoundaryExecutor.ExecuteAsync(
                () =>
                {
                    actionCount++;
                    return Task.FromException(sentinel);
                },
                logger,
                Operation));

        Assert.Null(error);
        Assert.Equal(1, actionCount);

        LogEntry entry = Assert.Single(logger.Entries);
        Assert.Equal(LogLevel.Warning, entry.Level);
        Assert.Same(sentinel, entry.Exception);
        Assert.Equal($"Boundary execution failed: {Operation}", entry.FormattedMessage);
        Assert.DoesNotContain(sentinel.Message, entry.FormattedMessage, StringComparison.Ordinal);
        Assert.Equal(2, entry.State.Count);
        Assert.Contains(entry.State, property =>
            property.Key == "Operation" && Equals(property.Value, Operation));
        Assert.Contains(entry.State, property =>
            property.Key == "{OriginalFormat}" &&
            Equals(property.Value, "Boundary execution failed: {Operation}"));
    }

    [Fact]
    public async Task ExecuteAsync_OperationCanceled_RethrowsWithoutErrorLog()
    {
        var logger = new CapturingLogger();
        var cancellation = new OperationCanceledException("sentinel-cancellation");
        int actionCount = 0;

        OperationCanceledException propagated = await Assert.ThrowsAsync<OperationCanceledException>(
            () => BoundaryExecutor.ExecuteAsync(
                () =>
                {
                    actionCount++;
                    return Task.FromException(cancellation);
                },
                logger,
                "boundary-cancel-operation"));

        Assert.Same(cancellation, propagated);
        Assert.Equal(1, actionCount);
        Assert.Empty(logger.Entries);
    }

    private sealed class CapturingLogger : ILogger
    {
        public List<LogEntry> Entries { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            var structuredState = Assert.IsAssignableFrom<IReadOnlyList<KeyValuePair<string, object?>>>(state);
            Entries.Add(new LogEntry(logLevel, exception, formatter(state, exception), [.. structuredState]));
        }
    }

    private sealed record LogEntry(
        LogLevel Level,
        Exception? Exception,
        string FormattedMessage,
        IReadOnlyList<KeyValuePair<string, object?>> State);
}
