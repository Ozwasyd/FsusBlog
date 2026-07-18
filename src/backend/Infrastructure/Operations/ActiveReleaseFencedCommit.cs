using System.Data.Common;
using System.Diagnostics.Metrics;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;

using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed record ActiveReleaseFencedCommitReceipt(
    string CommitToken,
    string OperationScope,
    string MutationKey,
    long Generation,
    DateTimeOffset EnlistedAtUtc);

public interface IActiveReleaseTransactionalCommitGuard
{
    Task<ActiveReleaseFencedCommitReceipt> EnlistAsync(
        ISqlSugarClient db,
        string operationScope,
        string mutationKey,
        CancellationToken cancellationToken = default);

    Task<ActiveReleaseFencedCommitReceipt> EnlistAsync(
        ISqlSugarClient db,
        ActiveReleaseExecutionTicket ticket,
        string operationScope,
        string mutationKey,
        CancellationToken cancellationToken = default);
}

internal static class ActiveReleaseFencedCommitSql
{
    internal const string AdvisoryLock = "SELECT pg_advisory_xact_lock_shared(1179862354);";

    internal const string Enlist = """
        WITH matching_fence AS MATERIALIZED (
            SELECT release_id,
                   slot,
                   generation,
                   image_digest
            FROM sys_deployment_fence
            WHERE id = 1
              AND status = 'active'
              AND release_id = @ReleaseId
              AND slot = @Slot
              AND generation = @Generation
              AND image_digest = @ImageDigest
            FOR SHARE
        ), persisted_token AS (
            INSERT INTO sys_fenced_commit (
                commit_token,
                operation_scope,
                mutation_key,
                release_id,
                slot,
                generation,
                image_digest,
                process_instance_id,
                enlisted_at_utc)
            SELECT @CommitToken,
                   @OperationScope,
                   @MutationKey,
                   release_id,
                   slot,
                   generation,
                   image_digest,
                   @ProcessInstanceId,
                   clock_timestamp() AT TIME ZONE 'utc'
            FROM matching_fence
            RETURNING commit_token, generation, enlisted_at_utc
        )
        SELECT commit_token, generation, enlisted_at_utc
        FROM persisted_token;
        """;

    internal const string Audit = """
        SELECT committed.commit_token,
               committed.operation_scope,
               committed.mutation_key,
               committed.release_id,
               committed.slot,
               committed.generation,
               committed.enlisted_at_utc
        FROM sys_fenced_commit AS committed
        CROSS JOIN sys_deployment_fence AS fence
        WHERE committed.enlisted_at_utc >= @CutoffUtc
          AND fence.id = 1
          AND (
              committed.generation > fence.generation
              OR (
                  committed.generation = fence.generation
                  AND (
                      committed.release_id <> fence.release_id
                      OR committed.slot <> fence.slot
                      OR committed.image_digest <> fence.image_digest
                      OR (
                          fence.status = 'revoked'
                          AND committed.enlisted_at_utc >= COALESCE(fence.revoked_at_utc, fence.updated_at_utc)
                      )
                  )
              )
              OR (
                  committed.generation < fence.generation
                  AND committed.enlisted_at_utc >= COALESCE(fence.activated_at_utc, fence.updated_at_utc)
              )
          )
        ORDER BY committed.enlisted_at_utc DESC, committed.commit_token
        LIMIT @BatchSize;
        """;
}

public sealed class ActiveReleaseTransactionalCommitGuard(
    IActiveReleaseExecutionContextAccessor executionContext,
    IConfiguration configuration,
    IHostEnvironment environment) : IActiveReleaseTransactionalCommitGuard
{
    public Task<ActiveReleaseFencedCommitReceipt> EnlistAsync(
        ISqlSugarClient db,
        string operationScope,
        string mutationKey,
        CancellationToken cancellationToken = default)
    {
        ActiveReleaseExecutionTicket ticket = executionContext.Current
            ?? throw new InvalidOperationException(
                "No active release execution ticket is present for this fenced database transaction.");
        return EnlistAsync(db, ticket, operationScope, mutationKey, cancellationToken);
    }

    public async Task<ActiveReleaseFencedCommitReceipt> EnlistAsync(
        ISqlSugarClient db,
        ActiveReleaseExecutionTicket ticket,
        string operationScope,
        string mutationKey,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(ticket);
        string normalizedScope = NormalizeRequired(operationScope, 96, nameof(operationScope));
        string normalizedMutationKey = NormalizeRequired(mutationKey, 192, nameof(mutationKey));
        if (!configuration.GetValue("ActiveReleaseFencedCommit:MutationEnabled", true))
        {
            ActiveReleaseFencedCommitMetrics.RecordEnlist("paused", normalizedScope);
            throw new ActiveReleaseFencedCommitPausedException(normalizedScope);
        }
        if (db.Ado.Transaction is null)
        {
            throw new InvalidOperationException(
                "The active release transactional commit guard must run inside the business PostgreSQL transaction.");
        }

        if (environment.IsDevelopment()
            && configuration.GetValue(ActiveReleaseFenceAvailabilityPolicy.AllowSyntheticLocalFenceKey, false)
            && string.Equals(ticket.ReleaseId, "local-unversioned", StringComparison.Ordinal)
            && string.Equals(ticket.Slot, "local", StringComparison.Ordinal))
        {
            ActiveReleaseFencedCommitMetrics.RecordEnlist("synthetic-local", normalizedScope);
            return new ActiveReleaseFencedCommitReceipt(
                Guid.NewGuid().ToString("N"),
                normalizedScope,
                normalizedMutationKey,
                ticket.Generation,
                DateTimeOffset.UtcNow);
        }

        cancellationToken.ThrowIfCancellationRequested();
        string commitToken = Guid.NewGuid().ToString("N");
        await db.Ado.ExecuteCommandAsync(ActiveReleaseFencedCommitSql.AdvisoryLock).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            ActiveReleaseFencedCommitSql.Enlist,
            new SugarParameter[]
            {
                new("@ReleaseId", ticket.ReleaseId),
                new("@Slot", ticket.Slot),
                new("@Generation", ticket.Generation),
                new("@ImageDigest", ticket.ImageDigest),
                new("@CommitToken", commitToken),
                new("@OperationScope", normalizedScope),
                new("@MutationKey", normalizedMutationKey),
                new("@ProcessInstanceId", NormalizeRequired(ticket.ProcessInstanceId, 192, nameof(ticket)))
            }).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            ActiveReleaseFencedCommitMetrics.RecordEnlist("rejected", normalizedScope);
            throw new ActiveReleaseFenceLostException(ticket.ReleaseId, ticket.Slot, ticket.Generation);
        }

        var receipt = new ActiveReleaseFencedCommitReceipt(
            reader.GetString(0),
            normalizedScope,
            normalizedMutationKey,
            reader.GetInt64(1),
            ReadTimestamp(reader, 2));
        ActiveReleaseFencedCommitMetrics.RecordEnlist("accepted", normalizedScope);
        return receipt;
    }

    private static string NormalizeRequired(string value, int maximumLength, string parameterName)
    {
        string normalized = value?.Trim() ?? string.Empty;
        if (normalized.Length == 0 || normalized.Length > maximumLength)
        {
            throw new ArgumentException(
                $"Value must contain 1..{maximumLength} characters.",
                parameterName);
        }
        return normalized;
    }

    private static DateTimeOffset ReadTimestamp(DbDataReader reader, int ordinal)
        => new(DateTime.SpecifyKind(reader.GetDateTime(ordinal), DateTimeKind.Utc));
}

public sealed class ActiveReleaseFencedCommitPausedException(string operationScope)
    : InvalidOperationException(
        $"Active release fenced database mutations are paused for operation scope '{operationScope}'.");

public static class ActiveReleaseFencedTransaction
{
    public static async Task<T> ExecuteAsync<T>(
        ISqlSugarClient db,
        IActiveReleaseTransactionalCommitGuard commitGuard,
        string operationScope,
        string mutationKey,
        Func<CancellationToken, Task<T>> mutation,
        CancellationToken cancellationToken = default,
        Func<T, bool>? shouldEnlist = null)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(commitGuard);
        ArgumentNullException.ThrowIfNull(mutation);
        T? result = default;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            result = await mutation(cancellationToken).ConfigureAwait(false);
            if (shouldEnlist is null || shouldEnlist(result!))
            {
                await commitGuard.EnlistAsync(
                    db,
                    operationScope,
                    mutationKey,
                    cancellationToken).ConfigureAwait(false);
            }
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            throw transaction.ErrorException
                ?? new InvalidOperationException("Active release fenced database transaction failed.");
        }
        return result!;
    }
}

public sealed class ActiveReleaseFencedCommitAuditWorker(
    IServiceScopeFactory scopeFactory,
    IConfiguration configuration,
    TimeProvider timeProvider,
    IBackgroundWorkerLease workerLease,
    IActiveReleaseCommitGuard activeReleaseCommitGuard,
    ILogger<ActiveReleaseFencedCommitAuditWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (configuration.GetValue("ActiveReleaseFencedCommitAudit:Enabled", true))
                {
                    await workerLease.TryRunAsLeaderAsync(
                        "active-release-fenced-commit-audit",
                        async auditToken =>
                        {
                            await activeReleaseCommitGuard.EnsureCurrentAsync(auditToken).ConfigureAwait(false);
                            await AuditRecentCommitsAsync(auditToken).ConfigureAwait(false);
                        },
                        stoppingToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                ActiveReleaseFencedCommitMetrics.RecordAudit("failed", 0);
                logger.LogError(ex, "active-release-fenced-commit-audit-failed");
            }

            await Task.Delay(AuditInterval(), timeProvider, stoppingToken).ConfigureAwait(false);
        }
    }

    internal async Task<int> AuditRecentCommitsAsync(CancellationToken cancellationToken)
    {
        await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        DateTime cutoffUtc = timeProvider.GetUtcNow().UtcDateTime.Subtract(RecentWindow());
        int batchSize = Math.Clamp(
            configuration.GetValue("ActiveReleaseFencedCommitAudit:BatchSize", 100),
            1,
            1000);
        var violations = new List<ActiveReleaseFencedCommitViolation>();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            ActiveReleaseFencedCommitSql.Audit,
            new SugarParameter[]
            {
                new("@CutoffUtc", cutoffUtc),
                new("@BatchSize", batchSize)
            }).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            violations.Add(new ActiveReleaseFencedCommitViolation(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.GetString(4),
                reader.GetInt64(5),
                new DateTimeOffset(DateTime.SpecifyKind(reader.GetDateTime(6), DateTimeKind.Utc))));
        }

        if (violations.Count == 0)
        {
            ActiveReleaseFencedCommitMetrics.RecordAudit("clean", 0);
            return 0;
        }

        foreach (ActiveReleaseFencedCommitViolation violation in violations)
        {
            logger.LogCritical(
                "active-release-fenced-commit-violation token={CommitToken} scope={OperationScope} mutation={MutationKey} release={ReleaseId} slot={Slot} generation={Generation} enlistedAt={EnlistedAtUtc}",
                violation.CommitToken,
                violation.OperationScope,
                violation.MutationKey,
                violation.ReleaseId,
                violation.Slot,
                violation.Generation,
                violation.EnlistedAtUtc);
        }
        ActiveReleaseFencedCommitMetrics.RecordAudit("violation", violations.Count);
        return violations.Count;
    }

    private TimeSpan AuditInterval()
        => TimeSpan.FromSeconds(Math.Clamp(
            configuration.GetValue("ActiveReleaseFencedCommitAudit:IntervalSeconds", 30),
            5,
            300));

    private TimeSpan RecentWindow()
        => TimeSpan.FromMinutes(Math.Clamp(
            configuration.GetValue("ActiveReleaseFencedCommitAudit:RecentWindowMinutes", 10),
            1,
            1440));

    private sealed record ActiveReleaseFencedCommitViolation(
        string CommitToken,
        string OperationScope,
        string MutationKey,
        string ReleaseId,
        string Slot,
        long Generation,
        DateTimeOffset EnlistedAtUtc);
}

internal static class ActiveReleaseFencedCommitMetricNames
{
    internal const string Enlistments = "fsus.active_release_fenced_commit.enlistments";
    internal const string Audits = "fsus.active_release_fenced_commit.audits";
    internal const string Violations = "fsus.active_release_fenced_commit.violations";
}

public static class ActiveReleaseFencedCommitMetrics
{
    private static readonly Meter s_meter = new(FsusObservability.MeterName, "1.0.0");
    private static readonly Counter<long> s_enlistments = s_meter.CreateCounter<long>(
        ActiveReleaseFencedCommitMetricNames.Enlistments);
    private static readonly Counter<long> s_audits = s_meter.CreateCounter<long>(
        ActiveReleaseFencedCommitMetricNames.Audits);
    private static readonly Counter<long> s_violations = s_meter.CreateCounter<long>(
        ActiveReleaseFencedCommitMetricNames.Violations);

    public static void RecordEnlist(string result, string operationScope)
        => s_enlistments.Add(1, new("result", result), new("operation_scope", operationScope));

    public static void RecordAudit(string result, int violations)
    {
        s_audits.Add(
            1,
            new KeyValuePair<string, object?>[]
            {
                new("result", result)
            });
        if (violations > 0)
        {
            s_violations.Add(
                violations,
                new KeyValuePair<string, object?>[]
                {
                    new("result", result)
                });
        }
    }
}
