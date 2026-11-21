using System.Globalization;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Communication;
using FsusBlog.V2.Server.Security;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminInboxNoticeStore(AdminSessionGate gate)
{
    internal Task<byte[]> SendInboxNotice(string? session, long eventId, AdminInboxNotice input, byte[] frame,
        ScopedPow pow, HttpContext http, bool issue, bool fenceVisibleMessages, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            const PowScope scope = PowScope.AdminInboxNotice;
            string subject = InboxRules.Subject(input.Subject, system: true);
            string body = InboxRules.Body(input.Body);
            var source = ScopedPow.Source(http);
            var context = string.Create(CultureInfo.InvariantCulture, $"{input.Account:D}:{eventId}");
            if (issue)
                return PowWire.EncodeChallenge(pow.Issue(scope, context, session!, source, ScopedPow.ReadClientNonce(http), frame));

            await pow.Consume(db, tx, scope, context, session!, source, frame, ScopedPow.ReadProof(http), ct);
            await Store.LockCommand(db, tx, Guid.Empty,
                new Guid(InboxRules.Fingerprint("administrator-system-notice", eventId, 0, "", "").AsSpan(0, 16)), ct);
            var fingerprint = InboxRules.Fingerprint("system", 0, 0, subject, body);
            var replay = await FindNotice(db, tx, admin.Id, eventId, input.Account, fingerprint, ct);
            var inbox = new InboxStore(db, tx, input.Account, fenceVisibleMessages);
            long conversation = replay ?? await CreateNotice();
            var current = await inbox.GetAsync(conversation, null, 50, ct) ??
                throw new InvalidOperationException("Administrator system notice has no account-visible conversation.");
            return InboxWire.EncodeDetail(new(current.Id, current.Subject, (int)current.Status, checked((int)current.UnreadCount),
                current.LastMessageAt, current.ReadSnapshot, true, current.Status != ConversationStatus.Closed,
                current.Messages.Select(message => new InboxMessageRecord(message.Id, current.Id, (int)message.Sender, message.SentAt,
                    message.Body, message.Sender switch
                    {
                        InboxSender.Account => "你",
                        InboxSender.Administrator => "管理员",
                        InboxSender.System => "系统",
                        _ => throw new InvalidOperationException("Unsupported inbox sender.")
                    })).ToArray(), Replayed: replay.HasValue), createResponse: true);

            async Task<long> CreateNotice()
            {
                var sent = await inbox.SendAttributedNotice(subject, body, ct);
                await using var audit = Store.Sql(db, tx, """
                    INSERT INTO public.inbox_admin_notice
                        (source_event_id,account_id,conversation_id,message_id,principal_id,session_reference,fingerprint,sent_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                    """, eventId, input.Account, sent.ConversationId, sent.Id, admin.Id, SHA256.HashData(admin.Digest),
                    fingerprint, sent.SentAt);
                await audit.ExecuteNonQueryAsync(ct);
                return sent.ConversationId;
            }
        }, ct);

    private static async Task<long?> FindNotice(NpgsqlConnection db, NpgsqlTransaction tx, Guid admin, long eventId,
        Guid account, byte[] fingerprint, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, """
            SELECT principal_id,account_id,fingerprint,conversation_id FROM public.inbox_admin_notice WHERE source_event_id=$1
            """, eventId);
        await using var row = await query.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) return null;
        if (row.GetGuid(0) != admin || row.GetGuid(1) != account ||
            !CryptographicOperations.FixedTimeEquals(row.GetFieldValue<byte[]>(2), fingerprint))
            throw new BusinessException(Rejection.Conflict, "The source event was used for a different request.");
        return row.GetInt64(3);
    }
}
