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
        await db.Insertable(audits.ToArray()).ExecuteCommandAsync();
        FsusObservability.RecordAdminAuditBatch(
            adminAuditBatchSize: audits.Count,
            adminAuditWriteElapsed: FsusObservability.GetElapsed(startedAt));
        cancellationToken.ThrowIfCancellationRequested();
    }
}
