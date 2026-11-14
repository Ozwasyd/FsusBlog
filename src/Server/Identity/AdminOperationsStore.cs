using FsusBlog.V2.Contracts;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    internal Task<AdminOperationsStatus> OperationsStatus(string? token, Publications publications, CancellationToken ct) =>
        WithSession(token, CurrentSchema.AuditReadPermission, async (db, tx, _) =>
        {
            await using var query = Store.Sql(db, tx, """
                select count(*), min(created_at)
                from public.blog_outbox where processed_at is null and kind in ('publish','retract','delete')
                """);
            await using var result = await query.ExecuteReaderAsync(ct);
            await result.ReadAsync(ct);
            var pending = result.GetInt64(0);
            var oldest = result.IsDBNull(1) ? 0 : result.GetFieldValue<DateTimeOffset>(1).ToUnixTimeMilliseconds();
            var snapshot = publications.Snapshot;
            return new AdminOperationsStatus(snapshot is not null, snapshot?.Watermark ?? 0, pending, oldest);
        }, ct);
}
