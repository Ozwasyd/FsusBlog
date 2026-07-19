namespace FsusBlog.Server.Infrastructure.Bootstrap;

public sealed record StartupLifecycleTaskReport(
    string Status,
    DateTimeOffset UpdatedAt,
    string? Detail);

public sealed record StartupRuntimeSnapshot(
    bool SystemCachesClearedOnStartup,
    IReadOnlyDictionary<string, StartupLifecycleTaskReport> Tasks);

/// <summary>
/// Thread-safe runtime projection of startup lifecycle outcomes. Startup workers own
/// validation and lifecycle rules; the composition root only registers their modules.
/// </summary>
public sealed class StartupRuntimeState
{
    private readonly object _gate = new();
    private readonly Dictionary<string, StartupLifecycleTaskReport> _startupTasks = new(StringComparer.Ordinal);

    public bool SystemCachesClearedOnStartup
    {
        get; set;
    }

    public void ReportStartupTask(string taskName, string status, string? detail = null)
    {
        lock (_gate)
        {
            _startupTasks[taskName] = new StartupLifecycleTaskReport(status, DateTimeOffset.UtcNow, detail);
        }
    }

    public IReadOnlyDictionary<string, StartupLifecycleTaskReport> GetStartupTasks()
    {
        lock (_gate)
        {
            return new Dictionary<string, StartupLifecycleTaskReport>(_startupTasks, StringComparer.Ordinal);
        }
    }

    public StartupRuntimeSnapshot CreateSnapshot()
    {
        lock (_gate)
        {
            return new StartupRuntimeSnapshot(
                SystemCachesClearedOnStartup,
                new Dictionary<string, StartupLifecycleTaskReport>(_startupTasks, StringComparer.Ordinal));
        }
    }
}
