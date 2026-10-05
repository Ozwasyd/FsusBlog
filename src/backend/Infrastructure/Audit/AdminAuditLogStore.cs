using System.Diagnostics;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Observability;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Audit;

public interface IAdminAuditLogStore
{
    Task WriteBatchAsync(IReadOnlyList<AdminAuditLog> audits, CancellationToken cancellationToken);
}

public sealed class AdminAuditLogStore(ISqlSugarClient db) : IAdminAuditLogStore
{
    public async Task WriteBatchAsync(IReadOnlyList<AdminAuditLog> audits, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (audits.Count == 0)
        {
            return;
        }

        long startedAt = Stopwatch.GetTimestamp();
        foreach (AdminAuditLog audit in audits)
        {
            await WriteDeliveryAsync(audit, cancellationToken).ConfigureAwait(false);
        }
        FsusObservability.RecordAdminAuditBatch(
            adminAuditBatchSize: audits.Count,
            adminAuditWriteElapsed: FsusObservability.GetElapsed(startedAt));
        cancellationToken.ThrowIfCancellationRequested();
    }

    private async Task WriteDeliveryAsync(AdminAuditLog audit, CancellationToken cancellationToken)
    {
        AdminAuditDurableDelivery delivery = AdminAuditDurableDelivery.GetRequired(audit);
        AdminAuditLog payload = AdminAuditDurableDelivery.Copy(delivery.Entry.Payload);
        DateTime utc = payload.OccurredAtUtc.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(payload.OccurredAtUtc, DateTimeKind.Utc)
            : payload.OccurredAtUtc.ToUniversalTime();
        payload.OccurredAtUtc = new DateTime(utc.Ticks - utc.Ticks % 10, DateTimeKind.Utc);
        if (db.Ado.Transaction is not null)
        {
            throw new InvalidOperationException("admin_audit_durable_store_requires_owned_transaction");
        }
        CancellationToken? previousCancellation = db.Ado.CancellationToken;
        db.Ado.CancellationToken = cancellationToken;
        try
        {
            await db.Ado.BeginTranAsync().ConfigureAwait(false);
            await db.Ado.ExecuteCommandAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2040));",
                new SugarParameter("@Identity", $"admin-audit-delivery:{delivery.Entry.DeliveryId:N}"))
                .ConfigureAwait(false);
            long id = await delivery.ReserveDatabaseIdAsync(async () =>
            {
                object reserved = await db.Ado.GetScalarAsync(
                    "SELECT nextval(pg_get_serial_sequence('admin_audit_log', 'id'));")
                    .ConfigureAwait(false);
                long candidate = Convert.ToInt64(reserved, System.Globalization.CultureInfo.InvariantCulture);
                if ((await ReadReceiptAsync(candidate).ConfigureAwait(false)).Count != 0)
                {
                    // A broken/reset sequence is not an existing-event receipt.
                    throw new InvalidDataException("admin_audit_sequence_identity_collision");
                }
                return candidate;
            }, cancellationToken).ConfigureAwait(false);
            await db.Ado.ExecuteCommandAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2040));",
                new SugarParameter("@Identity", $"admin-audit-commit:{id.ToString(System.Globalization.CultureInfo.InvariantCulture)}"))
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            List<AdminAuditLog> existing = await ReadReceiptAsync(id).ConfigureAwait(false);
            if (existing.Count == 0)
            {
                await db.Ado.ExecuteCommandAsync(
                    """
                    INSERT INTO admin_audit_log
                        (id, adminprincipalid, adminsessionid, action, outcome, targettype, targetid,
                         iphash, useragenthash, ishighimpact, metadatajson, occurredatutc)
                    VALUES
                        (@Id, @Principal, @Session, @Action, @Outcome, @TargetType, @TargetId,
                         @IpHash, @UserAgentHash, @HighImpact, @Metadata, @OccurredAtUtc);
                    """,
                    new SugarParameter("@Id", id),
                    new SugarParameter("@Principal", payload.AdminPrincipalId),
                    new SugarParameter("@Session", payload.AdminSessionId),
                    new SugarParameter("@Action", payload.Action),
                    new SugarParameter("@Outcome", payload.Outcome),
                    new SugarParameter("@TargetType", payload.TargetType),
                    new SugarParameter("@TargetId", payload.TargetId),
                    new SugarParameter("@IpHash", payload.IpHash),
                    new SugarParameter("@UserAgentHash", payload.UserAgentHash),
                    new SugarParameter("@HighImpact", payload.IsHighImpact),
                    new SugarParameter("@Metadata", payload.MetadataJson),
                    new SugarParameter("@OccurredAtUtc", payload.OccurredAtUtc))
                    .ConfigureAwait(false);
                existing = await ReadReceiptAsync(id).ConfigureAwait(false);
            }
            if (existing.Count != 1 || existing[0].Id != id
                || !AdminAuditDurableDelivery.MatchesStored(delivery.Entry.Payload, existing[0]))
            {
                throw new InvalidDataException("admin_audit_durable_commit_postcondition_mismatch");
            }
            cancellationToken.ThrowIfCancellationRequested();
            await db.Ado.CommitTranAsync().ConfigureAwait(false);
        }
        catch
        {
            db.Ado.CancellationToken = null;
            if (db.Ado.Transaction is not null)
            {
                await db.Ado.RollbackTranAsync().ConfigureAwait(false);
            }
            throw;
        }
        finally
        {
            db.Ado.CancellationToken = previousCancellation;
        }
    }

    private Task<List<AdminAuditLog>> ReadReceiptAsync(long id)
        => db.Ado.SqlQueryAsync<AdminAuditLog>(
            """
            SELECT id AS "Id", adminprincipalid AS "AdminPrincipalId", adminsessionid AS "AdminSessionId",
                action AS "Action", outcome AS "Outcome", targettype AS "TargetType", targetid AS "TargetId",
                iphash AS "IpHash", useragenthash AS "UserAgentHash", ishighimpact AS "IsHighImpact",
                metadatajson AS "MetadataJson", occurredatutc AS "OccurredAtUtc"
            FROM admin_audit_log WHERE id = @Id;
            """,
            new SugarParameter("@Id", id));
}
