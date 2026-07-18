using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Observability;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Audit;

public interface IAuditLogStore
{
    Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, CancellationToken cancellationToken);
}

public sealed class AuditLogStore(
    ISqlSugarClient db,
    IConfiguration configuration,
    AuditRetentionPayloadProtector? retentionProtector = null) : IAuditLogStore
{
    private const int ColumnCount = 27;
    private static readonly ConcurrentDictionary<int, AuditLogInsertBatchShape> InsertBatchShapes = new();
    private static readonly ConcurrentDictionary<string, string> ChainTailCache = new(StringComparer.Ordinal);
    private static readonly string[] ParameterColumns =
    [
        "source",
        "type",
        "occurred_at_utc",
        "actor_type",
        "actor_id",
        "actor_role",
        "action",
        "target_type",
        "target_id",
        "outcome",
        "severity",
        "is_high_value",
        "trace_id",
        "request_path",
        "request_method",
        "ip_hash",
        "user_agent_hash",
        "session_id_hash",
        "device_fingerprint_hash",
        "reason_code",
        "event_info",
        "context_payload",
        "context_json",
        "chain_id",
        "prev_hash",
        "record_hash",
        "record_mac"
    ];

    private readonly ISqlSugarClient _db = db;
    private readonly byte[]? _tamperKey = AuditTamperEvidence.ResolveKey(configuration);

    public async Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, CancellationToken cancellationToken)
    {
        if (records.Count == 0)
        {
            return;
        }

        long startedAt = Stopwatch.GetTimestamp();
        AuditLogInsertBatchShape shape = InsertBatchShapes.GetOrAdd(records.Count, BuildInsertBatchShape);
        var parameters = new SugarParameter[records.Count * ColumnCount];
        var chainTails = new Dictionary<string, string?>(StringComparer.Ordinal);
        int parameterOffset = 0;
        for (int i = 0; i < records.Count; i++)
        {
            _ = AuditRetentionCatalog.GetRequired(records[i].Action);
            AuditRecord protectedRecord = retentionProtector is null
                ? records[i]
                : await retentionProtector.ProtectAsync(records[i], cancellationToken).ConfigureAwait(false);
            AuditRecord record = EnsureContextJson(protectedRecord);
            string chainId = ResolveChainId(record);
            if (!chainTails.TryGetValue(chainId, out string? prevHash))
            {
                if (ChainTailCache.TryGetValue(chainId, out prevHash))
                {
                    FsusObservability.RecordAuditChainTailCache(hit: true);
                }
                else
                {
                    FsusObservability.RecordAuditChainTailCache(hit: false);
                    prevHash = await ResolveChainTailAsync(chainId, cancellationToken);
                }
            }

            AuditRecord signed = SignRecord(record with
            {
                ChainId = chainId,
                PrevHash = prevHash
            });
            chainTails[chainId] = signed.RecordHash;

            AddParameters(parameters, shape.ParameterNames, ref parameterOffset, signed);
        }

        await _db.Ado.ExecuteCommandAsync(shape.Sql, parameters);
        foreach ((string chainId, string? recordHash) in chainTails)
        {
            if (!string.IsNullOrWhiteSpace(recordHash))
            {
                ChainTailCache[chainId] = recordHash;
            }
        }

        FsusObservability.RecordAuditBatchWrite(records.Count, FsusObservability.GetElapsed(startedAt));
    }

    private static AuditLogInsertBatchShape BuildInsertBatchShape(int recordCount)
    {
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
        string[] parameterNames = new string[recordCount * ColumnCount];
        int parameterOffset = 0;
        for (int row = 0; row < recordCount; row++)
        {
            if (row > 0)
            {
                sql.Append(", ");
            }

            sql.Append('(');
            for (int column = 0; column < ParameterColumns.Length; column++)
            {
                if (column > 0)
                {
                    sql.Append(", ");
                }

                string parameterName = string.Concat("@", ParameterColumns[column], "_", row);
                parameterNames[parameterOffset++] = parameterName;
                sql.Append(parameterName);
            }

            sql.Append(')');
        }

        return new AuditLogInsertBatchShape(sql.ToString(), parameterNames);
    }

    private static void AddParameters(
        SugarParameter[] parameters,
        string[] parameterNames,
        ref int offset,
        AuditRecord signed)
    {
        parameters[offset] = new SugarParameter(parameterNames[offset++], signed.Source);
        parameters[offset] = new SugarParameter(parameterNames[offset++], signed.Type);
        parameters[offset] = new SugarParameter(parameterNames[offset++], signed.OccurredAtUtc);
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.ActorType));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.ActorId));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.ActorRole));
        parameters[offset] = new SugarParameter(parameterNames[offset++], NormalizeNonEmpty(signed.Action, AuditActionCatalog.LogRecorded));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.TargetType));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.TargetId));
        parameters[offset] = new SugarParameter(parameterNames[offset++], NormalizeNonEmpty(signed.Outcome, AuditOutcomeCatalog.Unknown));
        parameters[offset] = new SugarParameter(parameterNames[offset++], NormalizeNonEmpty(signed.Severity, AuditSeverityCatalog.Info));
        parameters[offset] = new SugarParameter(parameterNames[offset++], signed.IsHighValue);
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.TraceId));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.RequestPath));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.RequestMethod));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.IpHash));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.UserAgentHash));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.SessionIdHash));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.DeviceFingerprintHash));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.ReasonCode));
        parameters[offset] = new SugarParameter(parameterNames[offset++], signed.EventInfo);
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.ContextPayload));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.ContextJson));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.ChainId));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.PrevHash));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.RecordHash));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.RecordMac));
    }

    private static AuditRecord EnsureContextJson(AuditRecord record)
        => record.ContextJson is not null || record.ContextPayload is not { Length: > 0 }
            ? record
            : record with
            {
                ContextJson = AuditContextJsonSerializer.Serialize(record.ContextPayload)
            };

    private async Task<string?> ResolveChainTailAsync(string chainId, CancellationToken cancellationToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        string? tail = await _db.Queryable<AuditLog>()
            .Where(it => it.ChainId == chainId && it.RecordHash != null)
            .OrderByDescending(it => it.Id)
            .Select(it => it.RecordHash)
            .FirstAsync(cancellationToken);
        FsusObservability.RecordAuditChainTailQuery(FsusObservability.GetElapsed(startedAt));
        return tail;
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

    private static string ResolveChainId(AuditRecord record)
        => string.IsNullOrWhiteSpace(record.ChainId)
            ? record.OccurredAtUtc.ToUniversalTime().ToString("yyyyMMdd", CultureInfo.InvariantCulture)
            : record.ChainId.Trim();

    internal static void ClearChainTailCacheForTests()
        => ChainTailCache.Clear();

    private sealed record AuditLogInsertBatchShape(string Sql, string[] ParameterNames);
}
