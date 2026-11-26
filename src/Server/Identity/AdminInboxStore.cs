using static FsusBlog.V2.Server.SqlCommands;

namespace FsusBlog.V2.Server.Administration;

internal readonly record struct AdminInboxCursor(long First, long Second)
{
    internal string Encode(byte[] session, byte scope) => AdminInboxCursorAuth.Encode(session, scope, [First, Second]);

    internal static bool TryDecode(string value, byte[] session, byte scope, out AdminInboxCursor cursor)
    {
        cursor = default;
        Span<long> coordinates = stackalloc long[2];
        if (!AdminInboxCursorAuth.TryRead(value, 64, session, scope, coordinates)) return false;
        cursor = new(coordinates[0], coordinates[1]);
        return cursor.First > 0 && cursor.Second >= 0;
    }
}

internal readonly record struct AdminInboxActivityCursor(long Snapshot, DateTimeOffset At, long Conversation)
{
    internal const int EncodedLength = 75;

    internal string Encode(byte[] session, byte scope) =>
        AdminInboxCursorAuth.Encode(session, scope, [Snapshot, At.UtcTicks, Conversation]);

    internal static bool TryDecode(string value, byte[] session, byte scope, out AdminInboxActivityCursor cursor)
    {
        cursor = default;
        Span<long> coordinates = stackalloc long[3];
        if (!AdminInboxCursorAuth.TryRead(value, EncodedLength, session, scope, coordinates)) return false;
        var (snapshot, ticks, conversation) = (coordinates[0], coordinates[1], coordinates[2]);
        if (snapshot <= 0 || conversation <= 0 || ticks <= 0 || ticks > DateTimeOffset.MaxValue.Ticks) return false;
        cursor = new(snapshot, new DateTimeOffset(ticks, TimeSpan.Zero), conversation);
        return true;
    }
}

internal static class AdminInboxCursorAuth
{
    private static readonly byte[] Key = RandomNumberGenerator.GetBytes(32);

    internal static string Encode(byte[] session, byte scope, ReadOnlySpan<long> coordinates)
    {
        var payloadLength = sizeof(long) * coordinates.Length;
        Span<byte> token = stackalloc byte[payloadLength + SHA256.HashSizeInBytes];
        for (var i = 0; i < coordinates.Length; i++)
            BinaryPrimitives.WriteInt64LittleEndian(token[(i * sizeof(long))..], coordinates[i]);
        Sign(session, scope, token[..payloadLength], token[payloadLength..]);
        return WebEncoders.Base64UrlEncode(token);
    }

    internal static bool TryRead(string value, int encodedLength, byte[] session, byte scope, Span<long> coordinates)
    {
        var payloadLength = sizeof(long) * coordinates.Length;
        if (value.Length != encodedLength || value.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_')) return false;
        var token = WebEncoders.Base64UrlDecode(value);
        if (WebEncoders.Base64UrlEncode(token) != value) return false;
        Span<byte> digest = stackalloc byte[SHA256.HashSizeInBytes];
        Sign(session, scope, token.AsSpan(0, payloadLength), digest);
        if (!CryptographicOperations.FixedTimeEquals(token.AsSpan(payloadLength), digest)) return false;
        for (var i = 0; i < coordinates.Length; i++)
            coordinates[i] = BinaryPrimitives.ReadInt64LittleEndian(token.AsSpan(i * sizeof(long)));
        return true;
    }

    private static void Sign(byte[] session, byte scope, ReadOnlySpan<byte> payload, Span<byte> digest)
    {
        Span<byte> binding = stackalloc byte[SHA256.HashSizeInBytes + 1 + payload.Length];
        session.AsSpan().CopyTo(binding);
        binding[SHA256.HashSizeInBytes] = scope;
        payload.CopyTo(binding[(SHA256.HashSizeInBytes + 1)..]);
        HMACSHA256.HashData(Key, binding, digest);
    }
}

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

            if (await Scalar(db, tx, ct, """
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

            return CountInboxUnread((long)(await Scalar(db, tx, ct,
                $"SELECT {AdminUnread} FROM public.inbox_conversation c {AdminReadJoin} WHERE c.id=$1", id))!);
        }, ct);

    internal static int CountInboxUnread(long count) => (int)Math.Min(int.MaxValue, count);
}

internal sealed class AdminInboxStatusStore(AdminSessionGate gate)
{
    internal Task<byte[]> ChangeInboxStatus(string? session, long id, string version, ConversationStatus target,
        string reason, byte[] frame, ScopedPow pow, HttpContext http, bool issue, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            const PowScope scope = PowScope.AdminInboxStatus;
            var context = string.Create(CultureInfo.InvariantCulture, $"{id}:{version}");
            reason = reason.Trim();
            if (reason.Length is < 1 or > 256 || reason.Contains('\0'))
                throw new BusinessException(Rejection.Invalid, "Enter a status reason from 1 to 256 characters.");
            var source = ScopedPow.Source(http);
            if (!issue)
                await pow.Consume(db, tx, scope, context, session!, source, frame, ScopedPow.ReadProof(http), ct);

            var (recipient, observed) = await QueryRequired(db, tx, ct, """
                SELECT account_id,status,xmin::text FROM public.inbox_conversation WHERE id=$1 AND last_message_id IS NOT NULL
                """, row =>
            {
                var status = (ConversationStatus)row.GetInt16(1);
                if (issue && status != target && row.GetString(2) != version)
                    throw new BusinessException(Rejection.Conflict, "The conversation changed. Reload it.");
                return (row.GetGuid(0), status);
            }, AdminInboxStore.ConversationNotFound, id);
            if (issue)
                return PowWire.EncodeChallenge(pow.Issue(scope, context, session!, source, ScopedPow.ReadClientNonce(http), frame));
            if (observed == target) return InboxWire.EncodeAdminStatusResult((int)target, (int)target);

            var (previous, changed) = await new InboxStore(db, tx, recipient).ChangeAdministratorStatus(id, version, target, ct);
            if (changed)
                await Execute(db, tx, ct, """
                    INSERT INTO public.inbox_admin_status (conversation_id,principal_id,session_reference,previous_status,current_status,reason,happened_at)
                    VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())
                    """, id, admin.Id, SHA256.HashData(admin.Digest), (short)previous, (short)target, reason);
            return InboxWire.EncodeAdminStatusResult((int)previous, (int)target);
        }, ct);
}

internal sealed class AdminInboxActivityStore(AdminSessionGate gate)
{
    internal async Task<AdminInboxPage> ReadInboxByActivity(string? token, int filter, string? next, bool shared, CancellationToken ct)
    {
        var initial = next is null ? await gate.WithLiveAdmin(token, (db, tx, _) => InboxActivityFence.SnapshotAsync(db, tx, ct), ct) : 0L;
        return await gate.WithLiveAdmin(token, async (db, tx, admin) =>
        {
            var scope = checked((byte)(filter + (shared ? 41 : 33)));
            AdminInboxActivityCursor? position = next is null ? null :
                AdminInboxActivityCursor.TryDecode(next, admin.Digest, scope, out var parsed) ? parsed : throw AdminInboxStore.InvalidInboxCursor();
            long snapshot = position?.Snapshot ?? initial;
            if (snapshot == 0) return new AdminInboxPage([], null);

            var unread = shared ? AdminInboxReadStore.AdminUnread : "0::bigint";
            var join = shared ? AdminInboxReadStore.AdminReadJoin : "";
            var filterUnread = filter == 3 ? AdminInboxReadStore.AdminUnread : "0::bigint";
            var pendingJoin = filter == 3 ? AdminInboxReadStore.AdminReadJoin : "";
            var rows = await QueryList(db, tx, ct, $"""
                WITH page AS MATERIALIZED (
                    SELECT c.id,last_visible.sent_at
                    FROM public.inbox_conversation c {pendingJoin}
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
                FROM page JOIN public.inbox_conversation c ON c.id=page.id {join}
                ORDER BY page.sent_at DESC,c.id DESC
                """, r => (Row: AdminInboxStore.InboxRow(r, 6), At: r.GetFieldValue<DateTimeOffset>(7)),
                snapshot, position?.Conversation ?? 0L, position?.At ?? DateTimeOffset.UnixEpoch, filter, Wire.AdminInboxPageSize + 1);
            var hasMore = rows.Count > Wire.AdminInboxPageSize;
            var items = rows.Take(Wire.AdminInboxPageSize).Select(entry => entry.Row).ToList();
            var cursor = hasMore ? new AdminInboxActivityCursor(snapshot, rows[Wire.AdminInboxPageSize - 1].At, items[^1].Id).Encode(admin.Digest, scope) : null;
            return new AdminInboxPage(items, cursor);
        }, ct);
    }
}

internal sealed class AdminInboxNoticeStore(AdminSessionGate gate)
{
    internal Task<byte[]> SendInboxNotice(string? session, long eventId, AdminInboxNotice input, byte[] frame,
        ScopedPow pow, HttpContext http, bool issue, bool fenceVisibleMessages, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            const PowScope scope = PowScope.AdminInboxNotice;
            var (subject, body) = (InboxRules.Subject(input.Subject, system: true), InboxRules.Body(input.Body));
            var source = ScopedPow.Source(http);
            var context = string.Create(CultureInfo.InvariantCulture, $"{input.Account:D}:{eventId}");
            if (issue)
                return PowWire.EncodeChallenge(pow.Issue(scope, context, session!, source, ScopedPow.ReadClientNonce(http), frame));

            await pow.Consume(db, tx, scope, context, session!, source, frame, ScopedPow.ReadProof(http), ct);
            await Store.LockCommand(db, tx, Guid.Empty,
                new Guid(InboxRules.Fingerprint("administrator-system-notice", eventId, 0, "", "").AsSpan(0, 16)), ct);
            var fingerprint = InboxRules.Fingerprint("system", 0, 0, subject, body);
            var replay = await QueryOneValue(db, tx, ct, """
                SELECT principal_id,account_id,fingerprint,conversation_id FROM public.inbox_admin_notice WHERE source_event_id=$1
                """, r => r.GetGuid(0) == admin.Id && r.GetGuid(1) == input.Account &&
                    CryptographicOperations.FixedTimeEquals(r.GetFieldValue<byte[]>(2), fingerprint)
                    ? r.GetInt64(3)
                    : throw new BusinessException(Rejection.Conflict, "The source event was used for a different request."), eventId);
            var inbox = new InboxStore(db, tx, input.Account, fenceVisibleMessages);
            long conversation = replay ?? await CreateNotice();
            var current = await inbox.GetAsync(conversation, null, 50, ct) ??
                throw new InvalidOperationException("Administrator system notice has no account-visible conversation.");
            return InboxEndpoints.EncodeDetail(current, checked((int)current.UnreadCount), system: true,
                createResponse: true, replayed: replay.HasValue);

            async Task<long> CreateNotice()
            {
                var sent = await inbox.SendAttributedNotice(subject, body, ct);
                await Execute(db, tx, ct, """
                    INSERT INTO public.inbox_admin_notice
                        (source_event_id,account_id,conversation_id,message_id,principal_id,session_reference,fingerprint,sent_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                    """, eventId, input.Account, sent.ConversationId, sent.Id, admin.Id, SHA256.HashData(admin.Digest),
                    fingerprint, sent.SentAt);
                return sent.ConversationId;
            }
        }, ct);
}

internal sealed class AdminInboxReplyStore(AdminSessionGate gate)
{
    private sealed record SavedInboxReply(long Id, int Sender, string Body, DateTimeOffset At);

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
                await Store.LockCommand(db, tx, admin.Id, new(InboxRules.Fingerprint("admin-inbox-command", 0, 0, "", key).AsSpan(0, 16)), ct);
                await pow.Consume(db, tx, scope, context, session!, source, frame, proof, ct);
            }

            var previous = await QueryOne(db, tx, ct, """
                SELECT r.fingerprint,m.id,m.sender,m.body,m.sent_at FROM public.inbox_admin_reply r
                JOIN public.inbox_message m ON (m.conversation_id,m.id)=(r.conversation_id,r.message_id)
                WHERE r.principal_id=$1 AND r.command_id=$2 AND NOT m.is_internal AND m.sender=1
                """, r => CryptographicOperations.FixedTimeEquals(fingerprint, r.GetFieldValue<byte[]>(0))
                    ? new SavedInboxReply(r.GetInt64(1), r.GetInt16(2), r.GetString(3), r.GetFieldValue<DateTimeOffset>(4))
                    : throw new BusinessException(Rejection.Conflict, "This command key was used for a different request."),
                admin.Id, key);
            if (issue)
            {
                if (previous is null) await FindInboxRecipient(db, tx, id, ct);
                return PowWire.EncodeChallenge(pow.Issue(scope, context, session!, source, ScopedPow.ReadClientNonce(http), frame));
            }
            if (previous is not null)
                return InboxWire.EncodeMessage(new(previous.Id, id, previous.Sender, previous.At, previous.Body, admin.Snapshot.Handle, Replayed: true));

            var recipient = await FindInboxRecipient(db, tx, id, ct);
            var appended = await new InboxStore(db, tx, recipient, fenceVisibleMessages).AppendAdministratorReply(id, body, ct);
            await Execute(db, tx, ct, """
                INSERT INTO public.inbox_admin_reply (principal_id,command_id,fingerprint,session_reference,conversation_id,message_id)
                VALUES ($1,$2,$3,$4,$5,$6)
                """, admin.Id, key, fingerprint, SHA256.HashData(admin.Digest), id, appended.Id);
            return InboxWire.EncodeMessage(new(appended.Id, id, (int)appended.Sender, appended.SentAt, appended.Body, admin.Snapshot.Handle));
        }, ct);

    private static Task<Guid> FindInboxRecipient(NpgsqlConnection db, NpgsqlTransaction tx, long id, CancellationToken ct) =>
        QueryRequired(db, tx, ct, "SELECT account_id,status FROM public.inbox_conversation WHERE id=$1",
            row => (ConversationStatus)row.GetInt16(1) == ConversationStatus.Closed
                ? throw new BusinessException(Rejection.Conflict, "The conversation is closed.") : row.GetGuid(0),
            AdminInboxStore.ConversationNotFound, id);
}

internal sealed class AdminInboxStore(AdminSessionGate gate)
{
    private const string InboxStatusHead = """
        coalesce((SELECT s.id FROM public.inbox_admin_status s WHERE s.conversation_id=c.id ORDER BY s.id DESC LIMIT 1), 0)
        """;

    internal Task<string> InboxQueuePosition(string? token, int filter, bool statusEnabled, CancellationToken ct) =>
        gate.WithLiveAdmin(token, async (db, tx, _) => (string)(await Scalar(db, tx, ct, $"""
            SELECT coalesce(string_agg(visible.position, ',' ORDER BY visible.id DESC), '')
            FROM (
                SELECT c.id,concat_ws(':',c.id,c.status,c.last_message_id,{(statusEnabled ? InboxStatusHead : "0")}) AS position
                FROM public.inbox_conversation c
                WHERE c.last_message_id IS NOT NULL
                    AND CASE $1 WHEN -1 THEN true WHEN 4 THEN c.is_system ELSE c.status=$1 END
                ORDER BY c.id DESC LIMIT $2
            ) visible
            """, filter, Wire.AdminInboxPageSize + 1))!, ct);

    internal Task<string> InboxThreadPosition(string? token, long id, bool statusEnabled, CancellationToken ct) =>
        gate.WithLiveAdmin(token, async (db, tx, _) => await Scalar(db, tx, ct, $"""
            SELECT concat_ws(':',c.status,c.last_message_id,{(statusEnabled ? InboxStatusHead : "0")})
            FROM public.inbox_conversation c WHERE c.id=$1 AND NOT c.is_system AND c.last_message_id IS NOT NULL
            """, id) is string position ? position : throw ConversationNotFound(), ct);

    internal Task<AdminInboxPage> ReadInbox(string? token, int filter, string? next, CancellationToken ct, bool shared = false) =>
        gate.WithLiveAdmin(token, async (db, tx, admin) =>
        {
            var scope = checked((byte)(filter + (shared ? 17 : 1)));
            var position = InboxPosition(next, admin.Digest, scope);
            var unread = shared ? AdminInboxReadStore.AdminUnread : "0::bigint";
            var join = shared ? AdminInboxReadStore.AdminReadJoin : "";
            var rows = await QueryList(db, tx, ct, $"""
                SELECT c.id,c.account_id,c.subject,c.status,c.is_system,{InboxStore.ConversationActivity},unread.count
                FROM public.inbox_conversation c {join}
                CROSS JOIN LATERAL (SELECT {unread} AS count) unread
                WHERE ($1=0 OR c.id<$1) AND c.last_message_id IS NOT NULL
                    AND CASE $2 WHEN -1 THEN true WHEN 3 THEN unread.count>0 WHEN 4 THEN c.is_system ELSE c.status=$2 END
                ORDER BY c.id DESC LIMIT $3
                """, r => InboxRow(r, 6), position?.First ?? 0L, filter, Wire.AdminInboxPageSize + 1);
            var hasMore = rows.Count > Wire.AdminInboxPageSize;
            if (hasMore) rows.RemoveAt(Wire.AdminInboxPageSize);
            return new AdminInboxPage(rows, hasMore ? new AdminInboxCursor(rows[^1].Id, 0).Encode(admin.Digest, scope) : null);
        }, ct);

    internal Task<AdminInboxThread> ReadInboxThread(string? token, long id, string? older, CancellationToken ct, bool shared = false) =>
        gate.WithLiveAdmin(token, async (db, tx, admin) =>
        {
            var scope = shared ? (byte)24 : (byte)8;
            var position = InboxPosition(older, admin.Digest, scope);
            if (position is { } boundary && boundary.First != id) throw InvalidInboxCursor();
            var unread = shared ? AdminInboxReadStore.AdminUnread : "0::bigint";
            var join = shared ? AdminInboxReadStore.AdminReadJoin : "";
            AdminInboxRow? conversation = null;
            string? version = null;
            List<AdminInboxMessage> items = [];
            string? previous = null;
            await ReadAll(db, tx, ct, $"""
                SELECT c.id,c.account_id,c.subject,c.status,c.is_system,{InboxStore.ConversationActivity},
                    m.id,m.sender,m.is_internal,m.sent_at,m.body,c.xmin::text,{unread}
                FROM public.inbox_conversation c {join}
                JOIN LATERAL (
                    SELECT id,sender,is_internal,sent_at,body FROM public.inbox_message WHERE conversation_id=c.id AND ($2=0 OR id<$2)
                    ORDER BY id DESC LIMIT $3
                ) m ON true WHERE c.id=$1 ORDER BY m.id DESC
                """, rows =>
            {
                conversation ??= InboxRow(rows, 12);
                version ??= rows.GetString(11);
                if (items.Count == Wire.AdminInboxThreadSize)
                {
                    previous ??= new AdminInboxCursor(id, items[^1].Id).Encode(admin.Digest, scope);
                    return;
                }
                items.Add(new(rows.GetInt64(6), rows.GetInt16(7), rows.GetBoolean(8), rows.GetUnixMilliseconds(9), rows.GetString(10)));
            }, id, position?.Second ?? 0L, Wire.AdminInboxThreadSize + 1);
            if (conversation is null) throw ConversationNotFound();
            items.Reverse();
            var latestVisible = shared && older is null ? items.LastOrDefault(message => !message.Internal) : null;
            var read = latestVisible is null ? null : new AdminInboxCursor(id, latestVisible.Id).Encode(admin.Digest, AdminInboxReadStore.InboxReadScope);
            return new AdminInboxThread(conversation, items, previous, version, read);
        }, ct);

    internal static AdminInboxRow InboxRow(NpgsqlDataReader row, int unread) => new(row.GetInt64(0), row.GetGuid(1),
        row.GetString(2), row.GetInt16(3), row.GetBoolean(4), row.GetUnixMilliseconds(5),
        AdminInboxReadStore.CountInboxUnread(row.GetInt64(unread)));

    private static AdminInboxCursor? InboxPosition(string? value, byte[] session, byte scope) => value is null ? null :
        AdminInboxCursor.TryDecode(value, session, scope, out var cursor) ? cursor : throw InvalidInboxCursor();

    internal static BusinessException ConversationNotFound() => new(Rejection.NotFound, "Administrator inbox conversation not found.");
    internal static BusinessException InvalidInboxCursor() => new(Rejection.Invalid, "The administrator inbox cursor is invalid or expired.");
}
