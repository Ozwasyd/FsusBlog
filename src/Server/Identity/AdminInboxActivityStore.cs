using FsusBlog.V2.Contracts;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    internal async Task<AdminInboxPage> ReadInboxByActivity(string? token, int filter, string? next, bool shared, CancellationToken ct)
    {
        var initial = next is null
            ? await WithLiveAdmin(token, Permission, (db, tx, _) => InboxActivityFence.SnapshotAsync(db, tx, ct), ct)
            : 0L;
        return await WithLiveAdmin(token, Permission, async (db, tx, admin) =>
        {
            var scope = checked((byte)(filter + (shared ? 41 : 33)));
            AdminInboxActivityCursor? position = next is null ? null :
                AdminInboxActivityCursor.TryDecode(next, admin.Digest, scope, out var parsed) ? parsed : throw InvalidInboxCursor();
            long snapshot = position?.Snapshot ?? initial;
            if (snapshot == 0) return new AdminInboxPage([], null);

            var unread = shared ? AdminUnread : "0::bigint";
            var join = shared ? AdminReadJoin : "";
            var filterUnread = filter == 3 ? AdminUnread : "0::bigint";
            var pendingJoin = filter == 3 ? AdminReadJoin : "";
            await using var query = Store.Sql(db, tx, $"""
                WITH page AS MATERIALIZED (
                    SELECT c.id,last_visible.sent_at
                    FROM public.inbox_conversation c
                    {pendingJoin}
                    JOIN LATERAL (
                        SELECT m.sent_at FROM public.inbox_message m
                        WHERE m.conversation_id=c.id AND m.id<=$1 AND NOT m.is_internal
                        ORDER BY m.id DESC LIMIT 1
                    ) last_visible ON true
                    WHERE ($2=0 OR (last_visible.sent_at,c.id)<($3,$2))
                        AND CASE $4 WHEN -1 THEN true WHEN 3 THEN {filterUnread}>0 WHEN 4 THEN c.is_system ELSE c.status=$4 END
                    ORDER BY last_visible.sent_at DESC,c.id DESC LIMIT $5
                )
                SELECT c.id,c.account_id,c.subject,c.status,c.is_system,{InboxStore.ConversationActivity},{unread},page.sent_at
                FROM page JOIN public.inbox_conversation c ON c.id=page.id
                {join}
                ORDER BY page.sent_at DESC,c.id DESC
                """, snapshot, position?.Conversation ?? 0L, position?.At ?? DateTimeOffset.UnixEpoch, filter,
                Wire.AdminInboxPageSize + 1);
            await using var rows = await query.ExecuteReaderAsync(ct);
            List<AdminInboxRow> items = [];
            DateTimeOffset lastAt = default;
            string? cursor = null;
            while (await rows.ReadAsync(ct))
            {
                if (items.Count == Wire.AdminInboxPageSize)
                {
                    cursor = new AdminInboxActivityCursor(snapshot, lastAt, items[^1].Id).Encode(admin.Digest, scope);
                    break;
                }
                items.Add(InboxRow(rows, 6));
                lastAt = rows.GetFieldValue<DateTimeOffset>(7);
            }
            return new AdminInboxPage(items, cursor);
        }, ct);
    }
}
