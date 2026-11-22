using System.Security.Cryptography;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminInboxReadStore(AdminSessionGate gate)
{
    internal const byte InboxReadScope = 9;
    internal const string AdminReadJoin = "LEFT JOIN public.inbox_admin_read r ON r.conversation_id=c.id";
    internal const string AdminUnread = """
        (SELECT count(*) FROM public.inbox_message unread
         WHERE unread.conversation_id=c.id AND NOT unread.is_internal AND unread.sender=0
           AND unread.id>coalesce(r.read_through,0))
        """;

    internal Task<int> AcknowledgeInboxRead(string? token, long id, long through, string snapshot, CancellationToken ct) =>
        gate.WithLiveAdmin(token, async (db, tx, admin) =>
        {
            if (!AdminInboxCursor.TryDecode(snapshot, admin.Digest, InboxReadScope, out var captured) ||
                captured.First != id || captured.Second != through)
                throw new BusinessException(Rejection.Conflict, "The administrator inbox snapshot expired. Reload this conversation.");

            if (await SqlCommands.Scalar(db, tx, ct, """
                WITH visible AS (
                    SELECT id FROM public.inbox_message WHERE conversation_id=$1 AND id=$2 AND NOT is_internal
                ), advanced AS (
                    INSERT INTO public.inbox_admin_read (conversation_id,read_through,read_at,principal_id,session_reference)
                    SELECT $1,id,clock_timestamp(),$3,$4 FROM visible
                    ON CONFLICT (conversation_id) DO UPDATE SET read_through=excluded.read_through,read_at=excluded.read_at,
                        principal_id=excluded.principal_id,session_reference=excluded.session_reference
                    WHERE inbox_admin_read.read_through<excluded.read_through
                )
                SELECT EXISTS (SELECT FROM visible)
                """, id, through, admin.Id, SHA256.HashData(admin.Digest)) is not true)
                throw new BusinessException(Rejection.NotFound, "Administrator inbox snapshot not found.");

            return CountInboxUnread((long)(await SqlCommands.Scalar(db, tx, ct, $"""
                SELECT {AdminUnread} FROM public.inbox_conversation c {AdminReadJoin} WHERE c.id=$1
                """, id))!);
        }, ct);

    internal static int CountInboxUnread(long count) => (int)Math.Min(int.MaxValue, count);
}
