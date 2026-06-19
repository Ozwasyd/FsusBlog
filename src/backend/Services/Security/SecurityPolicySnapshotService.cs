using System.Text.Json;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
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
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

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
        string documentJson = JsonSerializer.Serialize(document, JsonOptions);
        string? normalizedReason = NormalizeNullable(reason, 128);
        DateTime utcNow = timeProvider.GetUtcNow().UtcDateTime;
        SecurityPolicySnapshot? inserted = null;

        var transaction = await db.Ado.UseTranAsync(async () =>
        {
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

        string? normalizedReason = NormalizeNullable(reason, 128) ?? "rollback";
        DateTime utcNow = timeProvider.GetUtcNow().UtcDateTime;
        SecurityPolicySnapshot? inserted = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
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

    private async Task<long> ResolveNextVersionAsync(string policyId, CancellationToken cancellationToken)
    {
        SecurityPolicySnapshot? latest = await db.Queryable<SecurityPolicySnapshot>()
            .Where(item => item.PolicyId == policyId)
            .OrderBy(item => item.Version, OrderByType.Desc)
            .FirstAsync(cancellationToken);
        return (latest?.Version ?? 0) + 1;
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
            document = JsonSerializer.Deserialize<T>(row.Document, JsonOptions);
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
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            throw new ArgumentException("policy_id is required", nameof(value));
        }

        return normalized.Length <= 64 ? normalized : normalized[..64];
    }

    private static string? NormalizeNullable(string? value, int maxLength)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        if (normalized.Length == 0)
        {
            return null;
        }

        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
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
