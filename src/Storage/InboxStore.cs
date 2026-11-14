using System.Security.Cryptography;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Communication;
using Npgsql;

namespace FsusBlogV2.Storage;

/// <summary>Account inbox. Call account methods after verifying the current session in this transaction.</summary>
internal sealed class InboxStore(NpgsqlConnection connection, NpgsqlTransaction transaction, Guid accountId)
{
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
            "unread" => "unread_count > 0",
            "system" => "is_system",
            "open" => "status = 0",
            "pending" => "status = 1",
            "closed" => "status = 2",
            _ => "true"
        };
        await using var action = Command($"""
            WITH position AS (
                SELECT coalesce(nullif(@snapshot, 0), max(last_message_id), 0) AS snapshot
                FROM public.inbox_conversation WHERE account_id = @account
            ), selected AS MATERIALIZED (
                SELECT c.id, c.subject, c.status, c.is_system, {Unread} AS unread_count, c.last_message_at AS updated_at,
                       m.id AS message_id, m.sent_at
                FROM public.inbox_conversation c
                CROSS JOIN position pos
                JOIN LATERAL (
                    SELECT id, sent_at FROM public.inbox_message
                    WHERE conversation_id = c.id AND id <= pos.snapshot AND NOT is_internal
                    ORDER BY id DESC LIMIT 1
                ) m ON true
                WHERE c.account_id = @account
            ), filtered AS MATERIALIZED (
                SELECT * FROM selected WHERE {selected}
            )
            SELECT coalesce(h.last_sequence, 0), pos.snapshot, (SELECT count(*) FROM filtered),
                   p.id, p.subject, p.status, p.is_system, p.unread_count, p.updated_at, p.sent_at, m.sender, m.body
            FROM position pos
            LEFT JOIN public.inbox_delivery h ON h.account_id = @account
            LEFT JOIN LATERAL (
                SELECT * FROM filtered WHERE @before_id = 0 OR (sent_at, id) < (@before_time, @before_id)
                ORDER BY sent_at DESC, id DESC LIMIT @take
            ) p ON true
            LEFT JOIN public.inbox_message m ON (m.conversation_id, m.id) = (p.id, p.message_id)
            ORDER BY p.sent_at DESC, p.id DESC
            """, ("snapshot", cursor?.SnapshotMessageId ?? 0L), ("before_time", cursor?.LastMessageAt ?? DateTimeOffset.UnixEpoch),
            ("before_id", cursor?.ConversationId ?? 0L), ("take", take));
        await using var reader = await action.ExecuteReaderAsync(cancellationToken);
        List<InboxSummary> rows = [];
        long position = 0, snapshot = 0, total = 0;
        while (await reader.ReadAsync(cancellationToken))
        {
            position = reader.GetInt64(0);
            snapshot = reader.GetInt64(1);
            total = reader.GetInt64(2);
            if (reader.IsDBNull(3)) continue;
            rows.Add(new InboxSummary(reader.GetInt64(3), reader.GetString(4), (ConversationStatus)reader.GetInt16(5),
                reader.GetBoolean(6), reader.GetInt64(7), reader.GetFieldValue<DateTimeOffset>(9), reader.GetFieldValue<DateTimeOffset>(8),
                (InboxSender)reader.GetInt16(10), InboxRules.Preview(reader.GetString(11))));
        }
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
        var comparator = delta ? ">" : "<";
        await using var action = Command($"""
            SELECT c.subject, c.status, c.is_system, c.read_through, {Unread}, c.last_message_at, m.id, m.sender, m.body, m.sent_at
            FROM public.inbox_conversation c
            LEFT JOIN LATERAL (
                SELECT id, sender, body, sent_at FROM public.inbox_message
                WHERE conversation_id = c.id AND (@cursor = 0 OR id {comparator} @cursor) AND NOT is_internal
                ORDER BY id {direction} LIMIT @take
            ) m ON true
            WHERE c.id = @id AND c.account_id = @account
            ORDER BY m.id {direction}
            """, ("id", Positive(conversationId)), ("cursor", cursor is long position ? Positive(position) : 0L), ("take", take));
        await using var reader = await action.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;

        var subject = reader.GetString(0);
        var status = (ConversationStatus)reader.GetInt16(1);
        var system = reader.GetBoolean(2);
        var readThrough = reader.IsDBNull(3) ? (long?)null : reader.GetInt64(3);
        var unread = reader.GetInt64(4);
        var lastMessageAt = reader.GetFieldValue<DateTimeOffset>(5);
        List<InboxMessage> messages = [];
        do
        {
            if (reader.IsDBNull(6)) continue;
            messages.Add(new InboxMessage(reader.GetInt64(6), conversationId, (InboxSender)reader.GetInt16(7),
                reader.GetString(8), reader.GetFieldValue<DateTimeOffset>(9)));
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
        await using var recipient = Command("SELECT id FROM public.blog_user WHERE id = @account AND enabled FOR SHARE");
        if (await recipient.ExecuteScalarAsync(cancellationToken) is null)
            throw new BusinessException(Rejection.NotFound, "Inbox account not found.");
        return await StartAsync(InboxRules.CommandId(producerEventId), subject, body, InboxSender.System, cancellationToken);
    }

    private async Task<InboxMutation> StartAsync(string commandId, string subject, string body, InboxSender sender, CancellationToken cancellationToken)
    {
        var system = sender == InboxSender.System;
        subject = InboxRules.Subject(subject, system);
        body = InboxRules.Body(body);
        var fingerprint = InboxRules.Fingerprint("create", 0, 0, subject, body);
        await LockDeliveryAsync(cancellationToken);
        var replay = await FindCommandAsync(commandId, system, fingerprint, cancellationToken);
        if (replay is not null) return replay;

        await using var insert = Command("""
            INSERT INTO public.inbox_conversation (account_id, subject, status, is_system, last_message_at)
            VALUES (@account, @subject, 0, @system, clock_timestamp()) RETURNING id
            """, ("subject", subject), ("system", system));
        var conversationId = (long)(await insert.ExecuteScalarAsync(cancellationToken))!;
        var message = await AppendAsync(conversationId, sender, body, cancellationToken);
        if (!system)
            await SetReadAsync(conversationId, message.Id, cancellationToken);
        await RecordCommandAsync(commandId, system, fingerprint, message, cancellationToken);
        await RecordEventAsync(InboxEventKind.ConversationUpsert, message.ConversationId, message.Id, cancellationToken);
        if (system)
            await RecordEventAsync(InboxEventKind.MessageAppend, message.ConversationId, message.Id, cancellationToken);
        return new InboxMutation(message, Replayed: false);
    }

    public async Task<InboxMutation> ReplyAsync(long conversationId, long readThrough, string commandId, string body, CancellationToken cancellationToken)
    {
        Positive(conversationId);
        Positive(readThrough);
        commandId = InboxRules.CommandId(commandId);
        body = InboxRules.Body(body);
        var fingerprint = InboxRules.Fingerprint("reply", conversationId, readThrough, "", body);
        await LockDeliveryAsync(cancellationToken);
        var replay = await FindCommandAsync(commandId, false, fingerprint, cancellationToken);
        if (replay is not null) return replay;

        var (status, currentRead) = await ReadConversationAsync(conversationId, cancellationToken);
        if (status == ConversationStatus.Closed)
            throw new BusinessException(Rejection.Conflict, "The conversation is closed.");
        var changed = await AdvanceAsync(conversationId, readThrough, currentRead, cancellationToken);
        var message = await AppendAsync(conversationId, InboxSender.Account, body, cancellationToken);
        await RecordCommandAsync(commandId, false, fingerprint, message, cancellationToken);
        if (changed)
            await RecordEventAsync(InboxEventKind.ReadUpdated, conversationId, readThrough, cancellationToken);
        await RecordEventAsync(InboxEventKind.MessageAppend, conversationId, message.Id, cancellationToken);
        await RecordEventAsync(InboxEventKind.ConversationUpsert, conversationId, message.Id, cancellationToken);
        return new InboxMutation(message, Replayed: false);
    }

    internal async Task AdmitReply(long conversationId, long readThrough, string commandId, string body, CancellationToken token)
    {
        Positive(conversationId);
        Positive(readThrough);
        var fingerprint = InboxRules.Fingerprint("reply", conversationId, readThrough, "", InboxRules.Body(body));
        if (await FindCommandAsync(commandId, false, fingerprint, token) is not null) return;
        var (status, current) = await ReadConversationAsync(conversationId, token);
        if (status == ConversationStatus.Closed)
            throw new BusinessException(Rejection.Conflict, "The conversation is closed.");
        await CheckReadTarget(conversationId, readThrough, current, token);
    }

    public async Task<InboxReadState> MarkReadAsync(long conversationId, long readThrough, CancellationToken cancellationToken)
    {
        Positive(conversationId);
        Positive(readThrough);
        await LockDeliveryAsync(cancellationToken);
        var (_, currentRead) = await ReadConversationAsync(conversationId, cancellationToken);
        if (await AdvanceAsync(conversationId, readThrough, currentRead, cancellationToken))
            await RecordEventAsync(InboxEventKind.ReadUpdated, conversationId, readThrough, cancellationToken);
        await using var count = Command($"""
            SELECT {Unread} FROM public.inbox_conversation c WHERE c.account_id = @account AND c.id = @id
            """, ("id", conversationId));
        return new InboxReadState(readThrough, (long)(await count.ExecuteScalarAsync(cancellationToken))!);
    }

    internal async Task<long> ReplayPositionAsync(CancellationToken ct)
    {
        await using var read = Command("select coalesce((select last_sequence from public.inbox_delivery where account_id=@account),0)");
        return (long)(await read.ExecuteScalarAsync(ct))!;
    }

    public async Task<InboxReplay> ReplayAsync(long after, int size, CancellationToken cancellationToken)
    {
        if (after < 0) throw Invalid("Invalid notification position.");
        var take = PageSize(size, 512);
        await using var action = Command("""
            SELECT coalesce(h.last_sequence, 0), e.sequence, e.kind, e.conversation_id, e.message_id, e.occurred_at
            FROM (VALUES (@account)) AS recipient(id)
            LEFT JOIN public.inbox_delivery h ON h.account_id = recipient.id
            LEFT JOIN LATERAL (
                SELECT e.sequence, e.kind, e.conversation_id, e.message_id, e.occurred_at
                FROM public.inbox_event e
                JOIN public.inbox_message m ON (m.conversation_id, m.id) = (e.conversation_id, e.message_id)
                WHERE e.account_id = recipient.id AND e.sequence > @after AND NOT m.is_internal
                ORDER BY e.sequence LIMIT @take
            ) e ON true
            ORDER BY e.sequence
            """, ("after", after), ("take", take));
        await using var reader = await action.ExecuteReaderAsync(cancellationToken);
        List<InboxEvent> events = [];
        var next = after;
        var head = 0L;
        while (await reader.ReadAsync(cancellationToken))
        {
            head = reader.GetInt64(0);
            if (reader.IsDBNull(1)) continue;
            var sequence = reader.GetInt64(1);
            if (sequence - 1 != next) return new InboxReplay(head, false, true, []);
            events.Add(new InboxEvent(sequence, (InboxEventKind)reader.GetInt16(2), reader.GetInt64(3),
                reader.GetInt64(4), reader.GetFieldValue<DateTimeOffset>(5)));
            next = sequence;
        }
        var more = TrimPage(events, size);
        if (next > head || (next < head && !more)) return new InboxReplay(head, false, true, []);
        return new InboxReplay(events.Count > 0 ? events[^1].Sequence : after, more, false, events);
    }

    private async Task LockDeliveryAsync(CancellationToken cancellationToken)
    {
        await using var prepare = Command("""
            INSERT INTO public.inbox_delivery (account_id, last_sequence) VALUES (@account, 0)
            ON CONFLICT (account_id) DO NOTHING
            """);
        await prepare.ExecuteNonQueryAsync(cancellationToken);
        await using var take = Command("SELECT last_sequence FROM public.inbox_delivery WHERE account_id = @account FOR UPDATE");
        await take.ExecuteScalarAsync(cancellationToken);
    }

    private async Task<(ConversationStatus Status, long? ReadThrough)> ReadConversationAsync(long conversationId, CancellationToken cancellationToken)
    {
        await using var query = Command("""
            SELECT status, read_through FROM public.inbox_conversation
            WHERE account_id = @account AND id = @id FOR UPDATE
            """, ("id", conversationId));
        await using var reader = await query.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
            throw new BusinessException(Rejection.NotFound, "Conversation not found.");
        return ((ConversationStatus)reader.GetInt16(0), reader.IsDBNull(1) ? null : reader.GetInt64(1));
    }

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
        await using var target = Command("""
            SELECT 1 FROM public.inbox_message m JOIN public.inbox_conversation c ON c.id = m.conversation_id
            WHERE c.account_id = @account AND c.id = @id AND m.id = @requested AND NOT m.is_internal
            """, ("id", conversationId), ("requested", requested));
        if (await target.ExecuteScalarAsync(cancellationToken) is null)
            throw Invalid("The read position does not refer to a visible message in this conversation.");
    }

    private async Task SetReadAsync(long conversationId, long readThrough, CancellationToken cancellationToken)
    {
        await using var update = Command("""
            UPDATE public.inbox_conversation SET read_through = @message
            WHERE account_id = @account AND id = @id
            """, ("id", conversationId), ("message", readThrough));
        await update.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task<InboxMessage> AppendAsync(long conversationId, InboxSender sender, string body, CancellationToken cancellationToken)
    {
        await using var append = Command("""
            WITH added AS (
                INSERT INTO public.inbox_message (conversation_id, sender, is_internal, body, sent_at)
                SELECT id, @sender, false, @body, clock_timestamp() FROM public.inbox_conversation
                WHERE account_id = @account AND id = @id
                RETURNING id, sent_at
            )
            UPDATE public.inbox_conversation c SET last_message_id = added.id, last_message_at = added.sent_at
            FROM added WHERE c.account_id = @account AND c.id = @id
            RETURNING added.id, added.sent_at
            """, ("id", conversationId), ("sender", (short)sender), ("body", body));
        await using var reader = await append.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
            throw new BusinessException(Rejection.NotFound, "Conversation not found.");
        return new InboxMessage(reader.GetInt64(0), conversationId, sender, body, reader.GetFieldValue<DateTimeOffset>(1));
    }

    private async Task<InboxMutation?> FindCommandAsync(string key, bool service, byte[] fingerprint, CancellationToken cancellationToken)
    {
        await using var existing = Command("""
            SELECT c.fingerprint, m.id, m.conversation_id, m.sender, m.body, m.sent_at
            FROM public.inbox_command c
            JOIN public.inbox_message m ON (m.conversation_id, m.id) = (c.conversation_id, c.message_id)
            WHERE c.account_id = @account AND c.command_id = @key AND c.is_service = @service AND NOT m.is_internal
            """, ("key", key), ("service", service));
        await using var reader = await existing.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        if (!CryptographicOperations.FixedTimeEquals(reader.GetFieldValue<byte[]>(0), fingerprint))
            throw new BusinessException(Rejection.Conflict, "This command key was used for a different request.");
        return new InboxMutation(new InboxMessage(reader.GetInt64(1), reader.GetInt64(2), (InboxSender)reader.GetInt16(3),
            reader.GetString(4), reader.GetFieldValue<DateTimeOffset>(5)), Replayed: true);
    }

    private async Task RecordCommandAsync(string key, bool service, byte[] fingerprint, InboxMessage message, CancellationToken cancellationToken)
    {
        await using var record = Command("""
            INSERT INTO public.inbox_command (account_id, is_service, command_id, fingerprint, conversation_id, message_id)
            VALUES (@account, @service, @key, @fingerprint, @conversation, @message)
            """, ("key", key), ("service", service), ("fingerprint", fingerprint), ("conversation", message.ConversationId), ("message", message.Id));
        await record.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task RecordEventAsync(InboxEventKind kind, long conversationId, long messageId, CancellationToken cancellationToken)
    {
        await using var record = Command("""
            WITH head AS (
                UPDATE public.inbox_delivery SET last_sequence = last_sequence + 1
                WHERE account_id = @account RETURNING last_sequence
            ), written AS (
                INSERT INTO public.inbox_event (account_id, sequence, kind, conversation_id, message_id, occurred_at)
                SELECT @account, last_sequence, @kind, @conversation, @message, clock_timestamp() FROM head
                RETURNING 1
            )
            SELECT pg_catalog.pg_notify('fsus_v2_inbox', '') FROM written
            """, ("kind", (short)kind), ("conversation", conversationId), ("message", messageId));
        await record.ExecuteNonQueryAsync(cancellationToken);
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
