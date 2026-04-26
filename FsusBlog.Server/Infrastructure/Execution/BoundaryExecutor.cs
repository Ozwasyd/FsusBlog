using FsusBlog.Core.Common;
using System.Diagnostics;

namespace FsusBlog.Server.Infrastructure.Execution;

public static class BoundaryExecutor
{
    public static Result Execute(
        Action action,
        Func<Exception, ErrorDetail> map,
        ILogger logger,
        string operation,
        LogLevel level = LogLevel.Warning)
    {
        try
        {
            action();
            return Result.Success();
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.Log(level, ex, "Boundary execution failed: {Operation}", operation);
            return Result.Failure(Normalize(map(ex)));
        }
    }

    public static Result<T> ExecuteResult<T>(
        Func<T> action,
        Func<Exception, ErrorDetail> map,
        ILogger logger,
        string operation,
        LogLevel level = LogLevel.Warning)
    {
        try
        {
            return Result<T>.Success(action());
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.Log(level, ex, "Boundary execution failed: {Operation}", operation);
            return Result<T>.Failure(Normalize(map(ex)));
        }
    }

    public static async Task<Result> ExecuteResultAsync(
        Func<Task> action,
        Func<Exception, ErrorDetail> map,
        ILogger logger,
        string operation)
    {
        try
        {
            await action().ConfigureAwait(false);
            return Result.Success();
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Boundary execution failed: {Operation}", operation);
            return Result.Failure(Normalize(map(ex)));
        }
    }

    public static async Task<Result<T>> ExecuteResultAsync<T>(
        Func<Task<T>> action,
        Func<Exception, ErrorDetail> map,
        ILogger logger,
        string operation)
    {
        try
        {
            return Result<T>.Success(await action().ConfigureAwait(false));
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Boundary execution failed: {Operation}", operation);
            return Result<T>.Failure(Normalize(map(ex)));
        }
    }

    public static async Task<T> ExecuteValueAsync<T>(
        Func<Task<T>> action,
        Func<Exception, T> fallback,
        ILogger logger,
        string operation,
        LogLevel level = LogLevel.Warning)
    {
        try
        {
            return await action().ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.Log(level, ex, "Boundary execution failed: {Operation}", operation);
            return fallback(ex);
        }
    }

    public static async Task ExecuteAsync(
        Func<Task> action,
        ILogger logger,
        string operation,
        LogLevel level = LogLevel.Warning)
    {
        try
        {
            await action().ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.Log(level, ex, "Boundary execution failed: {Operation}", operation);
        }
    }

    private static ErrorDetail Normalize(in ErrorDetail error)
        => error.Normalize().WithTraceId(Activity.Current?.Id);
}
