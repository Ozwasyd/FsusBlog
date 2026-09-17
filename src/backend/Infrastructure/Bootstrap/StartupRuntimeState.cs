namespace FsusBlog.Server.Infrastructure.Bootstrap;

public sealed record StartupLifecycleTaskReport(
    string Status,
    DateTimeOffset UpdatedAt,
    string? Detail);

public sealed record StartupRuntimeSnapshot(
    bool SystemCachesClearedOnStartup,
    IReadOnlyDictionary<string, StartupLifecycleTaskReport> Tasks);

/// <summary>
/// Runtime projection of startup lifecycle outcomes. This state serializes cache-clear state,
/// task reports, and snapshot copies; startup workers retain validation and lifecycle ownership.
/// </summary>
public sealed class StartupRuntimeState
{
    // OWNERSHIP: This instance's gate serializes every mutable field and each detached snapshot copy.
    private readonly object _gate = new();
    private readonly Dictionary<string, StartupLifecycleTaskReport> _startupTasks = new(StringComparer.Ordinal);
    private bool _systemCachesClearedOnStartup;

    public bool SystemCachesClearedOnStartup
    {
        get
        {
            lock (_gate)
            {
                return _systemCachesClearedOnStartup;
            }
        }
        set
        {
            lock (_gate)
            {
                _systemCachesClearedOnStartup = value;
            }
        }
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
                _systemCachesClearedOnStartup,
                new Dictionary<string, StartupLifecycleTaskReport>(_startupTasks, StringComparer.Ordinal));
        }
    }
}
