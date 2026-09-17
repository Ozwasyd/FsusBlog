using System.Diagnostics;

namespace FsusBlog.Server.Infrastructure.Observability;

public static class DependencyInjectionScopeTelemetry
{
    public static ObservedAsyncServiceScope CreateAsyncScope(
        IServiceProvider serviceProvider,
        string operation)
    {
        Activity? activity = FsusObservability.StartActivity("di.scope", "dependency_injection");
        FsusObservability.SetTag(activity, "fsus.operation", operation);
        try
        {
            return new ObservedAsyncServiceScope(serviceProvider.CreateAsyncScope(), activity);
        }
        catch
        {
            activity?.Dispose();
            throw;
        }
    }

    public static ObservedAsyncServiceScope CreateAsyncScope(
        IServiceScopeFactory scopeFactory,
        string operation)
    {
        Activity? activity = FsusObservability.StartActivity("di.scope", "dependency_injection");
        FsusObservability.SetTag(activity, "fsus.operation", operation);
        try
        {
            return new ObservedAsyncServiceScope(scopeFactory.CreateAsyncScope(), activity);
        }
        catch
        {
            activity?.Dispose();
            throw;
        }
    }
}

public sealed class ObservedAsyncServiceScope(AsyncServiceScope scope, Activity? activity) : IAsyncDisposable
{
    private int _disposed;

    public IServiceProvider ServiceProvider => scope.ServiceProvider;

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        try
        {
            await scope.DisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            activity?.Dispose();
        }
    }
}
