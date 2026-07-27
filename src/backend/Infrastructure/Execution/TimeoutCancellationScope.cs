namespace FsusBlog.Server.Infrastructure.Execution;

/// <summary>
/// Owns a bounded cancellation token and releases its timer/registrations at the end of the operation.
/// </summary>
public sealed class TimeoutCancellationScope : IDisposable
{
    private readonly CancellationTokenSource _timeout;
    private readonly CancellationTokenSource? _linked;

    private TimeoutCancellationScope(CancellationTokenSource timeout, CancellationTokenSource? linked, CancellationToken parent)
    {
        _timeout = timeout;
        _linked = linked;
        ParentToken = parent;
        Token = linked?.Token ?? timeout.Token;
    }

    public CancellationToken Token
    {
        get;
    }

    public CancellationToken ParentToken
    {
        get;
    }

    public bool IsCallerCancellationRequested => ParentToken.IsCancellationRequested;

    public bool IsTimeoutCancellationRequested => _timeout.IsCancellationRequested && !ParentToken.IsCancellationRequested;

    public static TimeoutCancellationScope Create(TimeSpan timeout, CancellationToken parentToken = default)
    {
        var timeoutSource = new CancellationTokenSource(timeout);
        CancellationTokenSource? linked = parentToken.CanBeCanceled
            ? CancellationTokenSource.CreateLinkedTokenSource(parentToken, timeoutSource.Token)
            : null;
        return new TimeoutCancellationScope(timeoutSource, linked, parentToken);
    }

    public void Dispose()
    {
        _linked?.Dispose();
        _timeout.Dispose();
    }
}
