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

    void InvalidateChainTailCache(IEnumerable<string> chainIds)
    {
    }
}

public sealed class AuditLogStore(
    ISqlSugarClient db,
    IConfiguration configuration,
    AuditRetentionPayloadProtector? retentionProtector = null) : IAuditLogStore
{
    private const int ColumnCount = 27;
    private static readonly ConcurrentDictionary<int, AuditLogInsertBatchShape> s_insertBatchShapes = new();
    private static readonly ConcurrentDictionary<string, string> s_chainTailCache = new(StringComparer.Ordinal);
    private static readonly string[] s_parameterColumns =
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
        if (!records.Any(static record => record.DurableDeliveryId is not null))
        {
            await WriteUnjournaledBatchAsync(records, cancellationToken).ConfigureAwait(false);
            return;
        }
        foreach (AuditRecord record in records)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (record.DurableDeliveryId is null)
            {
                await WriteUnjournaledBatchAsync([record], cancellationToken).ConfigureAwait(false);
                continue;
            }
            await WriteDurableRecordAsync(record, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task WriteDurableRecordAsync(AuditRecord record, CancellationToken cancellationToken)
    {
        record = AuditDurableDelivery.NormalizeForStore(record);
        AuditDurableDelivery.Validate(record);
        string chainId = ResolveChainId(record);
        if (_db.Ado.Transaction is not null)
        {
            throw new InvalidOperationException("audit_durable_store_requires_owned_transaction");
        }
        CancellationToken? previousCancellation = _db.Ado.CancellationToken;
        _db.Ado.CancellationToken = cancellationToken;
        try
        {
            await _db.Ado.BeginTranAsync().ConfigureAwait(false);
            // Serialize duplicate delivery and daily chain tail resolution across
            // independent scopes/processes, using the existing authoring chain fence.
            await _db.Ado.ExecuteCommandAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2361));",
                new SugarParameter("@Identity", $"audit-delivery:{record.DurableDeliveryId}"))
                .ConfigureAwait(false);
            await _db.Ado.ExecuteCommandAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2361));",
                new SugarParameter("@Identity", $"authoring-audit-chain:{chainId}"))
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            List<AuditLog> existing = await _db.Ado.SqlQueryAsync<AuditLog>(
                """
                SELECT source AS "Source", type AS "Type", occurred_at_utc AS "OccurredAtUtc",
                    actor_type AS "ActorType", actor_id AS "ActorId", actor_role AS "ActorRole",
                    action AS "Action", target_type AS "TargetType", target_id AS "TargetId",
                    outcome AS "Outcome", severity AS "Severity", is_high_value AS "IsHighValue",
                    trace_id AS "TraceId", request_path AS "RequestPath", request_method AS "RequestMethod",
                    ip_hash AS "IpHash", user_agent_hash AS "UserAgentHash", session_id_hash AS "SessionIdHash",
                    device_fingerprint_hash AS "DeviceFingerprintHash", reason_code AS "ReasonCode",
                    event_info AS "EventInfo", context_payload AS "ContextPayload", context_json AS "ContextJson",
                    chain_id AS "ChainId", prev_hash AS "PrevHash", record_hash AS "RecordHash", record_mac AS "RecordMac"
                FROM sys_audit_log
                WHERE context_payload = @Payload
                LIMIT 2;
                """,
                new SugarParameter("@Payload", record.ContextPayload) { DbType = System.Data.DbType.Binary })
                .ConfigureAwait(false);
            if (existing.Count > 0)
            {
                AuditLog row = existing[0];
                AuditTamperEvidenceResult expected = AuditTamperEvidence.Sign(record with
                {
                    ChainId = chainId,
                    PrevHash = row.PrevHash,
                    RecordHash = null,
                    RecordMac = null
                }, _tamperKey);
                AuditTamperEvidenceResult actual = AuditTamperEvidence.Sign(AuditTamperEvidence.FromLog(row) with
                {
                    RecordHash = null,
                    RecordMac = null
                }, _tamperKey);
                if (existing.Count != 1 || row.ChainId != chainId
                    || row.RecordHash != expected.RecordHash || row.RecordMac != expected.RecordMac
                    || row.RecordHash != actual.RecordHash || row.RecordMac != actual.RecordMac)
                {
                    throw new InvalidDataException("audit_durable_commit_postcondition_mismatch");
                }
            }
            else
            {
                // A process-local cached tail is not a cross-process commit proof.
                string? previous = await ResolveChainTailAsync(chainId, cancellationToken).ConfigureAwait(false);
                AuditRecord signed = SignRecord(record with
                {
                    ChainId = chainId,
                    PrevHash = previous,
                    RecordHash = null,
                    RecordMac = null
                });
                AuditLogInsertBatchShape shape = s_insertBatchShapes.GetOrAdd(1, BuildInsertBatchShape);
                var parameters = new SugarParameter[ColumnCount];
                int offset = 0;
                AddParameters(parameters, shape.ParameterNames, ref offset, signed);
                await _db.Ado.ExecuteCommandAsync(shape.Sql, parameters).ConfigureAwait(false);
            }
            cancellationToken.ThrowIfCancellationRequested();
            await _db.Ado.CommitTranAsync().ConfigureAwait(false);
            InvalidateChainTailCache([chainId]);
        }
        catch
        {
            InvalidateChainTailCache([chainId]);
            // A cancelled SQL command must not cancel transaction cleanup too.
            _db.Ado.CancellationToken = null;
            if (_db.Ado.Transaction is not null)
            {
                await _db.Ado.RollbackTranAsync().ConfigureAwait(false);
            }
            throw;
        }
        finally
        {
            _db.Ado.CancellationToken = previousCancellation;
        }
    }

    private async Task WriteUnjournaledBatchAsync(IReadOnlyList<AuditRecord> records, CancellationToken cancellationToken)
    {
        if (records.Count == 0)
        {
            return;
        }

        long startedAt = Stopwatch.GetTimestamp();
        AuditLogInsertBatchShape shape = s_insertBatchShapes.GetOrAdd(records.Count, BuildInsertBatchShape);
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
                if (s_chainTailCache.TryGetValue(chainId, out prevHash))
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
                s_chainTailCache[chainId] = recordHash;
            }
        }

        FsusObservability.RecordAuditBatchWrite(records.Count, FsusObservability.GetElapsed(startedAt));
    }

    public void InvalidateChainTailCache(IEnumerable<string> chainIds)
    {
        foreach (string chainId in chainIds.Where(static item => !string.IsNullOrWhiteSpace(item)))
        {
            s_chainTailCache.TryRemove(chainId, out _);
        }
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
            for (int column = 0; column < s_parameterColumns.Length; column++)
            {
                if (column > 0)
                {
                    sql.Append(", ");
                }

                string parameterName = string.Concat("@", s_parameterColumns[column], "_", row);
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
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.ContextPayload))
        {
            DbType = System.Data.DbType.Binary
        };
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.ContextJson));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.ChainId));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.PrevHash));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.RecordHash));
        parameters[offset] = new SugarParameter(parameterNames[offset++], DbValue(signed.RecordMac));
    }

    private static AuditRecord EnsureContextJson(AuditRecord record)
        => record.DurableDeliveryId is not null || record.ContextJson is not null || record.ContextPayload is not { Length: > 0 }
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

    /// <summary>
    /// Drops the cached tail for a chain that an in-transaction writer has just extended.
    /// The next batch re-reads the durable tail so its prev_hash binds the committed row.
    /// </summary>
    internal static void InvalidateChainTail(string chainId)
    {
        if (!string.IsNullOrWhiteSpace(chainId))
        {
            s_chainTailCache.TryRemove(chainId, out _);
        }
    }

    internal static void ClearChainTailCacheForTests()
        => s_chainTailCache.Clear();

    internal static void InvalidateChainTailCacheForFixtureCleanup(IEnumerable<string> chainIds)
    {
        foreach (string chainId in chainIds.Where(static item => !string.IsNullOrWhiteSpace(item)))
        {
            s_chainTailCache.TryRemove(chainId, out _);
        }
    }

    private sealed record AuditLogInsertBatchShape(string Sql, string[] ParameterNames);
}
