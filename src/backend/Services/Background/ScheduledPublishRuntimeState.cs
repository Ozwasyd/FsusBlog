namespace FsusBlog.Server.Services.Background;

public sealed record ScheduledPublishRuntimeSnapshot(
    string Status,
    DateTimeOffset UpdatedAt,
    int LastPublishedCount,
    int LastFailedCount,
    int DueBacklog,
    string? LastError);

public sealed class ScheduledPublishRuntimeState
{
    private readonly object _gate = new();
    private ScheduledPublishRuntimeSnapshot _snapshot = new(
        "idle",
        DateTimeOffset.UtcNow,
        0,
        0,
        0,
        null);

    public void ReportResult(int publishedCount, int failedCount, int dueBacklog, string? error = null)
    {
        lock (_gate)
        {
            _snapshot = new ScheduledPublishRuntimeSnapshot(
                failedCount > 0 ? "degraded" : "ok",
                DateTimeOffset.UtcNow,
                Math.Max(0, publishedCount),
                Math.Max(0, failedCount),
                Math.Max(0, dueBacklog),
                error);
        }
    }

    public void ReportFailure(string error)
    {
        lock (_gate)
        {
            _snapshot = _snapshot with
            {
                Status = "degraded",
                UpdatedAt = DateTimeOffset.UtcNow,
                LastFailedCount = Math.Max(1, _snapshot.LastFailedCount),
                LastError = error
            };
        }
    }

    public ScheduledPublishRuntimeSnapshot CreateSnapshot()
    {
        lock (_gate)
        {
            return _snapshot;
        }
    }
}
