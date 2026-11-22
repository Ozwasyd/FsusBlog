using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Communication;
using FsusBlog.V2.Server.Security;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminInboxReplyStore(AdminSessionGate gate)
{
    internal Task<byte[]> ReplyInbox(string? session, long id, string key, string body, byte[] frame, ScopedPow pow,
        string context, HttpContext http, bool issue, bool fenceVisibleMessages, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            const PowScope scope = PowScope.AdminInboxReply;
            var fingerprint = InboxRules.Fingerprint("admin-reply", id, 0, "", body);
            var source = ScopedPow.Source(http);
            if (!issue)
            {
                var proof = ScopedPow.ReadProof(http);
                await Store.LockCommand(db, tx, admin.Id, ReplyLockKey(key), ct);
                await pow.Consume(db, tx, scope, context, session!, source, frame, proof, ct);
            }

            var previous = await FindInboxReply(db, tx, admin.Id, key, fingerprint, ct);
            if (issue)
            {
                if (previous is null) await FindInboxRecipient(db, tx, id, ct);
                return PowWire.EncodeChallenge(pow.Issue(scope, context, session!, source, ScopedPow.ReadClientNonce(http), frame));
            }
            if (previous is not null) return InboxWire.EncodeMessage(new(previous.Id, id, previous.Sender, previous.At,
                previous.Body, admin.Snapshot.Handle, Replayed: true));

            var recipient = await FindInboxRecipient(db, tx, id, ct);
            var appended = await new InboxStore(db, tx, recipient, fenceVisibleMessages).AppendAdministratorReply(id, body, ct);
            await SqlCommands.Execute(db, tx, ct, """
                INSERT INTO public.inbox_admin_reply (principal_id,command_id,fingerprint,session_reference,conversation_id,message_id)
                VALUES ($1,$2,$3,$4,$5,$6)
                """, admin.Id, key, fingerprint, SHA256.HashData(admin.Digest), id, appended.Id);
            return InboxWire.EncodeMessage(new(appended.Id, id, (int)appended.Sender, appended.SentAt, appended.Body, admin.Snapshot.Handle));
        }, ct);

    private static Guid ReplyLockKey(string command) => new(InboxRules.Fingerprint("admin-inbox-command", 0, 0, "", command).AsSpan(0, 16));

    private sealed record SavedInboxReply(long Id, int Sender, string Body, DateTimeOffset At);

    private static async Task<SavedInboxReply?> FindInboxReply(NpgsqlConnection db, NpgsqlTransaction tx, Guid principal,
        string key, byte[] fingerprint, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, """
            SELECT r.fingerprint,m.id,m.sender,m.body,m.sent_at FROM public.inbox_admin_reply r
            JOIN public.inbox_message m ON (m.conversation_id,m.id)=(r.conversation_id,r.message_id)
            WHERE r.principal_id=$1 AND r.command_id=$2 AND NOT m.is_internal AND m.sender=1
            """, principal, key);
        await using var rows = await query.ExecuteReaderAsync(ct);
        if (!await rows.ReadAsync(ct)) return null;
        if (!CryptographicOperations.FixedTimeEquals(fingerprint, rows.GetFieldValue<byte[]>(0)))
            throw new BusinessException(Rejection.Conflict, "This command key was used for a different request.");
        return new(rows.GetInt64(1), rows.GetInt16(2), rows.GetString(3), rows.GetFieldValue<DateTimeOffset>(4));
    }

    private static async Task<Guid> FindInboxRecipient(NpgsqlConnection db, NpgsqlTransaction tx, long id, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, "SELECT account_id,status FROM public.inbox_conversation WHERE id=$1", id);
        await using var row = await query.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw new BusinessException(Rejection.NotFound, "Administrator inbox conversation not found.");
        if ((ConversationStatus)row.GetInt16(1) == ConversationStatus.Closed)
            throw new BusinessException(Rejection.Conflict, "The conversation is closed.");
        return row.GetGuid(0);
    }
}
