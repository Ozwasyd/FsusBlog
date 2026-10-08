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
    private readonly LinuxVaultAgentLifecycleJournal _journal;
    private readonly ArticleVaultAgentDispatchScope? _dispatch;
    private readonly CancellationTokenSource _registrationLifetime = new();
    private readonly HashSet<string> _pendingRegistrations = new(StringComparer.Ordinal);
    private int _activeRegistrations;
    private TaskCompletionSource? _registrationsDrained;
    private bool _revocationRequested;
    private Task<ArticleVaultAgentLifecycleReceipt>? _shutdown;
    private ArticleVaultAgentShutdownIntent? _shutdownIntent;

    private LinuxVaultAgentControlSession(
        LinuxVaultWriterLeaseScope lease,
        LinuxVaultAgentGrantLedger grants,
        LinuxVaultLocalIpcEndpoint endpoint,
        LinuxVaultAgentLifecycleJournal journal,
        IArticleVaultAgentCanonicalOperations? operations)
    {
        _lease = lease;
        _grants = grants;
        _endpoint = endpoint;
        _journal = journal;
        _dispatch = operations is null ? null
            : new(lease.Receipt.Binding, lease.RootManifestSha256, operations, TimeProvider.System);
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Receipt = ArticleVaultAgentLifecycle.Initial(lease.Receipt.Binding, ArticleVaultAgentPlatform.Linux, now);
        Receipt = ArticleVaultAgentLifecycle.Reduce(Receipt, ArticleVaultAgentLifecycleFact.RequestStart,
            Receipt.ContentSha256, now);
        // Prior unfinished pointers survive restart. Persisted lifecycle states do not recreate
        // native/trust/rescan admission or automatically resume an operation.
        _journal.Append(Receipt, _journal.Tip?.Operations ?? [], CancellationToken.None);
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
        => Open(ownedLease, null, cancellationToken);

    public static LinuxVaultAgentControlSession Open(
        LinuxVaultWriterLeaseScope ownedLease,
        IArticleVaultAgentCanonicalOperations? canonicalOperations,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(ownedLease);
        var grants = new LinuxVaultAgentGrantLedger(ownedLease);
        LinuxVaultLocalIpcEndpoint? endpoint = null;
        LinuxVaultAgentLifecycleJournal? journal = null;
        try
        {
            ownedLease.RequireCurrent(cancellationToken);
            journal = new(ownedLease, cancellationToken);
            endpoint = LinuxVaultLocalIpcEndpoint.Open(ownedLease, grants, cancellationToken);
            return new(ownedLease, grants, endpoint, journal, canonicalOperations);
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
                journal?.Dispose();
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

    public ArticleVaultAgentLifecycleInventoryReceipt InspectInventory()
    {
        lock (_gate)
        {
            return ArticleVaultAgentLifecycleInventory.Decode(ArticleVaultAgentProtocol.Encode(_journal.Tip!));
        }
    }

    public async Task RegisterOperationAsync(
        ArticleVaultAgentOperationReference reference,
        string executeRequestIdentity,
        string cancellationIdentity,
        CancellationToken cancellationToken)
    {
        if (!ArticleVaultAgentOperationInventory.IsReference(reference))
        {
            throw new InvalidDataException("agent_operation_reference_invalid");
        }

        ArticleVaultAgentDispatchScope dispatch;
        CancellationTokenSource registration;
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_shutdown is not null, this);
            _lease.RequireCurrent(cancellationToken);
            dispatch = _dispatch ?? throw new InvalidDataException("agent_canonical_operation_handler_missing");
            if (_journal.Tip!.Operations.Count >= ArticleVaultAgentLifecycleInventory.MaximumOperations
                && !_journal.Tip.Operations.Any(item => item.Identity.OperationIdentity == reference.Identity.OperationIdentity))
            {
                throw new InvalidDataException("agent_lifecycle_inventory_operation_budget_exceeded");
            }

            if (_pendingRegistrations.Count >= ArticleVaultAgentLifecycleInventory.MaximumOperations
                || !_pendingRegistrations.Add(reference.Identity.OperationIdentity))
            {
                throw new InvalidDataException("agent_operation_registration_pending_or_budget");
            }

            registration = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _registrationLifetime.Token);
            if (_activeRegistrations++ == 0)
            {
                _registrationsDrained = new(TaskCreationOptions.RunContinuationsAsynchronously);
            }
        }

        try
        {
            await dispatch.RegisterOperationAsync(reference, executeRequestIdentity, cancellationIdentity, registration.Token)
                .ConfigureAwait(false);
            lock (_gate)
            {
                ObjectDisposedException.ThrowIf(_shutdown is not null, this);
                _lease.RequireCurrent(registration.Token);
                ArticleVaultAgentOperationReference[] inventory = _journal.Tip!.Operations
                    .Where(item => item.Identity.OperationIdentity != reference.Identity.OperationIdentity).Append(reference).ToArray();
                try
                {
                    _journal.Append(Receipt, inventory, registration.Token);
                }
                catch
                {
                    // No registered command is usable until its recovery pointer is durable.
                    try
                    {
                        _grants.Revoke(CancellationToken.None);
                    }
                    finally
                    {
                        dispatch.Dispose();
                    }

                    throw new InvalidDataException("agent_operation_inventory_persistence_failed");
                }
            }
        }
        finally
        {
            registration.Dispose();
            lock (_gate)
            {
                _pendingRegistrations.Remove(reference.Identity.OperationIdentity);
                if (--_activeRegistrations == 0)
                {
                    _registrationsDrained!.TrySetResult();
                }
            }
        }
    }

    public ArticleVaultAgentReference RegisterPlannerInput(ArticleVaultPlanRequest input, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_shutdown is not null, this);
            _lease.RequireCurrent(cancellationToken);
            return (_dispatch ?? throw new InvalidDataException("agent_canonical_operation_handler_missing"))
                .RegisterPlannerInput(input);
        }
    }

    /// <summary>Provides a grant for the closed handler; transition-blocked commands stay blocked.</summary>
    public LinuxVaultAgentGrant CreateCommandGrant(ArticleVaultAgentCommand command, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_shutdown is not null, this);
            if (_dispatch is null && command is not (ArticleVaultAgentCommand.InspectStatus or ArticleVaultAgentCommand.Revoke))
            {
                throw new InvalidDataException("agent_canonical_operation_handler_missing");
            }

            return _grants.Issue(command, cancellationToken);
        }
    }

    /// <summary>
    /// Handles one admitted peer and sends its bound receipt. Revoke is acknowledged before
    /// endpoint draining; only actual completed shutdown produces the lifecycle terminal receipt.
    /// </summary>
    public async Task<ArticleVaultAgentRequest> ServeNextAsync(CancellationToken cancellationToken)
    {
        try
        {
            return await _endpoint.DispatchRequestAsync(DispatchAsync, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            ArticleVaultAgentShutdownIntent? intent;
            lock (_gate)
            {
                intent = _revocationRequested ? _shutdownIntent ?? ArticleVaultAgentShutdownIntent.Stop : null;
            }

            if (intent is not null)
            {
                await ShutdownAsync(intent.Value).ConfigureAwait(false);
            }
        }
    }

    private async Task<ArticleVaultAgentCommandReceipt> DispatchAsync(
        ArticleVaultAgentRequest request, int size, CancellationToken cancellationToken)
    {
        ArticleVaultAgentDispatchScope? dispatch;
        ArticleVaultAgentLifecycleReceipt lifecycle;
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_shutdown is not null, this);
            _lease.RequireCurrent(cancellationToken);
            if (_pendingRegistrations.Count > 0 && request.Command is not (ArticleVaultAgentCommand.InspectStatus or ArticleVaultAgentCommand.Revoke))
            {
                return ArticleVaultAgentCommandReceipts.Create(request, size,
                    ArticleVaultAgentCommandStatus.Blocked, "agent_operation_registration_not_durable");
            }

            if (request.Command == ArticleVaultAgentCommand.Revoke)
            {
                _revocationRequested = true;
                _grants.Revoke(cancellationToken);
                _dispatch?.Dispose();
                return ArticleVaultAgentCommandReceipts.Create(request, size,
                    ArticleVaultAgentCommandStatus.Admitted, "agent_revoke_requested");
            }

            dispatch = _dispatch;
            lifecycle = Receipt;
            if (dispatch is null)
            {
                return ArticleVaultAgentCommandReceipts.Create(request, size,
                    request.Command == ArticleVaultAgentCommand.InspectStatus
                        ? ArticleVaultAgentCommandStatus.Completed : ArticleVaultAgentCommandStatus.Blocked,
                    request.Command == ArticleVaultAgentCommand.InspectStatus ? null : "agent_canonical_operation_handler_missing",
                    request.Command == ArticleVaultAgentCommand.InspectStatus ? Receipt.ContentSha256 : null);
            }
        }

        ArticleVaultAgentCommandReceipt result = await dispatch.DispatchAsync(request, size, lifecycle, cancellationToken)
            .ConfigureAwait(false);
        if (request.Command == ArticleVaultAgentCommand.Cancel)
        {
            lock (_gate)
            {
                IReadOnlyList<ArticleVaultAgentOperationReference> current = dispatch.InspectOperationReferences();
                if (current.Any(reference => !_journal.Tip!.Operations.Any(old =>
                    old.Identity.OperationIdentity == reference.Identity.OperationIdentity
                    && old.CheckpointSequence == reference.CheckpointSequence
                    && old.CheckpointSha256 == reference.CheckpointSha256)))
                {
                    ArticleVaultAgentOperationReference[] inventory = _journal.Tip!.Operations
                        .Where(old => !current.Any(reference => reference.Identity.OperationIdentity == old.Identity.OperationIdentity))
                        .Concat(current).ToArray();
                    try
                    {
                        // The held journal survives lease revocation until admitted peers drain.
                        // Persist the canonical pointer before the endpoint can send its receipt.
                        _journal.Append(Receipt, inventory, CancellationToken.None);
                    }
                    catch
                    {
                        _revocationRequested = true;
                        try
                        {
                            _grants.Revoke(CancellationToken.None);
                        }
                        finally
                        {
                            dispatch.Dispose();
                        }

                        return ArticleVaultAgentCommandReceipts.Create(request, size,
                            ArticleVaultAgentCommandStatus.Blocked, "agent_operation_inventory_persistence_failed",
                            result.CanonicalResultSha256);
                    }
                }
            }
        }

        return result;
    }

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
            _dispatch?.Dispose();
        }
        catch (Exception exception)
        {
            if (failure is null)
            {
                failure = exception;
                failureReason = "owned_control_dispatch_cancel_failed";
            }
        }

        try
        {
            _registrationLifetime.Cancel();
        }
        catch (Exception exception)
        {
            if (failure is null)
            {
                failure = exception;
                failureReason = "owned_control_registration_cancel_failed";
            }
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
            Task registrations;
            lock (_gate)
            {
                registrations = _activeRegistrations == 0 ? Task.CompletedTask : _registrationsDrained!.Task;
            }

            await registrations.ConfigureAwait(false);
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
                RecordBlocked(failureReason!);
                try
                {
                    _journal.Append(Receipt, _journal.Tip!.Operations, CancellationToken.None);
                }
                catch
                {
                    failureReason = "owned_control_failure_inventory_unavailable";
                    RecordBlocked(failureReason);
                }
                finally
                {
                    _journal.Dispose();
                    _registrationLifetime.Dispose();
                }
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
        try
        {
            Step(ArticleVaultAgentLifecycleFact.OwnedResourcesStopped, cleanupSha256);
            if (intent == ArticleVaultAgentShutdownIntent.Unlink)
            {
                Step(ArticleVaultAgentLifecycleFact.RequestUnlink);
                Step(ArticleVaultAgentLifecycleFact.ControlStateRetained, cleanupSha256);
            }
        }
        catch
        {
            lock (_gate)
            {
                RecordBlocked("owned_control_terminal_inventory_failed");
            }

            throw new InvalidDataException("owned_control_terminal_inventory_failed");
        }
        finally
        {
            _journal.Dispose();
            _registrationLifetime.Dispose();
        }

        return InspectStatus();
    }

    private void Step(ArticleVaultAgentLifecycleFact fact, string? producerReceiptSha256 = null)
    {
        lock (_gate)
        {
            ArticleVaultAgentLifecycleReceipt next = ArticleVaultAgentLifecycle.Reduce(Receipt, fact, Receipt.ContentSha256,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), producerReceiptSha256);
            _journal.Append(next, _journal.Tip!.Operations, CancellationToken.None);
            Receipt = next;
        }
    }

    private void RecordBlocked(string reason)
    {
        ArticleVaultAgentLifecycleReceipt previous = _journal.Tip?.Lifecycle ?? Receipt;
        ArticleVaultAgentLifecycleReceipt next = previous with
        {
            PreviousState = previous.NewState,
            NewState = ArticleVaultAgentLifecycleState.Stopping,
            Sequence = previous.Sequence + 1,
            PreviousReceiptSha256 = previous.ContentSha256,
            ObservedUnixMilliseconds = Math.Max(previous.ObservedUnixMilliseconds, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
            RescanRequired = true,
            ReasonCode = reason,
            ContentSha256 = string.Empty
        };
        Receipt = next with
        {
            ContentSha256 = ArticleVaultAgentProtocol.Digest(next)
        };
    }
}
