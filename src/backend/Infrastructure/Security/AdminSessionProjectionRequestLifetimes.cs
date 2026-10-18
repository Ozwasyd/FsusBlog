using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Security;

public sealed partial class AdminSessionProjection
{
    // Separate fixed registration budget; active entries are never evicted for admission.
    internal const int MaxRequestLifetimes = 4096;
    internal static readonly TimeSpan MaxRequestLifetime = TimeSpan.FromMinutes(2);
    private readonly Dictionary<AdminAuthenticatedRequestLifetime, RequestRegistration> _requests = [];
    private readonly ConcurrentQueue<AdminAuthenticatedRequestLifetime> _pendingInvalidations = new();

    internal int ActiveRequestLifetimeCount
    {
        get
        {
            using (EnterGate())
            {
                return _requests.Count;
            }
        }
    }

    internal AdminSessionProjectionValidationResult ValidateForRequest(
        string sessionId,
        long principalId,
        ReadOnlySpan<byte> accessTokenHash,
        out AdminAuthenticatedRequestLifetime? lifetime)
    {
        using (EnterGate())
        {
            lifetime = null;
            AdminSessionProjectionValidationResult result = Validate(sessionId, principalId, accessTokenHash);
            if (!result.IsValid)
            {
                return result;
            }
            InvalidateChangedRequestsLocked();
            if (_requests.Count >= MaxRequestLifetimes)
            {
                return AdminSessionProjectionValidationResult.Invalid("admin_request_lifetime_capacity");
            }

            SessionEntry session = _sessions[sessionId];
            PrincipalEntry principal = _principals[principalId];
            DateTimeOffset now = _timeProvider.GetUtcNow();
            DateTimeOffset deadline = new[]
            {
                session.IdleExpiresAtUtc, session.AbsoluteExpiresAtUtc, now + MaxRequestLifetime
            }.Min();
            var binding = new AdminRequestBinding(sessionId, principalId, session.AccessTokenHash,
                session.Version, principal.Version, Math.Max(session.Generation, principal.Generation),
                session.IdleExpiresAtUtc, session.AbsoluteExpiresAtUtc, deadline);
            // A fresh random domain salt prevents the digest becoming a reusable identity oracle.
            string digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
                $"admin-request-v1:{Guid.NewGuid():N}:{sessionId}:{principalId}:{binding.SessionVersion}:{binding.PrincipalVersion}:{binding.Generation}")));
            lifetime = new AdminAuthenticatedRequestLifetime(this, digest);
            _requests.Add(lifetime, new RequestRegistration(binding, session, principal));
            AdminAuthenticatedRequestLifetime registered = lifetime;
            ITimer timer = _timeProvider.CreateTimer(_ => ReleaseRequest(registered), null,
                Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
            lifetime.SetTimer(timer);
            timer.Change(deadline - now, Timeout.InfiniteTimeSpan);
            return result;
        }
    }

    internal bool IsRequestCurrent(AdminAuthenticatedRequestLifetime lifetime)
    {
        using (EnterGate())
        {
            InvalidateChangedRequestsLocked();
            return _requests.ContainsKey(lifetime);
        }
    }

    internal AdminRequestBinding RequireRequestBinding(AdminAuthenticatedRequestLifetime lifetime)
    {
        using (EnterGate())
        {
            InvalidateChangedRequestsLocked();
            if (!_requests.TryGetValue(lifetime, out RequestRegistration? registration))
            {
                throw new OperationCanceledException("Admin request lifetime is no longer current.");
            }
            return registration.Binding;
        }
    }

    internal void ReleaseRequest(AdminAuthenticatedRequestLifetime lifetime)
    {
        using (EnterGate())
        {
            if (_requests.Remove(lifetime))
            {
                _pendingInvalidations.Enqueue(lifetime);
            }
        }
    }

    private void InvalidateChangedRequestsLocked()
    {
        DateTimeOffset now = _timeProvider.GetUtcNow();
        foreach ((AdminAuthenticatedRequestLifetime lifetime, RequestRegistration registration) in _requests.ToArray())
        {
            AdminRequestBinding binding = registration.Binding;
            if (!_ready || now >= binding.DeadlineUtc
                || !_sessions.TryGetValue(binding.SessionId, out SessionEntry? session)
                || !ReferenceEquals(session, registration.Session)
                || !_principals.TryGetValue(binding.PrincipalId, out PrincipalEntry? principal)
                || !ReferenceEquals(principal, registration.Principal))
            {
                _requests.Remove(lifetime);
                _pendingInvalidations.Enqueue(lifetime);
            }
        }
    }

    private GateScope EnterGate() => new(this);

    private readonly struct GateScope : IDisposable
    {
        private readonly AdminSessionProjection _owner;

        internal GateScope(AdminSessionProjection owner)
        {
            _owner = owner;
            Monitor.Enter(owner._gate);
        }

        public void Dispose()
        {
            try
            {
                _owner.InvalidateChangedRequestsLocked();
            }
            finally
            {
                Monitor.Exit(_owner._gate);
            }
            // ValidateForRequest calls Validate reentrantly; only the outer scope may notify.
            if (!Monitor.IsEntered(_owner._gate))
            {
                while (_owner._pendingInvalidations.TryDequeue(out AdminAuthenticatedRequestLifetime? lifetime))
                {
                    lifetime.NotifyInvalidated();
                }
            }
        }
    }

    private sealed record RequestRegistration(AdminRequestBinding Binding, SessionEntry Session, PrincipalEntry Principal);
}
