using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;

using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Infrastructure.Distributed;

public sealed class DistributedInvalidationBus(
    IDistributedInvalidationTransport transport,
    IDistributedInvalidationLocalApplier localApplier,
    DistributedInvalidationEventFactory eventFactory,
    DistributedInvalidationOptions options,
    DistributedInvalidationRuntimeState runtimeState,
    CacheInvalidationRuntimeState cacheRuntimeState,
    ILogger<DistributedInvalidationBus> logger,
    IServiceScopeFactory? scopeFactory = null) : BackgroundService, IDistributedInvalidationPublisher
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    internal DistributedInvalidationRuntimeSnapshot RuntimeSnapshotForTests()
        => runtimeState.Snapshot();

    internal CacheInvalidationRuntimeSnapshot CacheRuntimeSnapshotForTests()
        => cacheRuntimeState.Snapshot();

    public async Task<DistributedInvalidationPublishResult> PublishAsync(
        DistributedInvalidationRequest request,
        CancellationToken cancellationToken = default)
    {
        DistributedInvalidationEvent invalidation = eventFactory.Create(request);
        await WithLedgerAsync(ledger => ledger.PrepareOutboxAsync(
            invalidation,
            options.Topology ?? throw new InvalidOperationException("distributed_invalidation_topology_required"),
            cancellationToken)).ConfigureAwait(false);
        try
        {
            string payload = JsonSerializer.Serialize(invalidation, s_jsonOptions);
            DistributedInvalidationTransportPublishResult receipt = await transport
                .PublishAsync(payload, cancellationToken)
                .ConfigureAwait(false);
            if (receipt.TransportStatus != DistributedInvalidationTransportStatus.Delivered)
            {
                string detail = CreatePublishDetail(receipt, invalidation);
                runtimeState.RecordDegraded(invalidation, detail, receipt);
                cacheRuntimeState.Record("distributed_degraded", detail);
                logger.LogWarning(
                    "distributed-invalidation-under-delivered {EventId} {Kind} {SourceNodeId} {TraceId} {Channel} {SubscriberCount} {ExpectedMinimumSubscribers} {TopologyDigest} {TransportStatus}",
                    invalidation.EventId,
                    invalidation.Kind,
                    invalidation.SourceNodeId,
                    invalidation.TraceId,
                    receipt.Channel,
                    receipt.SubscriberCount,
                    receipt.ExpectedMinimumSubscribers,
                    receipt.TopologyDigest,
                    receipt.TransportStatus);
                var degradedResult = new DistributedInvalidationPublishResult(
                    DistributedInvalidationPublishStatus.Degraded,
                    invalidation.EventId,
                    detail,
                    invalidation,
                    receipt);
                await RecordPublishAttemptAsync(degradedResult, cancellationToken).ConfigureAwait(false);
                return degradedResult;
            }
            runtimeState.RecordPublished(invalidation, receipt);
            logger.LogInformation(
                "distributed-invalidation-published {EventId} {Kind} {SourceNodeId} {TraceId}",
                invalidation.EventId,
                invalidation.Kind,
                invalidation.SourceNodeId,
                invalidation.TraceId);
            var result = new DistributedInvalidationPublishResult(
                DistributedInvalidationPublishStatus.Published,
                invalidation.EventId,
                null,
                invalidation,
                receipt);
            await RecordPublishAttemptAsync(result, cancellationToken).ConfigureAwait(false);
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            DistributedInvalidationTopologyManifest topology = options.Topology
                ?? throw new InvalidOperationException("distributed_invalidation_topology_required", ex);
            DistributedInvalidationTransportPublishResult receipt = DistributedInvalidationTransportPublishResult.Failed(
                options.Channel,
                topology,
                publisherNodeSubscribed: true,
                timeProvider: TimeProvider.System,
                reason: ex.GetType().Name);
            string detail = $"publish:{ex.GetType().Name};event:{invalidation.EventId};trace:{invalidation.TraceId}";
            runtimeState.RecordDegraded(invalidation, detail, receipt);
            cacheRuntimeState.Record("distributed_degraded", detail);
            logger.LogWarning(
                ex,
                "distributed-invalidation-degraded {EventId} {Kind} {SourceNodeId} {TraceId}",
                invalidation.EventId,
                invalidation.Kind,
                invalidation.SourceNodeId,
                invalidation.TraceId);
            var result = new DistributedInvalidationPublishResult(
                DistributedInvalidationPublishStatus.Degraded,
                invalidation.EventId,
                detail,
                invalidation,
                receipt);
            await RecordPublishAttemptAsync(result, cancellationToken).ConfigureAwait(false);
            return result;
        }
    }

    private static string CreatePublishDetail(
        DistributedInvalidationTransportPublishResult receipt,
        DistributedInvalidationEvent invalidation)
        => $"publish:{receipt.TransportStatus};reason:{receipt.FailureReason ?? "under-delivered"};channel:{receipt.Channel};count:{receipt.SubscriberCount?.ToString() ?? "null"};expected:{receipt.ExpectedMinimumSubscribers};topology:{receipt.TopologyDigest};event:{invalidation.EventId};trace:{invalidation.TraceId}";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Task subscription = RunSubscriptionLoopAsync(stoppingToken);
        Task recovery = RunRecoveryLoopAsync(stoppingToken);
        await Task.WhenAll(subscription, recovery).ConfigureAwait(false);
    }

    private async Task RunSubscriptionLoopAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await foreach (string payload in transport.ReadAllAsync(stoppingToken).ConfigureAwait(false))
                {
                    await HandlePayloadAsync(payload, stoppingToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                string detail = $"subscribe:{ex.GetType().Name}";
                runtimeState.RecordDegraded(null, detail);
                cacheRuntimeState.Record("distributed_degraded", detail);
                logger.LogWarning(ex, "distributed-invalidation-subscription-degraded");
                await Task.Delay(options.ApplyRetryDelay, stoppingToken).ConfigureAwait(false);
            }
        }
    }

    private async Task RunRecoveryLoopAsync(CancellationToken stoppingToken)
    {
        bool recoveredInterrupted = false;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!recoveredInterrupted)
                {
                    await WithLedgerAsync(ledger => ledger.RecoverInterruptedAsync(
                        eventFactory.RuntimeScope,
                        options.NodeId,
                        stoppingToken)).ConfigureAwait(false);
                    recoveredInterrupted = true;
                }
                await ReplayPendingAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                string detail = $"ledger-recovery:{ex.GetType().Name}";
                runtimeState.RecordDegraded(null, detail);
                cacheRuntimeState.Record("distributed_degraded", detail);
                logger.LogWarning(ex, "distributed-invalidation-ledger-recovery-degraded");
            }

            try
            {
                await Task.Delay(options.RecoveryReplayInterval, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
        }
    }

    internal async Task HandlePayloadAsync(string payload, CancellationToken cancellationToken)
    {
        DistributedInvalidationEvent? invalidation;
        try
        {
            invalidation = JsonSerializer.Deserialize<DistributedInvalidationEvent>(payload, s_jsonOptions);
            if (invalidation is null)
            {
                throw new InvalidDataException("Distributed invalidation payload is empty.");
            }
            invalidation.Validate();
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException)
        {
            string detail = $"payload:{ex.GetType().Name}";
            runtimeState.RecordDegraded(null, detail);
            cacheRuntimeState.Record("distributed_degraded", detail);
            logger.LogWarning(ex, "distributed-invalidation-payload-rejected");
            return;
        }

        if (string.Equals(invalidation.SourceNodeId, options.NodeId, StringComparison.Ordinal))
        {
            runtimeState.RecordSelfIgnored(invalidation);
            return;
        }
        DistributedInvalidationInboxReceipt receipt;
        try
        {
            receipt = await WithLedgerAsync(ledger => ledger.ReceiveAsync(
                invalidation,
                options.NodeId,
                cancellationToken)).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            string detail = $"inbox:{ex.GetType().Name};event:{invalidation.EventId};trace:{invalidation.TraceId}";
            runtimeState.RecordDegraded(invalidation, detail);
            cacheRuntimeState.Record("distributed_degraded", detail);
            logger.LogWarning(ex, "distributed-invalidation-inbox-degraded {EventId}", invalidation.EventId);
            return;
        }
        if (receipt.IsPayloadMismatch || receipt.IsTerminal)
        {
            string detail = receipt.IsPayloadMismatch
                ? $"inbox:payload-digest-mismatch;event:{invalidation.EventId};trace:{invalidation.TraceId}"
                : $"inbox:terminal;event:{invalidation.EventId};trace:{invalidation.TraceId}";
            runtimeState.RecordDegraded(invalidation, detail);
            cacheRuntimeState.Record("distributed_degraded", detail);
            return;
        }
        if (receipt.IsAppliedDuplicate)
        {
            runtimeState.RecordDuplicate(invalidation);
            return;
        }
        if (!await WithLedgerAsync(ledger => ledger.TryBeginApplyAsync(
                invalidation,
                options.NodeId,
                cancellationToken)).ConfigureAwait(false))
        {
            runtimeState.RecordDuplicate(invalidation);
            return;
        }
        runtimeState.RecordReceived(invalidation);

        for (int attempt = 1; attempt <= options.ApplyRetryCount; attempt++)
        {
            try
            {
                DistributedInvalidationLocalApplyResult? result = await localApplier
                    .ApplyAsync(invalidation, cancellationToken)
                    .ConfigureAwait(false);
                if (result is null)
                {
                    throw new InvalidOperationException("distributed_invalidation_local_apply_result_not_applied");
                }
                if (result.HasCompletedLocalInvalidation)
                {
                    runtimeState.RecordLocalInvalidated(invalidation, result);
                }
                if (result.HasRebuildObligation)
                {
                    runtimeState.RecordRebuildObligated(invalidation, result);
                }
                if (result.LocalApplyStatus == DistributedInvalidationLocalApplyStatus.FailedTerminal)
                {
                    throw new DistributedInvalidationLocalApplyTerminalException();
                }
                if (!result.IsApplied)
                {
                    throw new InvalidOperationException("distributed_invalidation_local_apply_result_not_applied");
                }
                runtimeState.RecordApplied(invalidation);
                await WithLedgerAsync(ledger => ledger.RecordApplyAsync(
                    invalidation,
                    options.NodeId,
                    DistributedInvalidationInboxApplyState.Applied,
                    null,
                    result.RebuildGeneration,
                    cancellationToken)).ConfigureAwait(false);
                logger.LogInformation(
                    "distributed-invalidation-applied {EventId} {Kind} {SourceNodeId} {TraceId}",
                    invalidation.EventId,
                    invalidation.Kind,
                    invalidation.SourceNodeId,
                    invalidation.TraceId);
                return;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                await RecordInterruptedApplyAsync(invalidation).ConfigureAwait(false);
                throw;
            }
            catch (DistributedInvalidationLocalApplyTerminalException ex)
            {
                await WithLedgerAsync(ledger => ledger.RecordApplyAsync(
                    invalidation,
                    options.NodeId,
                    DistributedInvalidationInboxApplyState.TerminalFailed,
                    ex.GetType().Name,
                    null,
                    CancellationToken.None)).ConfigureAwait(false);
                string detail = $"apply:{ex.GetType().Name};event:{invalidation.EventId};trace:{invalidation.TraceId}";
                runtimeState.RecordDegraded(invalidation, detail);
                cacheRuntimeState.Record("distributed_degraded", detail);
                logger.LogWarning(
                    "distributed-invalidation-apply-terminal {EventId} {Kind} {SourceNodeId} {TraceId}",
                    invalidation.EventId,
                    invalidation.Kind,
                    invalidation.SourceNodeId,
                    invalidation.TraceId);
                return;
            }
            catch (Exception ex) when (attempt < options.ApplyRetryCount)
            {
                logger.LogWarning(
                    ex,
                    "distributed-invalidation-apply-retry {EventId} {Kind} {Attempt} {TraceId}",
                    invalidation.EventId,
                    invalidation.Kind,
                    attempt,
                    invalidation.TraceId);
                await Task.Delay(options.ApplyRetryDelay, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                await WithLedgerAsync(ledger => ledger.RecordApplyAsync(
                    invalidation,
                    options.NodeId,
                    DistributedInvalidationInboxApplyState.RetryableFailed,
                    ex.GetType().Name,
                    null,
                    CancellationToken.None)).ConfigureAwait(false);
                string detail = $"apply:{ex.GetType().Name};event:{invalidation.EventId};trace:{invalidation.TraceId}";
                runtimeState.RecordDegraded(invalidation, detail);
                cacheRuntimeState.Record("distributed_degraded", detail);
                logger.LogWarning(
                    ex,
                    "distributed-invalidation-apply-degraded {EventId} {Kind} {SourceNodeId} {TraceId}",
                    invalidation.EventId,
                    invalidation.Kind,
                    invalidation.SourceNodeId,
                    invalidation.TraceId);
                return;
            }
        }
    }

    private async Task ReplayPendingAsync(CancellationToken cancellationToken)
    {
        IReadOnlyList<DistributedInvalidationEvent> pending = await WithLedgerAsync(
            ledger => ledger.ReadPendingForNodeAsync(
                eventFactory.RuntimeScope,
                options.NodeId,
                cancellationToken)).ConfigureAwait(false);
        foreach (DistributedInvalidationEvent invalidation in pending)
        {
            await HandlePayloadAsync(
                JsonSerializer.Serialize(invalidation, s_jsonOptions),
                cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task RecordInterruptedApplyAsync(DistributedInvalidationEvent invalidation)
    {
        try
        {
            await WithLedgerAsync(ledger => ledger.RecordApplyAsync(
                invalidation,
                options.NodeId,
                DistributedInvalidationInboxApplyState.RetryableFailed,
                "operation-canceled",
                null,
                CancellationToken.None)).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "distributed-invalidation-inbox-cancellation-record-failed {EventId}", invalidation.EventId);
        }
    }

    private async Task WithLedgerAsync(Func<IDistributedInvalidationDeliveryLedger, Task> action)
    {
        if (scopeFactory is null)
        {
            throw new InvalidOperationException("distributed_invalidation_delivery_ledger_missing");
        }
        using IServiceScope scope = scopeFactory.CreateScope();
        await action(scope.ServiceProvider.GetRequiredService<IDistributedInvalidationDeliveryLedger>())
            .ConfigureAwait(false);
    }

    private async Task<T> WithLedgerAsync<T>(Func<IDistributedInvalidationDeliveryLedger, Task<T>> action)
    {
        if (scopeFactory is null)
        {
            throw new InvalidOperationException("distributed_invalidation_delivery_ledger_missing");
        }
        using IServiceScope scope = scopeFactory.CreateScope();
        return await action(scope.ServiceProvider.GetRequiredService<IDistributedInvalidationDeliveryLedger>())
            .ConfigureAwait(false);
    }

    private Task RecordPublishAttemptAsync(
        DistributedInvalidationPublishResult result,
        CancellationToken cancellationToken)
        => WithLedgerAsync(ledger => ledger.RecordPublishAttemptAsync(result, cancellationToken));

    private sealed class DistributedInvalidationLocalApplyTerminalException : Exception
    {
    }
}
