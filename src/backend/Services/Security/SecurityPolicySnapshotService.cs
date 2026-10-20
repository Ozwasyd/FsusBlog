using System.Data.Common;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Articles;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

using SqlSugar;


namespace FsusBlog.Server.Services.Security;

public static class SecurityPolicyIds
{
    public const string AntiCrawler = "anti-crawler";
    public const string Pow = "pow";
    public const string RiskControl = "risk-control";
    public const string PerceptionSealedV2 = "perception-sealed-v2";
}

public sealed record SecurityPolicySnapshotRecord(
    long Id,
    string PolicyId,
    long Version,
    string Mode,
    long? CreatedByAdminId,
    DateTime CreatedAtUtc,
    DateTime? ActivatedAtUtc,
    DateTime? RevokedAtUtc,
    bool IsLastKnownGood,
    long? RollbackOfVersion,
    string? Reason);

public sealed record SecurityPolicyLoadResult<T>(
    bool Success,
    T? Document,
    SecurityPolicySnapshotRecord? Record,
    bool UsedLastKnownGood,
    string Reason);

public sealed record SecurityPolicyRollbackResult<T>(
    bool Success,
    T? Document,
    SecurityPolicySnapshotRecord? Record,
    string Reason);

public interface ISecurityPolicySnapshotService
{
    Task<SecurityPolicySnapshotRecord> ActivateAsync<T>(
        string policyId,
        string mode,
        T document,
        long? createdByAdminId,
        string? reason,
        CancellationToken cancellationToken = default);

    Task<SecurityPolicyLoadResult<T>> LoadActiveOrLastKnownGoodAsync<T>(
        string policyId,
        CancellationToken cancellationToken = default);

    Task<SecurityPolicyRollbackResult<T>> RollbackAsync<T>(
        string policyId,
        long? targetVersion,
        long? createdByAdminId,
        string? reason,
        CancellationToken cancellationToken = default);
}

public sealed class SecurityPolicySnapshotService(
    ISqlSugarClient db,
    TimeProvider timeProvider,
    IAuditEventService? auditEvents = null) : ISecurityPolicySnapshotService
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<SecurityPolicySnapshotRecord> ActivateAsync<T>(
        string policyId,
        string mode,
        T document,
        long? createdByAdminId,
        string? reason,
        CancellationToken cancellationToken = default)
    {
        string normalizedPolicyId = NormalizePolicyId(policyId);
        string normalizedMode = SecuritySystemModes.Normalize(mode);
        string documentJson = JsonSerializer.Serialize(document, s_jsonOptions);
        string? normalizedReason = TextHelpers.NormalizeNullable(reason, 128);
        DateTime utcNow = timeProvider.GetUtcNow().UtcDateTime;
        SecurityPolicySnapshot? inserted = null;

        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db, cancellationToken).ConfigureAwait(false);
            long nextVersion = await ResolveNextVersionAsync(normalizedPolicyId, cancellationToken);
            await db.Updateable<SecurityPolicySnapshot>()
                .SetColumns(item => item.RevokedAtUtc == utcNow)
                .Where(item => item.PolicyId == normalizedPolicyId && item.ActivatedAtUtc != null && item.RevokedAtUtc == null)
                .ExecuteCommandAsync(cancellationToken);

            inserted = new SecurityPolicySnapshot
            {
                PolicyId = normalizedPolicyId,
                Version = nextVersion,
                Mode = normalizedMode,
                Document = documentJson,
                CreatedByAdminId = createdByAdminId,
                CreatedAtUtc = utcNow,
                ActivatedAtUtc = utcNow,
                RevokedAtUtc = null,
                IsLastKnownGood = true,
                Reason = normalizedReason
            };
            await db.Insertable(inserted).ExecuteCommandAsync(cancellationToken);
            await ArticleSourceGenerationAuthority.RecordPolicySnapshotAsync(db, inserted.PolicyId, inserted.Version, cancellationToken).ConfigureAwait(false);
        });

        if (!transaction.IsSuccess || inserted is null)
        {
            throw new InvalidOperationException("security_policy_snapshot_activate_failed", transaction.ErrorException);
        }

        await RecordAuditAsync(
            AuditActionCatalog.SecurityPolicyActivated,
            "security policy snapshot activated",
            inserted,
            normalizedReason,
            cancellationToken);
        return ToRecord(inserted);
    }

    public async Task<SecurityPolicyLoadResult<T>> LoadActiveOrLastKnownGoodAsync<T>(
        string policyId,
        CancellationToken cancellationToken = default)
    {
        string normalizedPolicyId = NormalizePolicyId(policyId);
        SecurityPolicySnapshot? active = await db.Queryable<SecurityPolicySnapshot>()
            .Where(item => item.PolicyId == normalizedPolicyId && item.ActivatedAtUtc != null && item.RevokedAtUtc == null)
            .OrderBy(item => item.Version, OrderByType.Desc)
            .FirstAsync(cancellationToken);

        if (TryDeserialize(active, out T? activeDocument))
        {
            return new SecurityPolicyLoadResult<T>(true, activeDocument, ToRecord(active!), false, "active");
        }

        SecurityPolicySnapshot? fallback = await db.Queryable<SecurityPolicySnapshot>()
            .Where(item => item.PolicyId == normalizedPolicyId && item.IsLastKnownGood)
            .WhereIF(active is not null, item => item.Version != active!.Version)
            .OrderBy(item => item.Version, OrderByType.Desc)
            .FirstAsync(cancellationToken);
        if (TryDeserialize(fallback, out T? fallbackDocument))
        {
            return new SecurityPolicyLoadResult<T>(true, fallbackDocument, ToRecord(fallback!), true, "last_known_good");
        }

        return new SecurityPolicyLoadResult<T>(false, default, null, active is not null, "security_policy_snapshot_unavailable");
    }

    public async Task<SecurityPolicyRollbackResult<T>> RollbackAsync<T>(
        string policyId,
        long? targetVersion,
        long? createdByAdminId,
        string? reason,
        CancellationToken cancellationToken = default)
    {
        string normalizedPolicyId = NormalizePolicyId(policyId);
        SecurityPolicySnapshot? target = await db.Queryable<SecurityPolicySnapshot>()
            .Where(item => item.PolicyId == normalizedPolicyId)
            .WhereIF(targetVersion.HasValue, item => item.Version == targetVersion!.Value)
            .WhereIF(!targetVersion.HasValue, item => item.IsLastKnownGood && item.RevokedAtUtc != null)
            .OrderBy(item => item.Version, OrderByType.Desc)
            .FirstAsync(cancellationToken);
        if (!TryDeserialize(target, out T? document))
        {
            return new SecurityPolicyRollbackResult<T>(false, default, null, "security_policy_rollback_target_unavailable");
        }

        string? normalizedReason = TextHelpers.NormalizeNullable(reason, 128) ?? "rollback";
        DateTime utcNow = timeProvider.GetUtcNow().UtcDateTime;
        SecurityPolicySnapshot? inserted = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db, cancellationToken).ConfigureAwait(false);
            long nextVersion = await ResolveNextVersionAsync(normalizedPolicyId, cancellationToken);
            await db.Updateable<SecurityPolicySnapshot>()
                .SetColumns(item => item.RevokedAtUtc == utcNow)
                .Where(item => item.PolicyId == normalizedPolicyId && item.ActivatedAtUtc != null && item.RevokedAtUtc == null)
                .ExecuteCommandAsync(cancellationToken);

            inserted = new SecurityPolicySnapshot
            {
                PolicyId = normalizedPolicyId,
                Version = nextVersion,
                Mode = target!.Mode,
                Document = target.Document,
                CreatedByAdminId = createdByAdminId,
                CreatedAtUtc = utcNow,
                ActivatedAtUtc = utcNow,
                IsLastKnownGood = true,
                RollbackOfVersion = target.Version,
                Reason = normalizedReason
            };
            await db.Insertable(inserted).ExecuteCommandAsync(cancellationToken);
            await ArticleSourceGenerationAuthority.RecordPolicySnapshotAsync(db, inserted.PolicyId, inserted.Version, cancellationToken).ConfigureAwait(false);
        });

        if (!transaction.IsSuccess || inserted is null)
        {
            return new SecurityPolicyRollbackResult<T>(false, default, null, "security_policy_rollback_conflict");
        }

        await RecordAuditAsync(
            AuditActionCatalog.SecurityPolicyRolledBack,
            "security policy snapshot rolled back",
            inserted,
            normalizedReason,
            cancellationToken);
        return new SecurityPolicyRollbackResult<T>(true, document, ToRecord(inserted), "rollback");
    }

    private async Task<long?> TryIncrementVersionCounterAsync(string policyId, CancellationToken cancellationToken)
    {
        DateTime utcNow = timeProvider.GetUtcNow().UtcDateTime;
        if (db.CurrentConnectionConfig.DbType == DbType.MySql)
        {
            int mysqlUpdated = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE security_policy_version_counter
                SET last_version = last_version + 1,
                    updated_at_utc = @updatedAtUtc
                WHERE policy_id = @policyId;
                """,
                new SugarParameter[]
                {
                    new("@policyId", policyId),
                    new("@updatedAtUtc", utcNow)
                });
            if (mysqlUpdated != 1)
            {
                return null;
            }

            using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                SELECT last_version
                FROM security_policy_version_counter
                WHERE policy_id = @policyId;
                """,
                new SugarParameter[] { new("@policyId", policyId) });
            return await reader.ReadAsync(cancellationToken) ? reader.ReadInt64("last_version") : null;
        }

        await EnsureVersionCounterAsync(policyId, cancellationToken);

        long lastVersion;
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT last_version
            FROM security_policy_version_counter
            WHERE policy_id = @policyId
            FOR UPDATE;
            """,
            new SugarParameter[] { new("@policyId", policyId) }))
        {
            if (!await reader.ReadAsync(cancellationToken))
            {
                throw new InvalidOperationException("security_policy_version_counter_missing");
            }

            lastVersion = reader.ReadInt64("last_version");
        }

        long nextVersion = checked(lastVersion + 1);
        int updated = await db.Updateable<SecurityPolicyVersionCounter>()
            .SetColumns(item => item.LastVersion == nextVersion)
            .SetColumns(item => item.UpdatedAtUtc == timeProvider.GetUtcNow().UtcDateTime)
            .Where(item => item.PolicyId == policyId && item.LastVersion == lastVersion)
            .ExecuteCommandAsync(cancellationToken);
        if (updated != 1)
        {
            throw new InvalidOperationException("security_policy_version_counter_update_conflict");
        }

        return nextVersion;
    }

    private async Task<long> ResolveNextVersionAsync(string policyId, CancellationToken cancellationToken)
    {
        if (db.CurrentConnectionConfig.DbType == DbType.PostgreSQL)
        {
            async Task<long?> TryIncrementPostgresCounterAsync()
            {
                using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                    """
                    UPDATE security_policy_version_counter
                    SET last_version = last_version + 1,
                        updated_at_utc = @updatedAtUtc
                    WHERE policy_id = @policyId
                    RETURNING last_version;
                    """,
                    new SugarParameter[]
                    {
                        new("@policyId", policyId),
                        new("@updatedAtUtc", timeProvider.GetUtcNow().UtcDateTime)
                    });
                return await reader.ReadAsync(cancellationToken) ? reader.ReadInt64("last_version") : null;
            }

            long? postgresNextVersion = await TryIncrementPostgresCounterAsync();
            if (postgresNextVersion.HasValue)
            {
                return postgresNextVersion.Value;
            }

            await EnsureVersionCounterAsync(policyId, cancellationToken);
            postgresNextVersion = await TryIncrementPostgresCounterAsync();
            if (postgresNextVersion.HasValue)
            {
                return postgresNextVersion.Value;
            }

            throw new InvalidOperationException("security_policy_version_counter_update_conflict");
        }

        long? nextVersion = await TryIncrementVersionCounterAsync(policyId, cancellationToken);
        if (nextVersion.HasValue)
        {
            return nextVersion.Value;
        }

        await EnsureVersionCounterAsync(policyId, cancellationToken);
        nextVersion = await TryIncrementVersionCounterAsync(policyId, cancellationToken);
        if (nextVersion.HasValue)
        {
            return nextVersion.Value;
        }

        throw new InvalidOperationException("security_policy_version_counter_update_conflict");
    }

    private async Task EnsureVersionCounterAsync(string policyId, CancellationToken cancellationToken)
    {
        DateTime utcNow = timeProvider.GetUtcNow().UtcDateTime;
        if (db.CurrentConnectionConfig.DbType == DbType.PostgreSQL)
        {
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO security_policy_version_counter(policy_id, last_version, updated_at_utc)
                SELECT @policyId, COALESCE(MAX(version), 0), @updatedAtUtc
                FROM security_policy_snapshot
                WHERE policy_id = @policyId
                ON CONFLICT (policy_id) DO NOTHING;
                """,
                new SugarParameter[]
                {
                    new("@policyId", policyId),
                    new("@updatedAtUtc", utcNow)
                });
            return;
        }

        if (db.CurrentConnectionConfig.DbType == DbType.MySql)
        {
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT IGNORE INTO security_policy_version_counter(policy_id, last_version, updated_at_utc)
                SELECT @policyId, COALESCE(MAX(version), 0), @updatedAtUtc
                FROM security_policy_snapshot
                WHERE policy_id = @policyId;
                """,
                new SugarParameter[]
                {
                    new("@policyId", policyId),
                    new("@updatedAtUtc", utcNow)
                });
            return;
        }

        bool exists = await db.Queryable<SecurityPolicyVersionCounter>()
            .AnyAsync(item => item.PolicyId == policyId, cancellationToken);
        if (exists)
        {
            return;
        }

        long lastVersion = await db.Queryable<SecurityPolicySnapshot>()
            .Where(item => item.PolicyId == policyId)
            .MaxAsync(item => item.Version);
        await db.Insertable(new SecurityPolicyVersionCounter
        {
            PolicyId = policyId,
            LastVersion = Math.Max(0, lastVersion),
            UpdatedAtUtc = utcNow
        }).ExecuteCommandAsync(cancellationToken);
    }

    private async Task RecordAuditAsync(
        string action,
        string eventInfo,
        SecurityPolicySnapshot snapshot,
        string? reason,
        CancellationToken cancellationToken)
    {
        if (auditEvents is null)
        {
            return;
        }

        await auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Security,
            action,
            AuditOutcomeCatalog.Success,
            AuditSeverityCatalog.Warning,
            eventInfo,
            ActorType: snapshot.CreatedByAdminId.HasValue ? AuditActorTypeCatalog.Admin : AuditActorTypeCatalog.System,
            ActorId: snapshot.CreatedByAdminId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
            TargetType: "security_policy_snapshot",
            TargetId: $"{snapshot.PolicyId}:{snapshot.Version}",
            ReasonCode: reason,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["policy_id"] = snapshot.PolicyId,
                ["version"] = snapshot.Version,
                ["mode"] = snapshot.Mode,
                ["rollback_of_version"] = snapshot.RollbackOfVersion
            },
            IsHighValue: true), cancellationToken);
    }

    private static bool TryDeserialize<T>(SecurityPolicySnapshot? row, out T? document)
    {
        document = default;
        if (row is null || string.IsNullOrWhiteSpace(row.Document))
        {
            return false;
        }

        try
        {
            document = JsonSerializer.Deserialize<T>(row.Document, s_jsonOptions);
            return document is not null;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static SecurityPolicySnapshotRecord ToRecord(SecurityPolicySnapshot row)
        => new(
            row.Id,
            row.PolicyId,
            row.Version,
            row.Mode,
            row.CreatedByAdminId,
            row.CreatedAtUtc,
            row.ActivatedAtUtc,
            row.RevokedAtUtc,
            row.IsLastKnownGood,
            row.RollbackOfVersion,
            row.Reason);

    private static string NormalizePolicyId(string? value)
    {
        string normalized = TextHelpers.LowerTrimmed(value) ?? string.Empty;
        if (normalized.Length == 0)
        {
            throw new ArgumentException("policy_id is required", nameof(value));
        }

        return normalized.Length <= 64 ? normalized : normalized[..64];
    }

}

public sealed class SecurityPolicySnapshotHostedService(
    IServiceScopeFactory scopeFactory,
    ISecurityAdminPolicyService policy,
    ILogger<SecurityPolicySnapshotHostedService> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            using IServiceScope scope = scopeFactory.CreateScope();
            ISecurityPolicySnapshotService snapshots = scope.ServiceProvider.GetRequiredService<ISecurityPolicySnapshotService>();

            SecurityPolicyLoadResult<AntiCrawlerPolicySnapshot> antiCrawler =
                await snapshots.LoadActiveOrLastKnownGoodAsync<AntiCrawlerPolicySnapshot>(SecurityPolicyIds.AntiCrawler, cancellationToken);
            if (antiCrawler.Success && antiCrawler.Document is not null)
            {
                policy.ApplyAntiCrawlerPolicySnapshot(antiCrawler.Document);
            }

            SecurityPolicyLoadResult<PowPolicySnapshot> pow =
                await snapshots.LoadActiveOrLastKnownGoodAsync<PowPolicySnapshot>(SecurityPolicyIds.Pow, cancellationToken);
            if (pow.Success && pow.Document is not null)
            {
                policy.ApplyPowPolicySnapshot(pow.Document);
            }

            SecurityPolicyLoadResult<SecurityRiskPolicySnapshotV2> riskControl =
                await snapshots.LoadActiveOrLastKnownGoodAsync<SecurityRiskPolicySnapshotV2>(SecurityPolicyIds.RiskControl, cancellationToken);
            if (riskControl.Success && riskControl.Document is not null)
            {
                policy.ApplyRiskControlPolicySnapshot(riskControl.Document);
            }

            SecurityPolicyLoadResult<PerceptionSealedV2PolicySnapshot> perceptionV2 =
                await snapshots.LoadActiveOrLastKnownGoodAsync<PerceptionSealedV2PolicySnapshot>(SecurityPolicyIds.PerceptionSealedV2, cancellationToken);
            if (perceptionV2.Success && perceptionV2.Document is not null)
            {
                policy.ApplyPerceptionSealedV2PolicySnapshot(perceptionV2.Document);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "security policy snapshot startup load failed");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
