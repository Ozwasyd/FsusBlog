namespace FsusBlog.Server.Infrastructure.Execution;

public static class BackgroundTaskExecutor
{
    private static readonly TimeSpan s_defaultRetryDelay = TimeSpan.FromSeconds(5);

    public static async Task RunAsync(
        Func<CancellationToken, Task> action,
        ILogger logger,
        string operation,
        CancellationToken stoppingToken,
        Func<Task>? onCancelled = null,
        Func<Exception, Task>? onFaulted = null,
        Func<Task>? onFinally = null)
    {
        try
        {
            await action(stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            if (onCancelled is not null)
            {
                await onCancelled().ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Background task failed: {Operation}", operation);
            if (onFaulted is not null)
            {
                await onFaulted(ex).ConfigureAwait(false);
            }
        }
        finally
        {
            if (onFinally is not null)
            {
                await onFinally().ConfigureAwait(false);
            }
        }
    }

    public static async Task RunLoopAsync(
        Func<CancellationToken, Task<bool>> iteration,
        ILogger logger,
        string operation,
        CancellationToken stoppingToken,
        TimeSpan? retryDelay = null,
        Func<Task>? onCancelled = null,
        Func<Exception, Task>? onFaulted = null,
        Func<Task>? onFinally = null)
    {
        TimeSpan faultDelay = retryDelay ?? s_defaultRetryDelay;

        try
        {
            while (true)
            {
                stoppingToken.ThrowIfCancellationRequested();

                try
                {
                    bool shouldContinue = await iteration(stoppingToken).ConfigureAwait(false);
                    if (!shouldContinue)
                    {
                        break;
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogError(ex, "Background loop iteration failed: {Operation}", operation);
                    if (onFaulted is not null)
                    {
                        await onFaulted(ex).ConfigureAwait(false);
                    }

                    if (faultDelay > TimeSpan.Zero)
                    {
                        await Task.Delay(faultDelay, stoppingToken).ConfigureAwait(false);
                    }
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            if (onCancelled is not null)
            {
                await onCancelled().ConfigureAwait(false);
            }
        }
        finally
        {
            if (onFinally is not null)
            {
                await onFinally().ConfigureAwait(false);
            }
        }
    }
}
