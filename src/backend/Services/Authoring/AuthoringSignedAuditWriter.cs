using System.Data.Common;
using System.Globalization;

using FsusBlog.Server.Infrastructure.Audit;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Atomically appends a signed, chain-linked sys_audit_log row inside the caller's ambient
/// SqlSugar transaction. Authoring authorities that bind receipts to durable audit evidence
/// use this single helper so a committed mutation can never lack its audit link.
/// </summary>
internal static class AuthoringSignedAuditWriter
{
    internal sealed record ChainWrite(string ChainId, string RecordHash);

    internal static async Task<ChainWrite> InsertAsync(
        ISqlSugarClient db,
        byte[]? tamperKey,
        AuditRecord record,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(record);
        if (record.OccurredAtUtc.Kind == DateTimeKind.Local)
        {
            throw new ArticleTemplateIntegrityException("authoring_audit_timestamp_not_utc");
        }
        _ = AuditRetentionCatalog.GetRequired(record.Action);

        DateTime occurredAtUtc = record.OccurredAtUtc.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(record.OccurredAtUtc, DateTimeKind.Utc)
            : record.OccurredAtUtc;
        string chainId = occurredAtUtc.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
        // Serialize tail reads among writers following this protocol so consecutive rows in
        // one audit chain cannot fork on an identical prev_hash.
        await db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2361));",
            new SugarParameter("@Identity", $"authoring-audit-chain:{chainId}"))
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();

        string? prevHash;
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT record_hash
            FROM sys_audit_log
            WHERE chain_id = @ChainId
              AND record_hash IS NOT NULL
            ORDER BY id DESC
            LIMIT 1;
            """,
            new SugarParameter("@ChainId", chainId)).ConfigureAwait(false))
        {
            prevHash = await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
                ? reader.GetString(0)
                : null;
        }

        AuditTamperEvidenceResult evidence = AuditTamperEvidence.Sign(
            record with
            {
                OccurredAtUtc = occurredAtUtc,
                ChainId = chainId,
                PrevHash = prevHash
            },
            tamperKey);
        AuditRecord signed = record with
        {
            OccurredAtUtc = occurredAtUtc,
            ChainId = evidence.ChainId,
            PrevHash = prevHash,
            RecordHash = evidence.RecordHash,
            RecordMac = evidence.RecordMac
        };

        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO sys_audit_log (
                source, type, occurred_at_utc, actor_type, actor_id, actor_role,
                action, target_type, target_id, outcome, severity, is_high_value,
                trace_id, request_path, request_method, ip_hash, user_agent_hash,
                session_id_hash, device_fingerprint_hash, reason_code, event_info,
                context_payload, context_json, chain_id, prev_hash, record_hash, record_mac)
            VALUES (
                @Source, @Type, @OccurredAtUtc, @ActorType, @ActorId, @ActorRole,
                @Action, @TargetType, @TargetId, @Outcome, @Severity, @IsHighValue,
                @TraceId, @RequestPath, @RequestMethod, @IpHash, @UserAgentHash,
                @SessionIdHash, @DeviceFingerprintHash, @ReasonCode, @EventInfo,
                @ContextPayload, @ContextJson, @ChainId, @PrevHash, @RecordHash, @RecordMac);
            """,
            new SugarParameter("@Source", signed.Source),
            new SugarParameter("@Type", signed.Type),
            new SugarParameter("@OccurredAtUtc", signed.OccurredAtUtc),
            new SugarParameter("@ActorType", DbText(signed.ActorType)),
            new SugarParameter("@ActorId", DbText(signed.ActorId)),
            new SugarParameter("@ActorRole", DbText(signed.ActorRole)),
            new SugarParameter("@Action", signed.Action),
            new SugarParameter("@TargetType", DbText(signed.TargetType)),
            new SugarParameter("@TargetId", DbText(signed.TargetId)),
            new SugarParameter("@Outcome", signed.Outcome),
            new SugarParameter("@Severity", signed.Severity),
            new SugarParameter("@IsHighValue", signed.IsHighValue),
            new SugarParameter("@TraceId", DbText(signed.TraceId)),
            new SugarParameter("@RequestPath", DbText(signed.RequestPath)),
            new SugarParameter("@RequestMethod", DbText(signed.RequestMethod)),
            new SugarParameter("@IpHash", DbText(signed.IpHash)),
            new SugarParameter("@UserAgentHash", DbText(signed.UserAgentHash)),
            new SugarParameter("@SessionIdHash", DbText(signed.SessionIdHash)),
            new SugarParameter("@DeviceFingerprintHash", DbText(signed.DeviceFingerprintHash)),
            new SugarParameter("@ReasonCode", DbText(signed.ReasonCode)),
            new SugarParameter("@EventInfo", signed.EventInfo),
            new SugarParameter("@ContextPayload", signed.ContextPayload is { Length: > 0 } payload ? payload : DBNull.Value)
            {
                DbType = System.Data.DbType.Binary
            },
            new SugarParameter("@ContextJson", DbText(signed.ContextJson)),
            new SugarParameter("@ChainId", signed.ChainId),
            new SugarParameter("@PrevHash", DbText(signed.PrevHash)),
            new SugarParameter("@RecordHash", signed.RecordHash),
            new SugarParameter("@RecordMac", DbText(signed.RecordMac)))
            .ConfigureAwait(false);

        return new ChainWrite(evidence.ChainId, evidence.RecordHash);
    }

    private static object DbText(string? value)
        => string.IsNullOrWhiteSpace(value) ? DBNull.Value : value;
}
