using System.Data.Common;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>Server-only proof of actual projection admission during JWT authentication.</summary>
internal interface IAdminAuthenticatedRequestFeature
{
    AdminAuthenticatedRequestLifetime Lifetime { get; }
}

internal sealed record AdminAuthenticatedRequestFeature(AdminAuthenticatedRequestLifetime Lifetime)
    : IAdminAuthenticatedRequestFeature;

/// <summary>
/// A bounded registration in the original projection. The registry, rather than possession of
/// claims or a validation record, establishes currentness. Dispose at request completion.
/// Cancellation is advisory; SQL row exclusion is required for final publication/commit.
/// </summary>
internal sealed class AdminAuthenticatedRequestLifetime : IDisposable
{
    private readonly AdminSessionProjection _owner;
    private readonly CancellationTokenSource _invalidated = new();
    private readonly object _notificationGate = new();
    private CancellationTokenRegistration _requestAborted;
    private ITimer? _timer;
    private bool _disposed;
    private bool _notificationStarted;
    private bool _notificationComplete;

    internal AdminAuthenticatedRequestLifetime(AdminSessionProjection owner, string bindingDigest)
    {
        _owner = owner;
        BindingDigest = bindingDigest;
        Invalidated = _invalidated.Token;
    }

    internal string BindingDigest { get; }
    internal CancellationToken Invalidated { get; }
    internal bool IsCurrent => _owner.IsRequestCurrent(this);

    internal void SetTimer(ITimer timer) => _timer = timer;

    internal void BindRequest(CancellationToken requestAborted)
    {
        CancellationTokenRegistration registration = requestAborted.Register(Dispose);
        lock (_notificationGate)
        {
            if (_disposed || _notificationStarted)
            {
                registration.Unregister();
            }
            else
            {
                _requestAborted = registration;
            }
        }
    }

    internal void NotifyInvalidated()
    {
        lock (_notificationGate)
        {
            if (_notificationStarted)
            {
                return;
            }
            _notificationStarted = true;
            _timer?.Dispose();
            _requestAborted.Unregister();
        }
        // No projection or notification lock is held while invoking arbitrary subscribers.
        try
        {
            _invalidated.Cancel();
        }
        catch (AggregateException)
        {
            // One subscriber must not prevent other invalidations or fail an authority Apply.
        }
        finally
        {
            lock (_notificationGate)
            {
                _notificationComplete = true;
                if (_disposed)
                {
                    _invalidated.Dispose();
                }
            }
        }
    }

    internal Task PublishReadAsync<T>(
        DbConnection connection,
        Func<DbConnection, DbTransaction, CancellationToken, Task<T>> read,
        Func<T, CancellationToken, Task> publish,
        CancellationToken cancellationToken = default)
        => AdminRequestSqlFence.PublishReadAsync(this, connection, read, publish, cancellationToken);

    internal Task VerifyAndFenceAsync(
        DbConnection connection,
        DbTransaction transaction,
        CancellationToken cancellationToken = default)
        => AdminRequestSqlFence.VerifyAndFenceAsync(this, connection, transaction, cancellationToken);

    internal AdminRequestBinding RequireBinding() => _owner.RequireRequestBinding(this);

    public void Dispose()
    {
        _owner.ReleaseRequest(this);
        NotifyInvalidated();
        lock (_notificationGate)
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            _timer?.Dispose();
            _requestAborted.Unregister();
            if (_notificationComplete)
            {
                _invalidated.Dispose();
            }
        }
    }
}

// Never serialized or logged. Token hash stays private to server SQL verification.
internal sealed record AdminRequestBinding(
    string SessionId,
    long PrincipalId,
    byte[] TokenHash,
    long SessionVersion,
    long PrincipalVersion,
    long Generation,
    DateTimeOffset IdleExpiresAtUtc,
    DateTimeOffset AbsoluteExpiresAtUtc,
    DateTimeOffset DeadlineUtc);
