using System.Globalization;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Communication;
using FsusBlog.V2.Server.Security;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    internal Task<byte[]> ChangeInboxStatus(string? session, long id, string version, ConversationStatus target,
        string reason, byte[] frame, ScopedPow pow, HttpContext http, bool issue, CancellationToken ct) =>
        WithLiveAdmin(session, async (db, tx, admin) =>
        {
            const PowScope scope = PowScope.AdminInboxStatus;
            var context = string.Create(CultureInfo.InvariantCulture, $"{id}:{version}");
            reason = reason.Trim();
            if (reason.Length is < 1 or > 256 || reason.Contains('\0'))
                throw new BusinessException(Rejection.Invalid, "Enter a status reason from 1 to 256 characters.");
            var source = ScopedPow.Source(http);
            if (!issue)
                await pow.Consume(db, tx, scope, context, session!, source, frame, ScopedPow.ReadProof(http), ct);

            await using var find = Store.Sql(db, tx, """
                SELECT account_id,status,xmin::text FROM public.inbox_conversation WHERE id=$1 AND last_message_id IS NOT NULL
                """, id);
            Guid recipient;
            ConversationStatus observed;
            await using (var row = await find.ExecuteReaderAsync(ct))
            {
                if (!await row.ReadAsync(ct))
                    throw new BusinessException(Rejection.NotFound, "Administrator inbox conversation not found.");
                recipient = row.GetGuid(0);
                observed = (ConversationStatus)row.GetInt16(1);
                if (issue && observed != target && row.GetString(2) != version)
                    throw new BusinessException(Rejection.Conflict, "The conversation changed. Reload it.");
            }
            if (issue)
                return PowWire.EncodeChallenge(pow.Issue(scope, context, session!, source, ScopedPow.ReadClientNonce(http), frame));
            if (observed == target)
                return InboxWire.EncodeAdminStatusResult((int)target, (int)target);

            var (previous, changed) = await new InboxStore(db, tx, recipient).ChangeAdministratorStatus(id, version, target, ct);
            if (changed)
            {
                await using var audit = Store.Sql(db, tx, """
                    INSERT INTO public.inbox_admin_status (conversation_id,principal_id,session_reference,previous_status,current_status,reason,happened_at)
                    VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())
                    """, id, admin.Id, SHA256.HashData(admin.Digest), (short)previous, (short)target, reason);
                await audit.ExecuteNonQueryAsync(ct);
            }
            return InboxWire.EncodeAdminStatusResult((int)previous, (int)target);
        }, ct);
}
