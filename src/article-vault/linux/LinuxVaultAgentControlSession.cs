using System.Runtime.Versioning;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>
/// Owns the actual lease/grant/IPC control resources transferred to this session. It exposes read-only
/// status and terminal revocation, not a signed installer, update transport or normal-observation host.
/// </summary>
[SupportedOSPlatform("linux")]
public sealed class LinuxVaultAgentControlSession : IAsyncDisposable
{
    private readonly object _gate = new();
    private readonly LinuxVaultWriterLeaseScope _lease;
    private readonly LinuxVaultAgentGrantLedger _grants;
    private readonly LinuxVaultLocalIpcEndpoint _endpoint;
    private Task<ArticleVaultAgentLifecycleReceipt>? _shutdown;
    private ArticleVaultAgentShutdownIntent? _shutdownIntent;

    private LinuxVaultAgentControlSession(
        LinuxVaultWriterLeaseScope lease,
        LinuxVaultAgentGrantLedger grants,
        LinuxVaultLocalIpcEndpoint endpoint)
    {
        _lease = lease;
        _grants = grants;
        _endpoint = endpoint;
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Receipt = ArticleVaultAgentLifecycle.Initial(lease.Receipt.Binding, ArticleVaultAgentPlatform.Linux, now);
        Receipt = ArticleVaultAgentLifecycle.Reduce(Receipt, ArticleVaultAgentLifecycleFact.RequestStart,
            Receipt.ContentSha256, now);
    }

    /// <summary>The control session stays starting/rescan-required; no source grants running status.</summary>
    public ArticleVaultAgentLifecycleReceipt Receipt
    {
        get; private set;
    }

    /// <summary>
    /// Transfers an actual native lease into this session, including failure cleanup. The caller
    /// must have stopped any previous owned work; this creates no process, watcher or binary install.
    /// </summary>
    public static LinuxVaultAgentControlSession Open(
        LinuxVaultWriterLeaseScope ownedLease,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(ownedLease);
        var grants = new LinuxVaultAgentGrantLedger(ownedLease);
        LinuxVaultLocalIpcEndpoint? endpoint = null;
        try
        {
            ownedLease.RequireCurrent(cancellationToken);
            endpoint = LinuxVaultLocalIpcEndpoint.Open(ownedLease, grants, cancellationToken);
            return new(ownedLease, grants, endpoint);
        }
        catch
        {
            grants.Dispose();
            try
            {
                endpoint?.Dispose();
            }
            finally
            {
                ownedLease.Dispose();
            }

            throw;
        }
    }

    public ArticleVaultAgentLifecycleReceipt InspectStatus()
    {
        lock (_gate)
        {
            return Receipt;
        }
    }

    /// <summary>Issues only status grants; normal observation and execution remain unavailable.</summary>
    public LinuxVaultAgentGrant CreateStatusGrant(CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_shutdown is not null, this);
            return _grants.Issue(ArticleVaultAgentCommand.InspectStatus, cancellationToken);
        }
    }

    public Task<ArticleVaultAgentRequest> ReadStatusRequestAsync(CancellationToken cancellationToken)
        => _endpoint.ReadRequestAsync(cancellationToken);

    /// <summary>
    /// Revokes grants and lease before draining owned IPC. Unlink retains control/audit state;
    /// none of these intents delete Markdown, server articles, caches or another run's files.
    /// </summary>
    public Task<ArticleVaultAgentLifecycleReceipt> ShutdownAsync(ArticleVaultAgentShutdownIntent intent)
    {
        lock (_gate)
        {
            if (!Enum.IsDefined(intent) || (_shutdownIntent is not null && _shutdownIntent != intent))
            {
                throw new InvalidDataException("agent_lifecycle_shutdown_intent_invalid");
            }

            _shutdownIntent = intent;
            _shutdown ??= ShutdownCoreAsync(intent);
            return _shutdown;
        }
    }

    public async ValueTask DisposeAsync()
    {
        ArticleVaultAgentShutdownIntent intent;
        lock (_gate)
        {
            intent = _shutdownIntent ?? ArticleVaultAgentShutdownIntent.Stop;
        }

        await ShutdownAsync(intent).ConfigureAwait(false);
    }

    private async Task<ArticleVaultAgentLifecycleReceipt> ShutdownCoreAsync(ArticleVaultAgentShutdownIntent intent)
    {
        Exception? failure = null;
        string? failureReason = null;
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try
        {
            _grants.Revoke(cancellation.Token);
        }
        catch (Exception exception)
        {
            failure = exception;
            failureReason = "owned_control_grant_revoke_failed";
        }

        try
        {
            Step(ArticleVaultAgentLifecycleFact.RequestStop);
        }
        catch (Exception exception)
        {
            if (failure is null)
            {
                failure = exception;
                failureReason = "owned_control_stop_receipt_failed";
            }
        }

        try
        {
            await _endpoint.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            if (failure is null)
            {
                failure = exception;
                failureReason = "owned_control_endpoint_close_failed";
            }
        }

        try
        {
            _lease.Dispose();
        }
        catch (Exception exception)
        {
            if (failure is null)
            {
                failure = exception;
                failureReason = "owned_control_lease_close_failed";
            }
        }

        if (failure is not null)
        {
            // Keep the stopping state and a fixed reason; do not leak input-bearing exceptions
            // into lifecycle telemetry or turn partial cleanup into a completed terminal receipt.
            lock (_gate)
            {
                ArticleVaultAgentLifecycleReceipt blocked = Receipt with
                {
                    ReasonCode = failureReason,
                    ContentSha256 = string.Empty
                };
                Receipt = blocked with
                {
                    ContentSha256 = ArticleVaultAgentProtocol.Digest(blocked)
                };
            }

            throw new InvalidDataException(failureReason);
        }

        string cleanupSha256 = ArticleVaultAgentProtocol.Digest(new
        {
            Scope = "local-control-resources",
            Intent = intent,
            Binding = _lease.Receipt.Binding,
            LeaseReceiptSha256 = _lease.Receipt.ContentSha256
        });
        Step(ArticleVaultAgentLifecycleFact.OwnedResourcesStopped, cleanupSha256);
        if (intent == ArticleVaultAgentShutdownIntent.Unlink)
        {
            Step(ArticleVaultAgentLifecycleFact.RequestUnlink);
            Step(ArticleVaultAgentLifecycleFact.ControlStateRetained, cleanupSha256);
        }

        return InspectStatus();
    }

    private void Step(ArticleVaultAgentLifecycleFact fact, string? producerReceiptSha256 = null)
    {
        lock (_gate)
        {
            Receipt = ArticleVaultAgentLifecycle.Reduce(Receipt, fact, Receipt.ContentSha256,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), producerReceiptSha256);
        }
    }
}
