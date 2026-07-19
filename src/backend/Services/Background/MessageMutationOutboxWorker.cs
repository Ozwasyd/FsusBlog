using System.Data.Common;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;

using SqlSugar;

namespace FsusBlog.Server.Services.Background;

public sealed record MessageMutationOutboxRuntimeSnapshot(
    int BacklogCount,
    int FailedCount,
    int PoisonCount,
    int StuckClaimCount,
    long ProcessedCount,
    DateTime? LastCompletedAt,
    string? LastError);

public sealed class MessageMutationOutboxRuntimeState
{
    private readonly object _gate = new();
    private MessageMutationOutboxRuntimeSnapshot _snapshot = new(0, 0, 0, 0, 0, null, null);

    public MessageMutationOutboxRuntimeSnapshot CreateSnapshot()
    {
        lock (_gate)
        {
            return _snapshot;
        }
    }

    internal void Update(int backlog, int failed, int poison, int stuck, int processedDelta, DateTime now, string? lastError)
    {
        lock (_gate)
        {
            _snapshot = new MessageMutationOutboxRuntimeSnapshot(
                backlog,
                failed,
                poison,
                stuck,
                _snapshot.ProcessedCount + processedDelta,
                processedDelta > 0 ? now : _snapshot.LastCompletedAt,
                lastError);
        }
    }
}

public sealed class MessageMutationOutboxWorker(
    IServiceScopeFactory scopeFactory,
    IBackgroundWorkerLease workerLease,
    TimeProvider timeProvider,
    MessageMutationOutboxRuntimeState runtimeState,
    IConfiguration configuration,
    ILogger<MessageMutationOutboxWorker> logger) : BackgroundService
{
    private const int BatchSize = 64;
    private const int PoisonThreshold = 10;
    private static readonly string s_workerId = BuildWorkerId();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await workerLease.TryRunAsLeaderAsync(
                "message-mutation-outbox-worker",
                ProcessPendingAsync,
                stoppingToken).ConfigureAwait(false);
            try
            {
                await Task.Delay(GetPollInterval(), timeProvider, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    internal async Task<int> ProcessPendingAsync(CancellationToken cancellationToken)
    {
        if (configuration.GetValue<bool?>("MessageMutationOutbox:Enabled") == false)
        {
            return 0;
        }

        await using var scope = scopeFactory.CreateAsyncScope();
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        IMessageMutationOutboxDelivery deliveryService = scope.ServiceProvider.GetRequiredService<IMessageMutationOutboxDelivery>();
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        string claimToken = Guid.NewGuid().ToString("N");
        List<MessageMutationOutbox> claimed = await ClaimAsync(
            db,
            now,
            now.Add(GetClaimLease()),
            claimToken,
            cancellationToken).ConfigureAwait(false);
        int processed = 0;
        int failed = 0;
        string? lastError = null;
        for (int i = 0; i < claimed.Count; i++)
        {
            MessageMutationOutbox item = claimed[i];
            try
            {
                await deliveryService.DeliverAsync(item, cancellationToken).ConfigureAwait(false);
                int completed = await db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE message_mutation_outbox
                    SET status = @Processed,
                        processedat = @ProcessedAt,
                        claimtoken = NULL,
                        claimedby = NULL,
                        claimedat = NULL,
                        leaseexpiresat = NULL,
                        lasterror = NULL
                    WHERE id = @Id
                      AND status = @Processing
                      AND claimtoken = @ClaimToken;
                    """,
                    new SugarParameter("@Processed", MessageMutationOutboxStatus.Processed),
                    new SugarParameter("@ProcessedAt", timeProvider.GetUtcNow().UtcDateTime),
                    new SugarParameter("@Id", item.Id),
                    new SugarParameter("@Processing", MessageMutationOutboxStatus.Processing),
                    new SugarParameter("@ClaimToken", claimToken));
                if (completed != 1)
                {
                    throw new InvalidOperationException($"Message outbox claim lost: {item.Id}");
                }
                processed++;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                failed++;
                lastError = NormalizeError(ex.Message);
                await MarkRetryAsync(db, item, claimToken, lastError, cancellationToken).ConfigureAwait(false);
                logger.LogWarning(ex, "message-mutation-outbox-delivery-failed {OutboxId} {DeliveryKey}", item.Id, item.DeliveryKey);
            }
        }

        await UpdateRuntimeStateAsync(db, processed, lastError, cancellationToken).ConfigureAwait(false);
        FsusObservability.RecordMessageOutboxBatch(claimed.Count, processed, failed);
        return processed;
    }

    private async Task MarkRetryAsync(
        ISqlSugarClient db,
        MessageMutationOutbox item,
        string claimToken,
        string error,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int attemptCount = item.AttemptCount + 1;
        string status = attemptCount >= PoisonThreshold
            ? MessageMutationOutboxStatus.Poison
            : MessageMutationOutboxStatus.Pending;
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE message_mutation_outbox
            SET status = @Status,
                attemptcount = @AttemptCount,
                nextattemptat = @NextAttemptAt,
                claimtoken = NULL,
                claimedby = NULL,
                claimedat = NULL,
                leaseexpiresat = NULL,
                lasterror = @LastError
            WHERE id = @Id
              AND status = @Processing
              AND claimtoken = @ClaimToken;
            """,
            new SugarParameter("@Status", status),
            new SugarParameter("@AttemptCount", attemptCount),
            new SugarParameter("@NextAttemptAt", now.Add(ComputeBackoff(attemptCount))),
            new SugarParameter("@LastError", error),
            new SugarParameter("@Id", item.Id),
            new SugarParameter("@Processing", MessageMutationOutboxStatus.Processing),
            new SugarParameter("@ClaimToken", claimToken));
    }

    private async Task UpdateRuntimeStateAsync(
        ISqlSugarClient db,
        int processed,
        string? lastError,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'processing'))::integer AS backlog,
                   COUNT(*) FILTER (WHERE attemptcount > 0 AND status <> 'processed')::integer AS failed,
                   COUNT(*) FILTER (WHERE status = 'poison')::integer AS poison,
                   COUNT(*) FILTER (WHERE status = 'processing' AND leaseexpiresat <= @Now)::integer AS stuck
            FROM message_mutation_outbox;
            """,
            new SugarParameter("@Now", now));
        int backlog = 0;
        int failed = 0;
        int poison = 0;
        int stuck = 0;
        if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            backlog = reader.ReadInt32("backlog");
            failed = reader.ReadInt32("failed");
            poison = reader.ReadInt32("poison");
            stuck = reader.ReadInt32("stuck");
        }
        runtimeState.Update(backlog, failed, poison, stuck, processed, now, lastError);
        FsusObservability.RecordMessageOutboxState(backlog, failed, poison, stuck);
    }

    private static async Task<List<MessageMutationOutbox>> ClaimAsync(
        ISqlSugarClient db,
        DateTime now,
        DateTime leaseExpiresAt,
        string claimToken,
        CancellationToken cancellationToken)
    {
        var claimed = new List<MessageMutationOutbox>(BatchSize);
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH candidates AS (
                SELECT id
                FROM message_mutation_outbox
                WHERE (status = @Pending AND nextattemptat <= @Now)
                   OR (status = @Processing AND leaseexpiresat <= @Now)
                ORDER BY id
                LIMIT @BatchSize
                FOR UPDATE SKIP LOCKED
            )
            UPDATE message_mutation_outbox outbox
            SET status = @Processing,
                claimtoken = @ClaimToken,
                claimedby = @ClaimedBy,
                claimedat = @Now,
                leaseexpiresat = @LeaseExpiresAt,
                nextattemptat = @LeaseExpiresAt
            FROM candidates
            WHERE outbox.id = candidates.id
            RETURNING outbox.id, outbox.deliverykey, outbox.eventkind, outbox.audiencekind,
                      outbox.targetaccountid, outbox.conversationid, outbox.messageid,
                      outbox.readthroughmessageid, outbox.status, outbox.attemptcount,
                      outbox.nextattemptat, outbox.claimtoken, outbox.claimedby,
                      outbox.claimedat, outbox.leaseexpiresat, outbox.lasterror,
                      outbox.createdat, outbox.processedat;
            """,
            new SugarParameter[]
            {
                new("@Pending", MessageMutationOutboxStatus.Pending),
                new("@Processing", MessageMutationOutboxStatus.Processing),
                new("@Now", now),
                new("@BatchSize", BatchSize),
                new("@ClaimToken", claimToken),
                new("@ClaimedBy", s_workerId),
                new("@LeaseExpiresAt", leaseExpiresAt)
            });
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            claimed.Add(new MessageMutationOutbox
            {
                Id = reader.ReadInt64("id"),
                DeliveryKey = reader.ReadString("deliverykey"),
                EventKind = reader.ReadString("eventkind"),
                AudienceKind = reader.ReadString("audiencekind"),
                TargetAccountId = reader.IsNull("targetaccountid") ? null : reader.ReadInt32("targetaccountid"),
                ConversationId = reader.ReadInt64("conversationid"),
                MessageId = reader.IsNull("messageid") ? null : reader.ReadInt64("messageid"),
                ReadThroughMessageId = reader.IsNull("readthroughmessageid") ? null : reader.ReadInt64("readthroughmessageid"),
                Status = reader.ReadString("status"),
                AttemptCount = reader.ReadInt32("attemptcount"),
                NextAttemptAt = reader.ReadDateTime("nextattemptat"),
                ClaimToken = reader.ReadString("claimtoken"),
                ClaimedBy = reader.ReadString("claimedby"),
                ClaimedAt = reader.ReadDateTime("claimedat"),
                LeaseExpiresAt = reader.ReadDateTime("leaseexpiresat"),
                LastError = reader.IsNull("lasterror") ? null : reader.ReadString("lasterror"),
                CreatedAt = reader.ReadDateTime("createdat"),
                ProcessedAt = reader.IsNull("processedat") ? null : reader.ReadDateTime("processedat")
            });
        }
        return claimed;
    }

    private TimeSpan GetPollInterval()
    {
        int milliseconds = configuration.GetValue<int?>("MessageMutationOutbox:PollIntervalMs") ?? 1000;
        return TimeSpan.FromMilliseconds(Math.Clamp(milliseconds, 100, 30_000));
    }

    private TimeSpan GetClaimLease()
    {
        int seconds = configuration.GetValue<int?>("MessageMutationOutbox:ClaimLeaseSeconds") ?? 60;
        return TimeSpan.FromSeconds(Math.Clamp(seconds, 10, 600));
    }

    private static TimeSpan ComputeBackoff(int attemptCount)
        => TimeSpan.FromSeconds(Math.Min(300, Math.Pow(2, Math.Clamp(attemptCount, 0, 8))));

    private static string NormalizeError(string error)
    {
        string normalized = string.IsNullOrWhiteSpace(error) ? "message delivery failed" : error.Trim();
        return normalized.Length <= 1024 ? normalized : normalized[..1024];
    }

    private static string BuildWorkerId()
    {
        string value = string.Concat(Environment.MachineName, ":", Environment.ProcessId.ToString());
        return value.Length <= 128 ? value : value[..128];
    }
}
