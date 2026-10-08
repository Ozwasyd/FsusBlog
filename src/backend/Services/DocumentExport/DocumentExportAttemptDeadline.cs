namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// One monotonic wall deadline for the claimed job attempt, including all
/// provider stages and verification. Stage receipts keep their own authority.
/// </summary>
internal sealed class DocumentExportAttemptDeadline : IDisposable
{
    private readonly TimeProvider _time;
    private readonly long _startedAt;
    private readonly TimeSpan _wallTime;
    private readonly CancellationTokenSource _timeout;
    private readonly CancellationTokenSource _operation = new();
    private readonly CancellationTokenRegistration _callerRegistration;
    private readonly CancellationTokenRegistration _stopRegistration;
    private readonly CancellationTokenRegistration _timeoutRegistration;
    private int _firstCancellation;

    private enum CancellationOrigin
    {
        Caller = 1,
        Stop,
        Deadline
    }

    internal DocumentExportAttemptDeadline(DocumentExportTask task, TimeProvider time,
        CancellationToken caller, CancellationToken stop)
    {
        _time = time;
        _wallTime = DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets.WallTime;
        _startedAt = time.GetTimestamp();
        _timeout = new CancellationTokenSource(_wallTime, time);
        _callerRegistration = caller.Register(() => Cancel(CancellationOrigin.Caller));
        _stopRegistration = stop.Register(() => Cancel(CancellationOrigin.Stop));
        _timeoutRegistration = _timeout.Token.Register(() => Cancel(CancellationOrigin.Deadline));
    }

    internal CancellationToken Token => _operation.Token;

    internal bool DeadlineCancelled => Volatile.Read(ref _firstCancellation) == (int)CancellationOrigin.Deadline;

    private bool IsExpired => _timeout.IsCancellationRequested
        || _time.GetElapsedTime(_startedAt) >= _wallTime;

    private void Cancel(CancellationOrigin origin)
    {
        Interlocked.CompareExchange(ref _firstCancellation, (int)origin, 0);
        _operation.Cancel();
    }

    internal void ThrowIfExpired()
    {
        if (IsExpired)
        {
            Cancel(CancellationOrigin.Deadline);
            if (!DeadlineCancelled)
            {
                Token.ThrowIfCancellationRequested();
            }
            // This does not synthesize a sandbox receipt or cleanup claim.
            throw new DocumentExportBudgetExceededException(
                "Document export attempt exceeded its wall-time budget.", "task-wall-time-budget");
        }
    }

    public void Dispose()
    {
        _callerRegistration.Dispose();
        _stopRegistration.Dispose();
        _timeoutRegistration.Dispose();
        _timeout.Dispose();
        _operation.Dispose();
    }
}
