using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    internal Task<AdminInboxPage> ReadInbox(string? token, int filter, string? next, CancellationToken ct) =>
        WithLiveAdmin(token, Permission, async (db, tx, admin) =>
        {
            var scope = checked((byte)(filter + 1));
            var position = InboxPosition(next, admin.Digest, scope);
            await using var query = Store.Sql(db, tx, $"""
                SELECT c.id,c.account_id,c.subject,c.status,c.is_system,{InboxStore.ConversationActivity}
                FROM public.inbox_conversation c WHERE ($1=0 OR c.id<$1) AND ($2<0 OR c.status=$2)
                    AND c.last_message_id IS NOT NULL
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
                items.Add(InboxRow(rows));
            }
            return new AdminInboxPage(items, cursor);
        }, ct);

    internal Task<AdminInboxThread> ReadInboxThread(string? token, long id, string? older, CancellationToken ct) =>
        WithLiveAdmin(token, Permission, async (db, tx, admin) =>
        {
            const byte scope = 8;
            var position = InboxPosition(older, admin.Digest, scope);
            if (position is { } boundary && boundary.First != id) throw InvalidInboxCursor();
            await using var query = Store.Sql(db, tx, $"""
                SELECT c.id,c.account_id,c.subject,c.status,c.is_system,{InboxStore.ConversationActivity},m.id,m.sender,m.is_internal,m.sent_at,m.body,c.xmin::text
                FROM public.inbox_conversation c
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
                conversation ??= InboxRow(rows);
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
            return new AdminInboxThread(conversation, items, previous, version);
        }, ct);

    private static AdminInboxRow InboxRow(NpgsqlDataReader row) => new(row.GetInt64(0), row.GetGuid(1), row.GetString(2),
        row.GetInt16(3), row.GetBoolean(4), row.GetFieldValue<DateTimeOffset>(5).ToUnixTimeMilliseconds());

    private static AdminInboxCursor? InboxPosition(string? value, byte[] session, byte scope) => value is null ? null :
        AdminInboxCursor.TryDecode(value, session, scope, out var cursor) ? cursor : throw InvalidInboxCursor();

    private static BusinessException InvalidInboxCursor() => new(Rejection.Invalid, "The administrator inbox cursor is invalid or expired.");
}
