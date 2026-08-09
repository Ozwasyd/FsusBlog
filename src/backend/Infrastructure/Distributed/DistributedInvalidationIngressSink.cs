using System.Text.Json;
using System.Threading.Channels;

using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Infrastructure.Distributed;

/// <summary>
/// Bounded subscriber ingress write flow: parse envelope identity, upsert the
/// durable inbox row (pending), enqueue only the durable inbox reference, and on
/// queue-full establish a durable scope-level full-reconcile obligation. Never
/// executes local apply and never treats the in-memory channel as the only copy.
/// </summary>
public sealed class DistributedInvalidationIngressSink(
    DistributedInvalidationOptions options,
    DistributedInvalidationIngressRuntimeState ingressRuntimeState,
    DistributedInvalidationRuntimeState runtimeState,
    IServiceScopeFactory? scopeFactory)
{
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web);

    public async Task HandlePayloadAsync(
        string payload,
        ChannelWriter<string> writer,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(payload);
        ArgumentNullException.ThrowIfNull(writer);

        DistributedInvalidationEvent? invalidation;
        try
        {
            invalidation = JsonSerializer.Deserialize<DistributedInvalidationEvent>(payload, s_json);
            if (invalidation is null)
            {
                throw new InvalidDataException("Distributed invalidation payload is empty.");
            }
            invalidation.Validate();
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException)
        {
            ingressRuntimeState.RecordDegraded("ingress:payload-invalid");
            return;
        }

        if (string.Equals(invalidation.SourceNodeId, options.NodeId, StringComparison.Ordinal))
        {
            runtimeState.RecordSelfIgnored(invalidation);
            return;
        }

        var reference = new DistributedInvalidationInboxReference(
            invalidation.RuntimeScope,
            invalidation.EventId,
            options.NodeId);
        try
        {
            await WithLedgerAsync(ledger => ledger.ReceiveAsync(
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
            ingressRuntimeState.RecordDegraded($"ingress:inbox:{ex.GetType().Name}");
            return;
        }

        if (writer.TryWrite(reference.ToChannelItem()))
        {
            return;
        }

        ingressRuntimeState.RecordOverflow();
        try
        {
            await WithLedgerAsync(ledger => ledger.RecordFullReconcileObligationAsync(
                invalidation.RuntimeScope,
                options.NodeId,
                "ingress-queue-full",
                cancellationToken)).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            ingressRuntimeState.RecordDegraded($"ingress:overflow-obligation:{ex.GetType().Name}");
        }
    }

    private async Task WithLedgerAsync(Func<IDistributedInvalidationDeliveryLedger, Task> action)
    {
        if (scopeFactory is null)
        {
            throw new InvalidOperationException("distributed_invalidation_ingress_ledger_missing");
        }

        using IServiceScope scope = scopeFactory.CreateScope();
        await action(scope.ServiceProvider.GetRequiredService<IDistributedInvalidationDeliveryLedger>())
            .ConfigureAwait(false);
    }
}
