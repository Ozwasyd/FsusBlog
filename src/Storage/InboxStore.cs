using System.Security.Cryptography;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Communication;

namespace FsusBlogV2.Storage;

internal sealed class InboxStore(NpgsqlConnection connection, NpgsqlTransaction transaction, Guid accountId,
    bool fenceVisibleMessages = false)
{
    internal const string ConversationActivity = """
        greatest(c.last_message_at, (SELECT e.occurred_at FROM public.inbox_event e
            WHERE e.account_id=c.account_id AND e.conversation_id=c.id AND e.kind=12 ORDER BY e.sequence DESC LIMIT 1))
        """;
    private const string Unread = """
        (SELECT count(*) FROM public.inbox_message unread
         WHERE unread.conversation_id = c.id AND NOT unread.is_internal AND unread.sender <> 0
           AND unread.id > coalesce(c.read_through, 0))
        """;

    public async Task<InboxPage> ListAsync(InboxCursor? cursor, int size, string? filter, CancellationToken cancellationToken)
    {
        var take = PageSize(size, 50);
        if (cursor is { SnapshotMessageId: <= 0 } or { ConversationId: <= 0 }) throw Invalid("Invalid conversation cursor.");
        var selected = filter?.Trim().ToLowerInvariant() switch
        {
            "unread" => "unread_count > 0", "system" => "is_system", "open" => "status = 0",
            "pending" => "status = 1", "closed" => "status = 2", _ => "true"
        };
        List<InboxSummary> rows = [];
        long position = 0, snapshot = 0, total = 0;
        await ReadAll($"""
            WITH position AS (
                SELECT coalesce(nullif(@snapshot, 0), max(last_message_id), 0) AS snapshot
                FROM public.inbox_conversation WHERE account_id = @account
            ), selected AS MATERIALIZED (
                SELECT c.id, c.subject, c.status, c.is_system, {Unread} AS unread_count, m.id AS message_id, m.sent_at
                FROM public.inbox_conversation c CROSS JOIN position pos
                JOIN LATERAL (
                    SELECT id, sent_at FROM public.inbox_message
                    WHERE conversation_id = c.id AND id <= pos.snapshot AND NOT is_internal ORDER BY id DESC LIMIT 1
                ) m ON true WHERE c.account_id = @account
            ), filtered AS MATERIALIZED (SELECT * FROM selected WHERE {selected})
            SELECT coalesce(h.last_sequence, 0), pos.snapshot, (SELECT count(*) FROM filtered),
                   p.id, p.subject, p.status, p.is_system, p.unread_count, {ConversationActivity}, p.sent_at, m.sender, m.body
            FROM position pos LEFT JOIN public.inbox_delivery h ON h.account_id = @account
            LEFT JOIN LATERAL (
                SELECT * FROM filtered WHERE @before_id = 0 OR (sent_at, id) < (@before_time, @before_id)
                ORDER BY sent_at DESC, id DESC LIMIT @take
            ) p ON true
            LEFT JOIN public.inbox_conversation c ON (c.account_id,c.id)=(@account,p.id)
            LEFT JOIN public.inbox_message m ON (m.conversation_id, m.id) = (p.id, p.message_id)
            ORDER BY p.sent_at DESC, p.id DESC
            """, reader =>
        {
            (position, snapshot, total) = (reader.GetInt64(0), reader.GetInt64(1), reader.GetInt64(2));
            if (reader.IsDBNull(3)) return;
            rows.Add(new InboxSummary(reader.GetInt64(3), reader.GetString(4), (ConversationStatus)reader.GetInt16(5),
                reader.GetBoolean(6), reader.GetInt64(7), reader.GetFieldValue<DateTimeOffset>(9), reader.GetFieldValue<DateTimeOffset>(8),
                (InboxSender)reader.GetInt16(10), InboxRules.Preview(reader.GetString(11))));
        }, cancellationToken, ("snapshot", cursor?.SnapshotMessageId ?? 0L), ("before_time", cursor?.LastMessageAt ?? DateTimeOffset.UnixEpoch),
            ("before_id", cursor?.ConversationId ?? 0L), ("take", take));
        InboxCursor? next = TrimPage(rows, size) ? new(snapshot, rows[^1].LastMessageAt, rows[^1].Id) : null;
        return new InboxPage(rows, total, next, position);
    }

    public Task<InboxDetail?> GetAsync(long conversationId, long? before, int size, CancellationToken cancellationToken)
        => ThreadAsync(conversationId, before, delta: false, size, cancellationToken);

    public Task<InboxDetail?> DeltaAsync(long conversationId, long after, int size, CancellationToken cancellationToken)
        => ThreadAsync(conversationId, Positive(after), delta: true, size, cancellationToken);

    private async Task<InboxDetail?> ThreadAsync(long conversationId, long? cursor, bool delta, int size, CancellationToken cancellationToken)
    {
        var take = PageSize(size, 100);
        var direction = delta ? "ASC" : "DESC";
        await using var action = Command($"""
            SELECT c.subject, c.status, c.is_system, c.read_through, {Unread}, c.last_message_at, m.id, m.sender, m.body, m.sent_at
            FROM public.inbox_conversation c
            LEFT JOIN LATERAL (
                SELECT id, sender, body, sent_at FROM public.inbox_message
                WHERE conversation_id = c.id AND (@cursor = 0 OR id {(delta ? ">" : "<")} @cursor) AND NOT is_internal
                ORDER BY id {direction} LIMIT @take
            ) m ON true WHERE c.id = @id AND c.account_id = @account ORDER BY m.id {direction}
            """, ("id", Positive(conversationId)), ("cursor", cursor is long position ? Positive(position) : 0L), ("take", take));
        await using var reader = await action.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        var (subject, status, system, readThrough, unread, lastMessageAt) = (reader.GetString(0), (ConversationStatus)reader.GetInt16(1),
            reader.GetBoolean(2), reader.IsDBNull(3) ? (long?)null : reader.GetInt64(3), reader.GetInt64(4), reader.GetFieldValue<DateTimeOffset>(5));
        List<InboxMessage> messages = [];
        do
        {
            if (!reader.IsDBNull(6))
                messages.Add(new InboxMessage(reader.GetInt64(6), conversationId, (InboxSender)reader.GetInt16(7), reader.GetString(8), reader.GetFieldValue<DateTimeOffset>(9)));
        } while (await reader.ReadAsync(cancellationToken));

        if (messages.Count == 0)
            return delta ? new InboxDetail(conversationId, subject, status, system, unread, lastMessageAt, readThrough, cursor!.Value, null, []) : null;
        var previous = TrimPage(messages, size) ? messages[^1].Id : (long?)null;
        if (!delta) messages.Reverse();
        return new InboxDetail(conversationId, subject, status, system, unread, lastMessageAt, readThrough, messages[^1].Id, previous, messages);
    }

    public Task<InboxMutation> CreateAsync(string commandId, string subject, string body, CancellationToken cancellationToken)
        => StartAsync(InboxRules.CommandId(commandId), subject, body, InboxSender.Account, cancellationToken);

    internal async Task<InboxMutation> SendNoticeAsync(string producerEventId, string subject, string body, CancellationToken cancellationToken)
    {
        await RequireNoticeRecipient(cancellationToken);
        return await StartAsync(InboxRules.CommandId(producerEventId), subject, body, InboxSender.System, cancellationToken);
    }

    internal async Task<InboxMessage> SendAttributedNotice(string subject, string body, CancellationToken ct)
    {
        await RequireNoticeRecipient(ct);
        await LockDeliveryAsync(ct);
        return await StartConversation(InboxRules.Subject(subject, system: true), InboxRules.Body(body), InboxSender.System, ct);
    }

    private async Task RequireNoticeRecipient(CancellationToken ct)
    {
        if (await Scalar("SELECT id FROM public.blog_user WHERE id = @account AND enabled FOR SHARE", ct) is null)
            throw new BusinessException(Rejection.NotFound, "Inbox account not found.");
    }

    private async Task<InboxMutation> StartAsync(string commandId, string subject, string body, InboxSender sender, CancellationToken cancellationToken)
    {
        var system = sender == InboxSender.System;
        subject = InboxRules.Subject(subject, system);
        body = InboxRules.Body(body);
        var fingerprint = InboxRules.Fingerprint("create", 0, 0, subject, body);
        await LockDeliveryAsync(cancellationToken);
        if (await FindCommandAsync(commandId, system, fingerprint, cancellationToken) is { } replay) return replay;
        var message = await StartConversation(subject, body, sender, cancellationToken);
        await RecordCommandAsync(commandId, system, fingerprint, message, cancellationToken);
        return new InboxMutation(message, Replayed: false);
    }

    private async Task<InboxMessage> StartConversation(string subject, string body, InboxSender sender, CancellationToken cancellationToken)
    {
        var system = sender == InboxSender.System;
        var conversationId = (long)(await Scalar("""
            INSERT INTO public.inbox_conversation (account_id, subject, status, is_system, last_message_at)
            VALUES (@account, @subject, 0, @system, clock_timestamp()) RETURNING id
            """, cancellationToken, ("subject", subject), ("system", system)))!;
        var message = await AppendAsync(conversationId, sender, body, cancellationToken);
        if (!system) await SetReadAsync(conversationId, message.Id, cancellationToken);
        await RecordEventAsync(InboxEventKind.ConversationUpsert, message.ConversationId, message.Id, cancellationToken);
        if (system) await RecordEventAsync(InboxEventKind.MessageAppend, message.ConversationId, message.Id, cancellationToken);
        return message;
    }

    public async Task<InboxMutation> ReplyAsync(long conversationId, long readThrough, string commandId, string body, CancellationToken cancellationToken)
    {
        Positive(conversationId);
        Positive(readThrough);
        commandId = InboxRules.CommandId(commandId);
        body = InboxRules.Body(body);
        var fingerprint = InboxRules.Fingerprint("reply", conversationId, readThrough, "", body);
        await LockDeliveryAsync(cancellationToken);
        if (await FindCommandAsync(commandId, false, fingerprint, cancellationToken) is { } replay) return replay;
        var (status, currentRead) = await ReadConversationAsync(conversationId, cancellationToken);
        if (status == ConversationStatus.Closed) throw new BusinessException(Rejection.Conflict, "The conversation is closed.");
        var changed = await AdvanceAsync(conversationId, readThrough, currentRead, cancellationToken);
        var message = await AppendAsync(conversationId, InboxSender.Account, body, cancellationToken);
        await RecordCommandAsync(commandId, false, fingerprint, message, cancellationToken);
        if (changed) await RecordEventAsync(InboxEventKind.ReadUpdated, conversationId, readThrough, cancellationToken);
        await RecordEventAsync(InboxEventKind.MessageAppend, conversationId, message.Id, cancellationToken);
        await RecordEventAsync(InboxEventKind.ConversationUpsert, conversationId, message.Id, cancellationToken);
        return new InboxMutation(message, Replayed: false);
    }

    internal async Task AdmitReply(long conversationId, long readThrough, string commandId, string body, CancellationToken token)
    {
        Positive(conversationId);
        Positive(readThrough);
        if (await FindCommandAsync(commandId, false, InboxRules.Fingerprint("reply", conversationId, readThrough, "", InboxRules.Body(body)), token) is not null) return;
        var (status, current) = await ReadConversationAsync(conversationId, token);
        if (status == ConversationStatus.Closed) throw new BusinessException(Rejection.Conflict, "The conversation is closed.");
        await CheckReadTarget(conversationId, readThrough, current, token);
    }

    internal async Task<InboxMessage> AppendAdministratorReply(long conversationId, string body, CancellationToken ct)
    {
        await LockDeliveryAsync(ct);
        var (status, _) = await ReadConversationAsync(conversationId, ct);
        if (status == ConversationStatus.Closed) throw new BusinessException(Rejection.Conflict, "The conversation is closed.");
        var message = await AppendAsync(conversationId, InboxSender.Administrator, InboxRules.Body(body), ct);
        await RecordEventAsync(InboxEventKind.ConversationUpsert, conversationId, message.Id, ct);
        await RecordEventAsync(InboxEventKind.MessageAppend, conversationId, message.Id, ct);
        return message;
    }

    internal async Task<(ConversationStatus Previous, bool Changed)> ChangeAdministratorStatus(long conversationId,
        string expected, ConversationStatus target, CancellationToken ct)
    {
        await LockDeliveryAsync(ct);
        var (before, xmin, message) = await QueryRequired("""
            SELECT c.status,c.xmin::text,
                (SELECT m.id FROM public.inbox_message m WHERE m.conversation_id=c.id AND NOT m.is_internal ORDER BY m.id DESC LIMIT 1)
            FROM public.inbox_conversation c WHERE c.id=@id AND c.account_id=@account FOR UPDATE OF c
            """, row => ((ConversationStatus)row.GetInt16(0), row.GetString(1), row.IsDBNull(2) ? (long?)null : row.GetInt64(2)),
            static () => new BusinessException(Rejection.NotFound, "Conversation not found."), ct, ("id", conversationId));
        if (before == target) return (before, false);
        if (xmin != expected) throw new BusinessException(Rejection.Conflict, "The conversation changed. Reload it.");
        if (before == ConversationStatus.Closed && target != ConversationStatus.Open)
            throw new BusinessException(Rejection.Conflict, "This conversation status transition is not allowed.");
        if (message is not { } msgId) throw new BusinessException(Rejection.NotFound, "Conversation not found.");
        await Exec("UPDATE public.inbox_conversation SET status=@status WHERE id=@id AND account_id=@account", ct, ("status", (short)target), ("id", conversationId));
        await RecordEventAsync(InboxEventKind.ConversationUpsert, conversationId, msgId, ct);
        return (before, true);
    }

    public async Task<InboxReadState> MarkReadAsync(long conversationId, long readThrough, CancellationToken cancellationToken)
    {
        Positive(conversationId);
        Positive(readThrough);
        await LockDeliveryAsync(cancellationToken);
        var (_, currentRead) = await ReadConversationAsync(conversationId, cancellationToken);
        if (await AdvanceAsync(conversationId, readThrough, currentRead, cancellationToken))
            await RecordEventAsync(InboxEventKind.ReadUpdated, conversationId, readThrough, cancellationToken);
        return new InboxReadState(readThrough, (long)(await Scalar(
            $"SELECT {Unread} FROM public.inbox_conversation c WHERE c.account_id = @account AND c.id = @id", cancellationToken, ("id", conversationId)))!);
    }

    internal async Task<long> ReplayPositionAsync(CancellationToken ct) =>
        (long)(await Scalar("select coalesce((select last_sequence from public.inbox_delivery where account_id=@account),0)", ct))!;

    public async Task<InboxReplay> ReplayAsync(long after, int size, CancellationToken cancellationToken)
    {
        if (after < 0) throw Invalid("Invalid notification position.");
        var take = PageSize(size, 512);
        List<InboxEvent> events = [];
        long next = after, head = 0;
        var gap = false;
        await ReadAll("""
            SELECT coalesce(h.last_sequence, 0), e.sequence, e.kind, e.conversation_id, e.message_id, e.occurred_at
            FROM (VALUES (@account)) AS recipient(id)
            LEFT JOIN public.inbox_delivery h ON h.account_id = recipient.id
            LEFT JOIN LATERAL (
                SELECT e.sequence, e.kind, e.conversation_id, e.message_id, e.occurred_at
                FROM public.inbox_event e JOIN public.inbox_message m ON (m.conversation_id, m.id) = (e.conversation_id, e.message_id)
                WHERE e.account_id = recipient.id AND e.sequence > @after AND NOT m.is_internal ORDER BY e.sequence LIMIT @take
            ) e ON true ORDER BY e.sequence
            """, reader =>
        {
            if (gap) return;
            head = reader.GetInt64(0);
            if (reader.IsDBNull(1)) return;
            var sequence = reader.GetInt64(1);
            if (sequence - 1 != next) { gap = true; return; }
            events.Add(new InboxEvent(sequence, (InboxEventKind)reader.GetInt16(2), reader.GetInt64(3), reader.GetInt64(4), reader.GetFieldValue<DateTimeOffset>(5)));
            next = sequence;
        }, cancellationToken, ("after", after), ("take", take));
        if (gap) return new InboxReplay(head, false, true, []);
        var more = TrimPage(events, size);
        return next > head || (next < head && !more)
            ? new InboxReplay(head, false, true, [])
            : new InboxReplay(events.Count > 0 ? events[^1].Sequence : after, more, false, events);
    }

    private async Task LockDeliveryAsync(CancellationToken cancellationToken)
    {
        await Exec("INSERT INTO public.inbox_delivery (account_id, last_sequence) VALUES (@account, 0) ON CONFLICT (account_id) DO NOTHING", cancellationToken);
        await Scalar("SELECT last_sequence FROM public.inbox_delivery WHERE account_id = @account FOR UPDATE", cancellationToken);
    }

    private Task<(ConversationStatus Status, long? ReadThrough)> ReadConversationAsync(long conversationId, CancellationToken cancellationToken) =>
        QueryRequired("SELECT status, read_through FROM public.inbox_conversation WHERE account_id = @account AND id = @id FOR UPDATE",
            reader => ((ConversationStatus)reader.GetInt16(0), reader.IsDBNull(1) ? (long?)null : reader.GetInt64(1)),
            static () => new BusinessException(Rejection.NotFound, "Conversation not found."), cancellationToken, ("id", conversationId));

    private async Task<bool> AdvanceAsync(long conversationId, long requested, long? current, CancellationToken cancellationToken)
    {
        await CheckReadTarget(conversationId, requested, current, cancellationToken);
        if (current == requested) return false;
        await SetReadAsync(conversationId, requested, cancellationToken);
        return true;
    }

    private async Task CheckReadTarget(long conversationId, long requested, long? current, CancellationToken cancellationToken)
    {
        if (current > requested) throw new BusinessException(Rejection.Conflict, "The read position is already newer.");
        if (await Scalar("""
            SELECT 1 FROM public.inbox_message m JOIN public.inbox_conversation c ON c.id = m.conversation_id
            WHERE c.account_id = @account AND c.id = @id AND m.id = @requested AND NOT m.is_internal
            """, cancellationToken, ("id", conversationId), ("requested", requested)) is null)
            throw Invalid("The read position does not refer to a visible message in this conversation.");
    }

    private Task SetReadAsync(long conversationId, long readThrough, CancellationToken cancellationToken) =>
        Exec("UPDATE public.inbox_conversation SET read_through = @message WHERE account_id = @account AND id = @id",
            cancellationToken, ("id", conversationId), ("message", readThrough));

    private async Task<InboxMessage> AppendAsync(long conversationId, InboxSender sender, string body, CancellationToken cancellationToken)
    {
        if (fenceVisibleMessages) await InboxActivityFence.TakeAsync(connection, transaction, shared: true, cancellationToken);
        return await QueryRequired("""
            WITH added AS (
                INSERT INTO public.inbox_message (conversation_id, sender, is_internal, body, sent_at)
                SELECT id, @sender, false, @body, clock_timestamp() FROM public.inbox_conversation
                WHERE account_id = @account AND id = @id RETURNING id, sent_at
            )
            UPDATE public.inbox_conversation c SET last_message_id = added.id, last_message_at = added.sent_at
            FROM added WHERE c.account_id = @account AND c.id = @id RETURNING added.id, added.sent_at
            """, reader => new InboxMessage(reader.GetInt64(0), conversationId, sender, body, reader.GetFieldValue<DateTimeOffset>(1)),
            static () => new BusinessException(Rejection.NotFound, "Conversation not found."),
            cancellationToken, ("id", conversationId), ("sender", (short)sender), ("body", body));
    }

    private async Task<InboxMutation?> FindCommandAsync(string key, bool service, byte[] fingerprint, CancellationToken cancellationToken)
    {
        await using var existing = Command("""
            SELECT c.fingerprint, m.id, m.conversation_id, m.sender, m.body, m.sent_at
            FROM public.inbox_command c JOIN public.inbox_message m ON (m.conversation_id, m.id) = (c.conversation_id, c.message_id)
            WHERE c.account_id = @account AND c.command_id = @key AND c.is_service = @service AND NOT m.is_internal
            """, ("key", key), ("service", service));
        await using var reader = await existing.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        if (!CryptographicOperations.FixedTimeEquals(reader.GetFieldValue<byte[]>(0), fingerprint))
            throw new BusinessException(Rejection.Conflict, "This command key was used for a different request.");
        return new InboxMutation(new InboxMessage(reader.GetInt64(1), reader.GetInt64(2), (InboxSender)reader.GetInt16(3),
            reader.GetString(4), reader.GetFieldValue<DateTimeOffset>(5)), Replayed: true);
    }

    private Task RecordCommandAsync(string key, bool service, byte[] fingerprint, InboxMessage message, CancellationToken cancellationToken) =>
        Exec("""
            INSERT INTO public.inbox_command (account_id, is_service, command_id, fingerprint, conversation_id, message_id)
            VALUES (@account, @service, @key, @fingerprint, @conversation, @message)
            """, cancellationToken, ("key", key), ("service", service), ("fingerprint", fingerprint), ("conversation", message.ConversationId), ("message", message.Id));

    private Task RecordEventAsync(InboxEventKind kind, long conversationId, long messageId, CancellationToken cancellationToken) =>
        Exec("""
            WITH head AS (
                UPDATE public.inbox_delivery SET last_sequence = last_sequence + 1 WHERE account_id = @account RETURNING last_sequence
            ), written AS (
                INSERT INTO public.inbox_event (account_id, sequence, kind, conversation_id, message_id, occurred_at)
                SELECT @account, last_sequence, @kind, @conversation, @message, clock_timestamp() FROM head RETURNING 1
            )
            SELECT pg_catalog.pg_notify('fsus_v2_inbox', '') FROM written
            """, cancellationToken, ("kind", (short)kind), ("conversation", conversationId), ("message", messageId));

    private async Task Exec(string sql, CancellationToken ct, params (string Name, object Value)[] parameters)
    {
        await using var command = Command(sql, parameters);
        await command.ExecuteNonQueryAsync(ct);
    }

    private async Task<object?> Scalar(string sql, CancellationToken ct, params (string Name, object Value)[] parameters)
    {
        await using var command = Command(sql, parameters);
        return await command.ExecuteScalarAsync(ct);
    }

    private async Task<T> QueryRequired<T>(string sql, Func<NpgsqlDataReader, T> read, Func<Exception> missing, CancellationToken ct,
        params (string Name, object Value)[] parameters)
    {
        await using var command = Command(sql, parameters);
        await using var reader = await command.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) throw missing();
        return read(reader);
    }

    private async Task ReadAll(string sql, Action<NpgsqlDataReader> read, CancellationToken ct, params (string Name, object Value)[] parameters)
    {
        await using var command = Command(sql, parameters);
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) read(reader);
    }

    private NpgsqlCommand Command(string sql, params (string Name, object Value)[] parameters)
    {
        var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.AddWithValue("account", accountId);
        foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value);
        return command;
    }

    private static int PageSize(int size, int max) => size >= 1 && size <= max ? size + 1 : throw Invalid("Invalid inbox page size.");
    private static long Positive(long value) => value > 0 ? value : throw Invalid("Invalid conversation or message identity.");
    private static BusinessException Invalid(string message) => new(Rejection.Invalid, message);

    private static bool TrimPage<T>(List<T> page, int size)
    {
        if (page.Count <= size) return false;
        page.RemoveAt(size);
        return true;
    }
}

internal static class InboxActivityFence
{
    internal const string Setting = "FSUSBLOG_ADMIN_INBOX_ACTIVITY_ORDER";
    private const int LockClass = 1179866434;
    private const int LockObject = 2;

    internal static async Task<long> SnapshotAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await TakeAsync(db, tx, shared: false, ct);
        await using var query = new NpgsqlCommand("SELECT coalesce(max(id),0) FROM public.inbox_message WHERE NOT is_internal", db, tx) { CommandTimeout = 2 };
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
