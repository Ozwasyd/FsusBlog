using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    private const string InboxStatusHead = """
        coalesce((SELECT s.id FROM public.inbox_admin_status s WHERE s.conversation_id=c.id ORDER BY s.id DESC LIMIT 1), 0)
        """;

    internal Task<string> InboxQueuePosition(string? token, int filter, bool statusEnabled, CancellationToken ct) =>
        WithLiveAdmin(token, Permission, async (db, tx, _) =>
        {
            // Compare the actual page plus its pagination boundary. The highest ID alone
            // misses status changes and tickets allocated earlier but committed later.
            var statusHead = statusEnabled ? InboxStatusHead : "0";
            await using var query = Store.Sql(db, tx, $"""
                SELECT coalesce(string_agg(visible.position, ',' ORDER BY visible.id DESC), '')
                FROM (
                    SELECT c.id,concat_ws(':',c.id,c.status,c.last_message_id,{statusHead}) AS position
                    FROM public.inbox_conversation c
                    WHERE c.last_message_id IS NOT NULL
                        AND CASE $1 WHEN -1 THEN true WHEN 4 THEN c.is_system ELSE c.status=$1 END
                    ORDER BY c.id DESC LIMIT $2
                ) visible
                """, filter, Wire.AdminInboxPageSize + 1);
            return (string)(await query.ExecuteScalarAsync(ct))!;
        }, ct);

    internal Task<string> InboxThreadPosition(string? token, long id, bool statusEnabled, CancellationToken ct) =>
        WithLiveAdmin(token, Permission, async (db, tx, _) =>
        {
            var statusHead = statusEnabled ? InboxStatusHead : "0";
            await using var query = Store.Sql(db, tx, $"""
                SELECT concat_ws(':',c.status,c.last_message_id,{statusHead})
                FROM public.inbox_conversation c WHERE c.id=$1 AND NOT c.is_system AND c.last_message_id IS NOT NULL
                """, id);
            return await query.ExecuteScalarAsync(ct) is string position ? position :
                throw new BusinessException(Rejection.NotFound, "Administrator inbox conversation not found.");
        }, ct);

    internal Task<AdminInboxPage> ReadInbox(string? token, int filter, string? next, CancellationToken ct, bool shared = false) =>
        WithLiveAdmin(token, Permission, async (db, tx, admin) =>
        {
            var scope = checked((byte)(filter + (shared ? 17 : 1)));
            var position = InboxPosition(next, admin.Digest, scope);
            var unread = shared ? AdminUnread : "0::bigint";
            var join = shared ? AdminReadJoin : "";
            await using var query = Store.Sql(db, tx, $"""
                SELECT c.id,c.account_id,c.subject,c.status,c.is_system,{InboxStore.ConversationActivity},unread.count
                FROM public.inbox_conversation c {join}
                CROSS JOIN LATERAL (SELECT {unread} AS count) unread
                WHERE ($1=0 OR c.id<$1) AND c.last_message_id IS NOT NULL
                    AND CASE $2 WHEN -1 THEN true WHEN 3 THEN unread.count>0 WHEN 4 THEN c.is_system ELSE c.status=$2 END
                ORDER BY c.id DESC LIMIT $3
                """, position?.First ?? 0L, filter, Wire.AdminInboxPageSize + 1);
            await using var rows = await query.ExecuteReaderAsync(ct);
            List<AdminInboxRow> items = [];
            string? cursor = null;
            while (await rows.ReadAsync(ct))
            {
                if (items.Count == Wire.AdminInboxPageSize)
                {
                    cursor = new AdminInboxCursor(items[^1].Id, 0).Encode(admin.Digest, scope);
                    break;
                }
                items.Add(InboxRow(rows, 6));
            }
            return new AdminInboxPage(items, cursor);
        }, ct);

    internal Task<AdminInboxThread> ReadInboxThread(string? token, long id, string? older, CancellationToken ct, bool shared = false) =>
        WithLiveAdmin(token, Permission, async (db, tx, admin) =>
        {
            var scope = shared ? (byte)24 : (byte)8;
            var position = InboxPosition(older, admin.Digest, scope);
            if (position is { } boundary && boundary.First != id) throw InvalidInboxCursor();
            var unread = shared ? AdminUnread : "0::bigint";
            var join = shared ? AdminReadJoin : "";
            await using var query = Store.Sql(db, tx, $"""
                SELECT c.id,c.account_id,c.subject,c.status,c.is_system,{InboxStore.ConversationActivity},
                    m.id,m.sender,m.is_internal,m.sent_at,m.body,c.xmin::text,{unread}
                FROM public.inbox_conversation c
                {join}
                JOIN LATERAL (
                    SELECT id,sender,is_internal,sent_at,body FROM public.inbox_message WHERE conversation_id=c.id AND ($2=0 OR id<$2)
                    ORDER BY id DESC LIMIT $3
                ) m ON true WHERE c.id=$1 ORDER BY m.id DESC
                """, id, position?.Second ?? 0L, Wire.AdminInboxThreadSize + 1);
            await using var rows = await query.ExecuteReaderAsync(ct);
            AdminInboxRow? conversation = null;
            string? version = null;
            List<AdminInboxMessage> items = [];
            string? previous = null;
            while (await rows.ReadAsync(ct))
            {
                conversation ??= InboxRow(rows, 12);
                version ??= rows.GetString(11);
                if (items.Count == Wire.AdminInboxThreadSize)
                {
                    previous = new AdminInboxCursor(id, items[^1].Id).Encode(admin.Digest, scope);
                    break;
                }
                items.Add(new(rows.GetInt64(6), rows.GetInt16(7), rows.GetBoolean(8),
                    rows.GetFieldValue<DateTimeOffset>(9).ToUnixTimeMilliseconds(), rows.GetString(10)));
            }
            if (conversation is null) throw new BusinessException(Rejection.NotFound, "Administrator inbox conversation not found.");
            items.Reverse();
            var latestVisible = shared && older is null ? items.LastOrDefault(message => !message.Internal) : null;
            var read = latestVisible is null ? null : new AdminInboxCursor(id, latestVisible.Id).Encode(admin.Digest, InboxReadScope);
            return new AdminInboxThread(conversation, items, previous, version, read);
        }, ct);

    private static AdminInboxRow InboxRow(NpgsqlDataReader row, int unread) => new(row.GetInt64(0), row.GetGuid(1),
        row.GetString(2), row.GetInt16(3), row.GetBoolean(4), row.GetFieldValue<DateTimeOffset>(5).ToUnixTimeMilliseconds(),
        CountInboxUnread(row.GetInt64(unread)));

    private static AdminInboxCursor? InboxPosition(string? value, byte[] session, byte scope) => value is null ? null :
        AdminInboxCursor.TryDecode(value, session, scope, out var cursor) ? cursor : throw InvalidInboxCursor();

    private static BusinessException InvalidInboxCursor() => new(Rejection.Invalid, "The administrator inbox cursor is invalid or expired.");
}
