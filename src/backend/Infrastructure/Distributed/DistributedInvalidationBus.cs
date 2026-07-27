using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Infrastructure.Distributed;

public sealed class DistributedInvalidationBus(
    IDistributedInvalidationTransport transport,
    IDistributedInvalidationLocalApplier localApplier,
    DistributedInvalidationEventFactory eventFactory,
    DistributedInvalidationOptions options,
    DistributedInvalidationRuntimeState runtimeState,
    CacheInvalidationRuntimeState cacheRuntimeState,
    ILogger<DistributedInvalidationBus> logger) : BackgroundService, IDistributedInvalidationPublisher
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);
    private readonly DistributedInvalidationDeduplicator _deduplicator = new(options.DedupeCapacity);

    internal DistributedInvalidationRuntimeSnapshot RuntimeSnapshotForTests()
        => runtimeState.Snapshot();

    internal CacheInvalidationRuntimeSnapshot CacheRuntimeSnapshotForTests()
        => cacheRuntimeState.Snapshot();

    public async Task<DistributedInvalidationPublishResult> PublishAsync(
        DistributedInvalidationRequest request,
        CancellationToken cancellationToken = default)
    {
        DistributedInvalidationEvent invalidation = eventFactory.Create(request);
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
                return new DistributedInvalidationPublishResult(
                    DistributedInvalidationPublishStatus.Degraded,
                    invalidation.EventId,
                    detail);
            }
            runtimeState.RecordPublished(invalidation, receipt);
            logger.LogInformation(
                "distributed-invalidation-published {EventId} {Kind} {SourceNodeId} {TraceId}",
                invalidation.EventId,
                invalidation.Kind,
                invalidation.SourceNodeId,
                invalidation.TraceId);
            return new DistributedInvalidationPublishResult(
                DistributedInvalidationPublishStatus.Published,
                invalidation.EventId,
                null);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            string detail = $"publish:{ex.GetType().Name};event:{invalidation.EventId};trace:{invalidation.TraceId}";
            runtimeState.RecordDegraded(invalidation, detail);
            cacheRuntimeState.Record("distributed_degraded", detail);
            logger.LogWarning(
                ex,
                "distributed-invalidation-degraded {EventId} {Kind} {SourceNodeId} {TraceId}",
                invalidation.EventId,
                invalidation.Kind,
                invalidation.SourceNodeId,
                invalidation.TraceId);
            return new DistributedInvalidationPublishResult(
                DistributedInvalidationPublishStatus.Degraded,
                invalidation.EventId,
                detail);
        }
    }

    private static string CreatePublishDetail(
        DistributedInvalidationTransportPublishResult receipt,
        DistributedInvalidationEvent invalidation)
        => $"publish:{receipt.TransportStatus};reason:{receipt.FailureReason ?? "under-delivered"};channel:{receipt.Channel};count:{receipt.SubscriberCount?.ToString() ?? "null"};expected:{receipt.ExpectedMinimumSubscribers};topology:{receipt.TopologyDigest};event:{invalidation.EventId};trace:{invalidation.TraceId}";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
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
        if (!_deduplicator.TryBegin(invalidation.ReplayIdentity))
        {
            runtimeState.RecordDuplicate(invalidation);
            return;
        }

        for (int attempt = 1; attempt <= options.ApplyRetryCount; attempt++)
        {
            try
            {
                await localApplier.ApplyAsync(invalidation, cancellationToken).ConfigureAwait(false);
                runtimeState.RecordApplied(invalidation);
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
                _deduplicator.Abandon(invalidation.ReplayIdentity);
                throw;
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
                _deduplicator.Abandon(invalidation.ReplayIdentity);
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
}
