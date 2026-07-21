using FsusBlog.Server.Infrastructure.Data;
using System.Data.Common;

using FsusBlog.Server.Infrastructure.Cache;

using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public readonly record struct PasskeyProjectionConsistencyReport(
    int DriftedAccounts,
    int RepairedAccounts,
    int RemainingDriftedAccounts)
{
    public bool IsConsistent => RemainingDriftedAccounts == 0;
}

public interface IPasskeyProjectionConsistencyService
{
    Task<PasskeyProjectionConsistencyReport> CheckAsync(CancellationToken cancellationToken = default);

    Task<PasskeyProjectionConsistencyReport> RepairAsync(CancellationToken cancellationToken = default);

    Task EnsureAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// Treats the physical credential set as the authority and keeps
/// <c>sys_user.passkey_enabled</c> as a rebuildable performance projection.
/// </summary>
public sealed class PasskeyProjectionConsistencyService(
    ISqlSugarClient db,
    ICacheCounterStore counters,
    ILogger<PasskeyProjectionConsistencyService> logger) : IPasskeyProjectionConsistencyService
{
    private const string DriftCountSql =
        """
        SELECT COUNT(1)
        FROM sys_user AS u
        WHERE u.passkey_enabled IS DISTINCT FROM EXISTS (
            SELECT 1
            FROM passkey_credential AS pc
            WHERE pc.account_id = u.id
        );
        """;

    public async Task<PasskeyProjectionConsistencyReport> CheckAsync(
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int driftedAccounts = await CountDriftedAccountsAsync(cancellationToken).ConfigureAwait(false);
        if (driftedAccounts > 0)
        {
            logger.LogWarning(
                "PasskeyEnabled projection drift detected. DriftedAccountCount={DriftedAccountCount} Reason={Reason}",
                driftedAccounts,
                "credential_fact_mismatch");
        }

        return new PasskeyProjectionConsistencyReport(
            driftedAccounts,
            RepairedAccounts: 0,
            RemainingDriftedAccounts: driftedAccounts);
    }

    public async Task<PasskeyProjectionConsistencyReport> RepairAsync(
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int initialDrift = await CountDriftedAccountsAsync(cancellationToken).ConfigureAwait(false);
        if (initialDrift == 0)
        {
            return new PasskeyProjectionConsistencyReport(0, 0, 0);
        }

        var repairedAccountIds = new List<int>(initialDrift);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                UPDATE sys_user AS u
                SET passkey_enabled = EXISTS (
                    SELECT 1
                    FROM passkey_credential AS pc
                    WHERE pc.account_id = u.id
                )
                WHERE u.passkey_enabled IS DISTINCT FROM EXISTS (
                    SELECT 1
                    FROM passkey_credential AS pc
                    WHERE pc.account_id = u.id
                )
                RETURNING u.id;
                """))
            {
                while (await reader.ReadAsync(cancellationToken))
                {
                    repairedAccountIds.Add(reader.ReadInt32("id"));
                }
            }

            foreach (int accountId in repairedAccountIds)
            {
                await AccountSnapshotCacheInvalidator.BumpVersionAsync(
                    counters,
                    accountId,
                    cancellationToken).ConfigureAwait(false);
            }

            int remaining = await CountDriftedAccountsAsync(cancellationToken).ConfigureAwait(false);
            if (remaining != 0)
            {
                throw new InvalidOperationException("passkey_projection_repair_incomplete");
            }
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("passkey_projection_repair_failed", transaction.ErrorException);
        }

        logger.LogInformation(
            "PasskeyEnabled projection repair completed. DriftedAccountCount={DriftedAccountCount} RepairedAccountCount={RepairedAccountCount} Reason={Reason}",
            initialDrift,
            repairedAccountIds.Count,
            "credential_fact_rebuild");
        return new PasskeyProjectionConsistencyReport(
            initialDrift,
            repairedAccountIds.Count,
            RemainingDriftedAccounts: 0);
    }

    public async Task EnsureAsync(CancellationToken cancellationToken = default)
    {
        PasskeyProjectionConsistencyReport report = await CheckAsync(cancellationToken).ConfigureAwait(false);
        if (!report.IsConsistent)
        {
            throw new InvalidOperationException(
                $"passkey_projection_inconsistent:{report.RemainingDriftedAccounts}");
        }
    }

    private async Task<int> CountDriftedAccountsAsync(CancellationToken cancellationToken)
    {
        int count = await db.Ado.GetIntAsync(DriftCountSql).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return count;
    }
}
