using FsusBlog.Server.Entities;
using SqlSugar;
using System.Text;

namespace FsusBlog.Server.Infrastructure.Audit;

public interface IAuditLogStore
{
    Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, CancellationToken cancellationToken);
}

public sealed class AuditLogStore(ISqlSugarClient db) : IAuditLogStore
{
    private readonly ISqlSugarClient _db = db;

    public async Task WriteBatchAsync(IReadOnlyList<AuditRecord> records, CancellationToken cancellationToken)
    {
        if (records.Count == 0)
        {
            return;
        }

        var sql = new StringBuilder("INSERT INTO sys_audit_log (source, type, occurred_at_utc, event_info, context_json) VALUES ");
        var parameters = new List<SugarParameter>(records.Count * 5);
        for (int i = 0; i < records.Count; i++)
        {
            if (i > 0)
            {
                sql.Append(", ");
            }

            sql.Append($"(@source_{i}, @type_{i}, @occurred_at_utc_{i}, @event_info_{i}, CAST(@context_json_{i} AS jsonb))");

            AuditRecord record = records[i];
            parameters.Add(new SugarParameter($"@source_{i}", record.Source));
            parameters.Add(new SugarParameter($"@type_{i}", record.Type));
            parameters.Add(new SugarParameter($"@occurred_at_utc_{i}", record.OccurredAtUtc));
            parameters.Add(new SugarParameter($"@event_info_{i}", record.EventInfo));
            parameters.Add(new SugarParameter($"@context_json_{i}", (object?)record.ContextJson ?? DBNull.Value));
        }

        await _db.Ado.ExecuteCommandAsync(sql.ToString(), parameters.ToArray());
    }
}
