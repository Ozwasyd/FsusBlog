using System.Diagnostics;

namespace FsusBlog.V2.Platform.Extensions;

internal static class WorkerProcess
{
    internal static Task ReapAsync(Process process, bool entireProcessTree, TimeSpan timeout) =>
        PluginWorkerCompletion.ReleaseAsync(() =>
        {
            try
            {
                if (!process.HasExited) process.Kill(entireProcessTree);
            }
            catch (InvalidOperationException) when (process.HasExited) { }
            return Task.CompletedTask;
        }, () => process.WaitForExitAsync().WaitAsync(timeout));
}
