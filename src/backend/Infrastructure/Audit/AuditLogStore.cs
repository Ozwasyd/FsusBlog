using FsusBlog.Server.Entities;
using SqlSugar;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Audit;

public interface IAuditLogStore
{
    Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, CancellationToken cancellationToken);
}

public sealed class AuditLogStore(ISqlSugarClient db, IConfiguration configuration) : IAuditLogStore
{
    private readonly ISqlSugarClient _db = db;
    private readonly byte[]? _tamperKey = AuditTamperEvidence.ResolveKey(configuration);

    public async Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, CancellationToken cancellationToken)
    {
        if (records.Count == 0)
        {
            return;
        }

        var sql = new StringBuilder("""
            INSERT INTO sys_audit_log (
                source,
                type,
                occurred_at_utc,
                actor_type,
                actor_id,
                actor_role,
                action,
                target_type,
                target_id,
                outcome,
                severity,
                is_high_value,
                trace_id,
                request_path,
                request_method,
                ip_hash,
                user_agent_hash,
                session_id_hash,
                device_fingerprint_hash,
                reason_code,
                event_info,
                context_payload,
                context_json,
                chain_id,
                prev_hash,
                record_hash,
                record_mac
            ) VALUES
            """);
        var parameters = new List<SugarParameter>(records.Count * 27);
        for (int i = 0; i < records.Count; i++)
        {
            if (i > 0)
            {
                sql.Append(", ");
            }

            sql.Append($"""
                (
                    @source_{i},
                    @type_{i},
                    @occurred_at_utc_{i},
                    @actor_type_{i},
                    @actor_id_{i},
                    @actor_role_{i},
                    @action_{i},
                    @target_type_{i},
                    @target_id_{i},
                    @outcome_{i},
                    @severity_{i},
                    @is_high_value_{i},
                    @trace_id_{i},
                    @request_path_{i},
                    @request_method_{i},
                    @ip_hash_{i},
                    @user_agent_hash_{i},
                    @session_id_hash_{i},
                    @device_fingerprint_hash_{i},
                    @reason_code_{i},
                    @event_info_{i},
                    @context_payload_{i},
                    @context_json_{i},
                    @chain_id_{i},
                    @prev_hash_{i},
                    @record_hash_{i},
                    @record_mac_{i}
                )
                """);

            AuditRecord record = records[i];
            AuditRecord signed = SignRecord(record);
            parameters.Add(new SugarParameter($"@source_{i}", record.Source));
            parameters.Add(new SugarParameter($"@type_{i}", record.Type));
            parameters.Add(new SugarParameter($"@occurred_at_utc_{i}", record.OccurredAtUtc));
            parameters.Add(new SugarParameter($"@actor_type_{i}", DbValue(record.ActorType)));
            parameters.Add(new SugarParameter($"@actor_id_{i}", DbValue(record.ActorId)));
            parameters.Add(new SugarParameter($"@actor_role_{i}", DbValue(record.ActorRole)));
            parameters.Add(new SugarParameter($"@action_{i}", NormalizeNonEmpty(record.Action, AuditActionCatalog.LogRecorded)));
            parameters.Add(new SugarParameter($"@target_type_{i}", DbValue(record.TargetType)));
            parameters.Add(new SugarParameter($"@target_id_{i}", DbValue(record.TargetId)));
            parameters.Add(new SugarParameter($"@outcome_{i}", NormalizeNonEmpty(record.Outcome, AuditOutcomeCatalog.Unknown)));
            parameters.Add(new SugarParameter($"@severity_{i}", NormalizeNonEmpty(record.Severity, AuditSeverityCatalog.Info)));
            parameters.Add(new SugarParameter($"@is_high_value_{i}", record.IsHighValue));
            parameters.Add(new SugarParameter($"@trace_id_{i}", DbValue(record.TraceId)));
            parameters.Add(new SugarParameter($"@request_path_{i}", DbValue(record.RequestPath)));
            parameters.Add(new SugarParameter($"@request_method_{i}", DbValue(record.RequestMethod)));
            parameters.Add(new SugarParameter($"@ip_hash_{i}", DbValue(record.IpHash)));
            parameters.Add(new SugarParameter($"@user_agent_hash_{i}", DbValue(record.UserAgentHash)));
            parameters.Add(new SugarParameter($"@session_id_hash_{i}", DbValue(record.SessionIdHash)));
            parameters.Add(new SugarParameter($"@device_fingerprint_hash_{i}", DbValue(record.DeviceFingerprintHash)));
            parameters.Add(new SugarParameter($"@reason_code_{i}", DbValue(record.ReasonCode)));
            parameters.Add(new SugarParameter($"@event_info_{i}", record.EventInfo));
            parameters.Add(new SugarParameter($"@context_payload_{i}", DbValue(record.ContextPayload)));
            parameters.Add(new SugarParameter($"@context_json_{i}", DbValue(record.ContextJson)));
            parameters.Add(new SugarParameter($"@chain_id_{i}", DbValue(signed.ChainId)));
            parameters.Add(new SugarParameter($"@prev_hash_{i}", DbValue(signed.PrevHash)));
            parameters.Add(new SugarParameter($"@record_hash_{i}", DbValue(signed.RecordHash)));
            parameters.Add(new SugarParameter($"@record_mac_{i}", DbValue(signed.RecordMac)));
        }

        await _db.Ado.ExecuteCommandAsync(sql.ToString(), parameters.ToArray());
    }

    private AuditRecord SignRecord(AuditRecord record)
    {
        AuditTamperEvidenceResult evidence = AuditTamperEvidence.Sign(record, _tamperKey);
        return record with
        {
            ChainId = evidence.ChainId,
            RecordHash = evidence.RecordHash,
            RecordMac = evidence.RecordMac
        };
    }

    private static object DbValue(string? value)
        => string.IsNullOrWhiteSpace(value) ? DBNull.Value : value;

    private static object DbValue(byte[]? value)
        => value is { Length: > 0 } ? value : DBNull.Value;

    private static string NormalizeNonEmpty(string? value, string fallback)
        => string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();

}
