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
}
