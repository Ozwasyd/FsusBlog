using Npgsql;

namespace FsusBlogV2.Storage;

internal static class InboxActivityFence
{
    internal const string Setting = "FSUSBLOG_ADMIN_INBOX_ACTIVITY_ORDER";
    private const int LockClass = 1179866434;
    private const int LockObject = 2;

    internal static async Task<long> SnapshotAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await TakeAsync(db, tx, shared: false, ct);
        // Start this statement after earlier writers commit. A lock and MAX in one statement
        // could retain the pre-wait PostgreSQL snapshot under READ COMMITTED.
        await using var query = new NpgsqlCommand("""
            SELECT coalesce(max(id),0) FROM public.inbox_message WHERE NOT is_internal
            """, db, tx) { CommandTimeout = 2 };
        return (long)(await query.ExecuteScalarAsync(ct))!;
    }

    internal static async Task TakeAsync(NpgsqlConnection db, NpgsqlTransaction tx, bool shared, CancellationToken ct)
    {
        await using var fence = new NpgsqlCommand(shared ? "SELECT pg_catalog.pg_advisory_xact_lock_shared($1,$2)"
            : "SELECT pg_catalog.pg_advisory_xact_lock($1,$2)", db, tx) { CommandTimeout = 2 };
        fence.Parameters.AddWithValue(LockClass);
        fence.Parameters.AddWithValue(LockObject);
        await fence.ExecuteNonQueryAsync(ct);
    }
}
