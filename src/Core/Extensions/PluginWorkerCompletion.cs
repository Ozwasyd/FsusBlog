namespace FsusBlog.V2.Core.Extensions;

internal static class PluginWorkerCompletion
{
    internal const string DrainFailure = "plugin-worker-drain";
    private static readonly object CleanupKey = new();

    internal static async Task<T> RunAsync<T>(Func<Task<T>> work, Func<Task> release)
    {
        Exception? primary = null;
        try { return await work(); }
        catch (Exception error) { primary = error; throw; }
        finally
        {
            try { await release(); }
            catch (Exception cleanup)
            {
                if (primary is null) throw new ExtensionRejectedException(DrainFailure);
                primary.Data[CleanupKey] = CleanupFailure(primary) is { } earlier ? new AggregateException(earlier, cleanup) : cleanup;
            }
        }
    }

    internal static Exception? CleanupFailure(Exception primary) => primary.Data[CleanupKey] as Exception;

    internal static async Task ReleaseAsync(params Func<Task>[] steps)
    {
        List<Exception>? failures = null;
        foreach (var step in steps)
        {
            try { await step(); }
            catch (Exception error) { (failures ??= []).Add(error); }
        }
        if (failures is not null) throw new AggregateException(failures);
    }

    internal static ExtensionRejectedException Translate(Exception primary, string code)
    {
        var translated = new ExtensionRejectedException(code);
        if (CleanupFailure(primary) is { } cleanup) translated.Data[CleanupKey] = cleanup;
        return translated;
    }

    internal static Task ReleaseProcessAsync(CancellationTokenSource deadline, Func<Task> release,
        Task<byte[]>? output, Task<byte[]>? errors) => ReleaseAsync(
            () => { deadline.Cancel(); return Task.CompletedTask; }, release, () => ObservePipesAsync(output, errors));

    private static async Task ObservePipesAsync(Task<byte[]>? output, Task<byte[]>? errors)
    {
        var pipes = Task.WhenAll((Task?)output ?? Task.CompletedTask, (Task?)errors ?? Task.CompletedTask);
        try { await pipes.WaitAsync(TimeSpan.FromSeconds(1)); }
        catch (TimeoutException) when (!pipes.IsCompleted) { throw new ExtensionRejectedException(DrainFailure); }
        catch (Exception) { } // The work outcome already determines the transport error.
    }

    internal static async Task<byte[]> ReadAsync(Stream stream, int limit, CancellationToken ct)
    {
        var data = new byte[limit + 1];
        var size = 0;
        while (size < data.Length)
        {
            var read = await stream.ReadAsync(data.AsMemory(size), ct);
            if (read == 0) return data[..size];
            size += read;
        }
        throw new ExtensionRejectedException("plugin-io-limit");
    }
}
