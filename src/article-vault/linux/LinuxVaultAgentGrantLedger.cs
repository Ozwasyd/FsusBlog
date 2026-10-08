using System.Runtime.Versioning;
using System.Security.Cryptography;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>Holds one short-lived opaque secret; string diagnostics are always redacted.</summary>
public sealed class LinuxVaultAgentGrant : IDisposable
{
    private byte[]? _secret;

    internal LinuxVaultAgentGrant(byte[] secret)
    {
        _secret = secret;
    }

    public byte[] CopySecret()
        => _secret?.ToArray() ?? throw new ObjectDisposedException(nameof(LinuxVaultAgentGrant));

    public override string ToString() => "ArticleVaultAgentGrant[redacted]";

    public void Dispose()
    {
        if (_secret is not null)
        {
            CryptographicOperations.ZeroMemory(_secret);
            _secret = null;
        }
    }
}

/// <summary>
/// Owns bounded grant/replay state for one actual native lease. It is not a business dispatcher;
/// referenced plans, batches and instructions still require their canonical owner's admission.
/// </summary>
[SupportedOSPlatform("linux")]
public sealed class LinuxVaultAgentGrantLedger : IDisposable
{
    private const int MaximumRequests = 4096;
    private readonly object _gate = new();
    private readonly LinuxVaultWriterLeaseScope _lease;
    private readonly Dictionary<ArticleVaultAgentCommand, GrantRecord> _grants = new();
    private readonly HashSet<string> _requests = new(StringComparer.Ordinal);
    private bool _revoked;

    public LinuxVaultAgentGrantLedger(LinuxVaultWriterLeaseScope lease)
    {
        ArgumentNullException.ThrowIfNull(lease);
        _lease = lease;
    }

    internal bool UsesLease(LinuxVaultWriterLeaseScope lease) => ReferenceEquals(_lease, lease);

    /// <summary>Rotates only this purpose; grants never outlive the current lease or 30 seconds.</summary>
    public LinuxVaultAgentGrant Issue(ArticleVaultAgentCommand purpose, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_revoked, this);
            if (!Enum.IsDefined(purpose))
            {
                throw new InvalidDataException("agent_grant_purpose_invalid");
            }

            _lease.RequireCurrent(cancellationToken);
            byte[] secret = RandomNumberGenerator.GetBytes(32);
            Remove(purpose);
            _grants.Add(purpose, new(SHA256.HashData(secret), _lease.Receipt.Binding,
                _lease.Receipt.Generation, Math.Min(_lease.Receipt.DeadlineUnixMilliseconds,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30000)));
            return new(secret);
        }
    }

    // Only the native endpoint can call this after it verifies actual peer/endpoint facts.
    internal void Admit(
        ArticleVaultAgentRequest request,
        ReadOnlySpan<byte> secret,
        CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_revoked, this);
            _lease.RequireCurrent(cancellationToken);
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (!ArticleVaultAgentRequestCodec.Verify(request) || request.Binding != _lease.Receipt.Binding
                || request.LeaseGeneration != _lease.Receipt.Generation
                || request.LeaseReceiptSha256 != _lease.Receipt.ContentSha256
                || request.DeadlineUnixMilliseconds <= now || request.DeadlineUnixMilliseconds > _lease.Receipt.DeadlineUnixMilliseconds
                || secret.Length != 32 || !_grants.TryGetValue(request.Command, out GrantRecord? grant)
                || grant.Binding != request.Binding || grant.Generation != request.LeaseGeneration
                || now >= grant.DeadlineUnixMilliseconds)
            {
                throw new InvalidDataException("agent_grant_or_binding_invalid");
            }

            byte[] digest = SHA256.HashData(secret);
            try
            {
                if (!CryptographicOperations.FixedTimeEquals(digest, grant.SecretDigest))
                {
                    throw new InvalidDataException("agent_grant_or_binding_invalid");
                }
            }
            finally
            {
                CryptographicOperations.ZeroMemory(digest);
            }

            if (_requests.Count >= MaximumRequests || !_requests.Add(request.RequestIdentity))
            {
                // No eviction: it could permit a previously seen command to execute again.
                throw new InvalidDataException("agent_request_duplicate_or_budget_exceeded");
            }
        }
    }

    /// <summary>Logout/site switch/unlink must call this before stopping owned work.</summary>
    public void Revoke(CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            Dispose();
            _lease.Revoke(cancellationToken);
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _revoked = true;
            foreach (ArticleVaultAgentCommand purpose in _grants.Keys.ToArray())
            {
                Remove(purpose);
            }
        }
    }

    private void Remove(ArticleVaultAgentCommand purpose)
    {
        if (_grants.Remove(purpose, out GrantRecord? previous))
        {
            CryptographicOperations.ZeroMemory(previous.SecretDigest);
        }
    }

    private sealed record GrantRecord(
        byte[] SecretDigest,
        ArticleVaultAgentBinding Binding,
        long Generation,
        long DeadlineUnixMilliseconds);
}
