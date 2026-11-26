using System.Net.Sockets;

namespace FsusBlog.V2.Server.Communication;

internal static class InboxEndpoints
{
    internal static void Map(WebApplication app, string cookie, FsusBlog.V2.Server.Operations.SiteCapabilities capabilities)
    {
        app.MapCommandGet(WireRoutes.InboxList, (HttpContext ctx, Store store, CancellationToken ct) =>
            Account(ctx, store, cookie, async inbox =>
            {
                var size = QueryInt(ctx, "size") ?? 20;
                var encoded = ServerHttp.Query(ctx, "cursor", 32);
                var cursor = string.IsNullOrWhiteSpace(encoded) ? (Contracts.InboxCursor?)null : InboxWire.DecodeCursor(encoded);
                var position = cursor is { } c
                    ? new Core.Communication.InboxCursor(c.SnapshotMessageId, c.LastMessageAt, c.ConversationId)
                    : (Core.Communication.InboxCursor?)null;
                var page = await inbox.ListAsync(position, (int)Math.Clamp(size <= 0 ? 20 : size, 1, 50), ServerHttp.Query(ctx, "filter", 32), ct);
                var items = page.Conversations.Select(c => new InboxListRecord(c.Id, c.Subject, (int)c.Status, Count(c.UnreadCount),
                    c.LastMessageAt, c.UpdatedAt, c.IsSystem, c.Status != ConversationStatus.Closed,
                    new InboxPreviewRecord((int)c.LastSender, c.LastMessageAt, c.Preview, Name(c.LastSender)))).ToArray();
                var next = page.Next is { } n ? InboxWire.EncodeCursor(new(n.SnapshotMessageId, n.LastMessageAt, n.ConversationId)) : null;
                return new Response(InboxWire.EncodeList(items, Count(page.Total), next), Cursor: cursor is null ? page.ReplayPosition : null);
            }, ct));

        app.MapCommandGet(WireRoutes.InboxDetail, (long id, HttpContext ctx, Store store, CancellationToken ct) =>
            Account(ctx, store, cookie, async inbox =>
            {
                var before = QueryInt(ctx, "beforeMessageId");
                var after = QueryInt(ctx, "afterMessageId");
                if (before <= 0 || after <= 0 || (before.HasValue && after.HasValue))
                    throw Invalid("Invalid message cursor.");
                var detail = after is long last
                    ? await inbox.DeltaAsync(id, last, 50, ct)
                    : await inbox.GetAsync(id, before, 50, ct);
                if (detail is null) throw new BusinessException(Rejection.NotFound, "Conversation not found.");
                return new Response(EncodeDetail(detail, Count(detail.UnreadCount), detail.IsSystem));
            }, ct));

        app.MapCommandPost(WireRoutes.InboxRead, (long id, HttpContext ctx, Store store, CancellationToken ct) =>
            Account(ctx, store, cookie, async inbox =>
            {
                var readThrough = InboxWire.DecodeRead(await ServerHttp.ReadFrame(ctx, Aeds.HeaderSize + sizeof(long), ct));
                await inbox.MarkReadAsync(id, readThrough, ct);
                return new Response(Wire.EncodeEmptySuccess());
            }, ct));

        app.MapCommandGet(WireRoutes.InboxReplay, (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var encoded = ServerHttp.Query(ctx, "after", WireLimits.InboxReplayCursorChars);
            var limit = QueryInt(ctx, "limit") ?? 100;
            if (limit is < 1 or > WireLimits.InboxReplayMaxEvents) throw Invalid("Invalid notification page size.");
            return Account(ctx, store, cookie, async inbox =>
            {
                long after = 0;
                if (encoded is not null && !InboxReplayCursor.TryDecode(ctx.Request.Cookies[cookie]!, encoded, out after))
                    throw new BusinessException(Rejection.Conflict, "The notification cursor has expired. Reload the inbox.");
                var page = await inbox.ReplayAsync(after, (int)limit, ct);
                var events = page.Events.Select(e => new InboxReplayRecord(e.Sequence, (int)e.Kind, e.ConversationId,
                    e.MessageId, e.OccurredAt)).ToArray();
                // A fresh inbox snapshot, not the rejected cursor, supplies the baseline after loss.
                var packet = InboxReplayWire.Encode(page.RequiresResync ? 0 : page.Next, page.HasMore, page.RequiresResync, events);
                return new Response(packet, page.RequiresResync ? null : page.Next);
            }, ct);
        });
        InboxWriteEndpoints.Map(app, cookie, capabilities);
    }

    private readonly record struct Response(byte[] Frame, long? Cursor = null);

    private static async Task<IResult> Account(HttpContext ctx, Store store, string cookie, Func<InboxStore, Task<Response>> operation,
        CancellationToken cancellationToken)
    {
        var token = ctx.Request.Cookies[cookie];
        var (response, expiresAt) = await store.WithSession(token, false, async (connection, transaction, actor) =>
        {
            SiteSessions.IfCurrent(actor.Id, token, SiteSessions.Requested(ctx));
            var frame = await operation(new InboxStore(connection, transaction, actor.Id));
            return (frame, actor.ExpiresAt);
        }, cancellationToken);
        ctx.Response.Headers[WireHeaders.AccessExpiresAtUtc] = expiresAt.UtcDateTime.ToString("O", CultureInfo.InvariantCulture);
        if (response.Cursor is long next)
            ctx.Response.Headers[WireHeaders.InboxReplayCursor] = InboxReplayCursor.Encode(token!, next);
        return ServerHttp.Frame(response.Frame);
    }

    private static long? QueryInt(HttpContext ctx, string field)
    {
        var text = ServerHttp.Query(ctx, field, 20);
        return text is null ? null : long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var value)
            ? value : throw Invalid("Invalid numeric query parameter.");
    }

    internal static InboxMessageRecord Project(InboxMessage message, bool replayed) =>
        new(message.Id, message.ConversationId, (int)message.Sender, message.SentAt, message.Body, Name(message.Sender), replayed);

    internal static byte[] EncodeDetail(InboxDetail detail, int unread, bool system, bool createResponse = false, bool replayed = false) =>
        InboxWire.EncodeDetail(new(detail.Id, detail.Subject, (int)detail.Status, unread, detail.LastMessageAt,
            detail.ReadSnapshot, system, detail.Status != ConversationStatus.Closed, detail.Messages.Select(message => Project(message, false)).ToArray(),
            createResponse ? null : detail.Previous, replayed), createResponse);

    internal static string Name(InboxSender sender) => sender switch
    {
        InboxSender.Account => "你",
        InboxSender.Administrator => "管理员",
        InboxSender.System => "系统",
        _ => throw new InvalidOperationException("Unsupported inbox sender.")
    };

    internal static int Count(long value) => (int)Math.Min(int.MaxValue, value);
    private static BusinessException Invalid(string message) => new(Rejection.Invalid, message);
}

internal static class InboxWriteEndpoints
{
    internal const string Setting = "FSUSBLOG_PRIVATE_INBOX_WRITES";

    internal static void Map(WebApplication app, string cookie, FsusBlog.V2.Server.Operations.SiteCapabilities capabilities)
    {
        var enabled = capabilities.PrivateInboxWrites;
        var fenceVisibleMessages = capabilities.AdminInboxActivityOrder;
        app.MapCommandGet(WireRoutes.InboxWriteAvailability, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var packet = await store.WithSession(ctx.Request.Cookies[cookie], false,
                (_, _, _) => Task.FromResult(Wire.EncodeEmptySuccess()), ct);
            ctx.Response.Headers[WireHeaders.InboxWriteEnabled] = enabled ? "1" : "0";
            return ServerHttp.Frame(packet);
        });
        if (!enabled) return;

        app.MapCommandPost(WireRoutes.InboxCreatePowChallenge,
            (HttpContext ctx, Store store, ScopedPow pow, CancellationToken ct) => Run(ctx, store, pow, null, issue: true, ct));
        app.MapCommandPost(WireRoutes.InboxReplyPowChallenge,
            (long id, HttpContext ctx, Store store, ScopedPow pow, CancellationToken ct) => Run(ctx, store, pow, id, issue: true, ct));
        app.MapCommandPost(WireRoutes.InboxList,
            (HttpContext ctx, Store store, ScopedPow pow, CancellationToken ct) => Run(ctx, store, pow, null, issue: false, ct));
        app.MapCommandPost(WireRoutes.InboxReply,
            (long id, HttpContext ctx, Store store, ScopedPow pow, CancellationToken ct) => Run(ctx, store, pow, id, issue: false, ct));

        Task<IResult> Run(HttpContext ctx, Store store, ScopedPow pow, long? conversation, bool issue, CancellationToken ct)
        {
            var scope = conversation.HasValue ? PowScope.InboxReply : PowScope.InboxCreate;
            return ScopedPow.Protect(ctx, async () =>
            {
                if (!ctx.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header) || header.Count != 1 ||
                    header[0] is not { Length: <= 128 } rawKey)
                    throw new BusinessException(Rejection.Invalid, "Invalid inbox command key.");
                var key = InboxRules.CommandId(rawKey);
                var bytes = await ServerHttp.ReadFrame(ctx, InboxWire.MaxRequestFrameBytes, ct);
                var context = conversation.HasValue
                    ? string.Create(CultureInfo.InvariantCulture, $"{conversation.Value}:{key}") : key;
                var session = ctx.Request.Cookies[cookie];
                var source = ScopedPow.Source(ctx);

                return await store.WithSession(session, false, async (db, tx, actor) =>
                {
                    SiteSessions.IfCurrent(actor.Id, session, SiteSessions.Requested(ctx));
                    var input = Read(bytes, conversation);
                    var inbox = new InboxStore(db, tx, actor.Id, fenceVisibleMessages);
                    if (issue)
                    {
                        if (conversation is long existing)
                            await inbox.AdmitReply(existing, input.ReadThrough, key, input.Body, ct);
                        return PowWire.EncodeChallenge(pow.Issue(scope, context, session!, source, ScopedPow.ReadClientNonce(ctx), bytes));
                    }
                    await pow.Consume(db, tx, scope, context, session!, source, bytes, ScopedPow.ReadProof(ctx), ct);
                    if (conversation is long id)
                    {
                        var replied = await inbox.ReplyAsync(id, input.ReadThrough, key, input.Body, ct);
                        return InboxWire.EncodeMessage(InboxEndpoints.Project(replied.Message, replied.Replayed));
                    }
                    var created = await inbox.CreateAsync(key, input.Subject, input.Body, ct);
                    var detail = await inbox.GetAsync(created.Message.ConversationId, null, 50, ct) ??
                        throw new InvalidOperationException("Created conversation could not be materialized.");
                    return InboxEndpoints.EncodeDetail(detail, InboxEndpoints.Count(detail.UnreadCount), detail.IsSystem,
                        createResponse: true, replayed: created.Replayed);
                }, ct);
            }, scope);
        }
    }

    private static (string Subject, string Body, long ReadThrough) Read(byte[] frame, long? conversation)
    {
        if (conversation is <= 0) throw new BusinessException(Rejection.Invalid, "Invalid conversation identity.");
        if (conversation.HasValue)
        {
            var (readThrough, message) = InboxWire.DecodeReply(frame);
            return ("", InboxRules.Body(message), readThrough);
        }
        var (subject, body) = InboxWire.DecodeCreate(frame);
        return (InboxRules.Subject(subject), InboxRules.Body(body), 0);
    }
}

internal static class InboxReplayCursor
{
    internal static string Encode(string session, long position)
    {
        var bytes = new byte[sizeof(long) + SHA256.HashSizeInBytes];
        BinaryPrimitives.WriteInt64LittleEndian(bytes, position);
        Authenticate(session, bytes.AsSpan(0, sizeof(long)), bytes.AsSpan(sizeof(long)));
        return WebEncoders.Base64UrlEncode(bytes);
    }

    internal static bool TryDecode(string session, string encoded, out long position)
    {
        position = 0;
        if (encoded.Length != WireLimits.InboxReplayCursorChars ||
            encoded.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_')) return false;
        var bytes = WebEncoders.Base64UrlDecode(encoded);
        if (!string.Equals(WebEncoders.Base64UrlEncode(bytes), encoded, StringComparison.Ordinal)) return false;
        ReadOnlySpan<byte> offset = bytes.AsSpan(0, sizeof(long));
        Span<byte> expected = stackalloc byte[SHA256.HashSizeInBytes];
        Authenticate(session, offset, expected);
        if (!CryptographicOperations.FixedTimeEquals(bytes.AsSpan(sizeof(long)), expected)) return false;
        position = BinaryPrimitives.ReadInt64LittleEndian(offset);
        return position >= 0;
    }

    private static void Authenticate(string session, ReadOnlySpan<byte> position, Span<byte> signature)
    {
        ReadOnlySpan<byte> label = "FsusBlog.private-inbox-replay.v1"u8;
        Span<byte> message = stackalloc byte[label.Length + sizeof(long)];
        label.CopyTo(message);
        position.CopyTo(message[label.Length..]);
        HMACSHA256.HashData(Convert.FromHexString(session), message, signature);
    }
}

internal sealed class InboxWake(string connectionString, ILogger<InboxWake> log) : BackgroundService
{
    private static readonly TimeSpan WaitSlice = TimeSpan.FromSeconds(1);
    private readonly string _listenerConnection = new NpgsqlConnectionStringBuilder(connectionString)
    {
        Pooling = false, Enlist = false, Multiplexing = false, Timeout = 3, CommandTimeout = 2,
    }.ConnectionString;
    private TaskCompletionSource _next = NewPulse();

    internal Task Changed => Volatile.Read(ref _next).Task;

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            try
            {
                await using var connection = new NpgsqlConnection(_listenerConnection);
                await connection.OpenAsync();
                connection.Notification += (_, _) => Pulse();
                await SqlCommands.Execute(connection, null, CancellationToken.None, "listen fsus_v2_inbox");
                Pulse();
                while (!stop.IsCancellationRequested) await connection.WaitAsync(WaitSlice);
            }
            catch (Exception failure) when (failure is NpgsqlException or SocketException)
            {
                if (stop.IsCancellationRequested) return;
                log.LogWarning(failure, "Inbox wake listener will reconnect.");
                await Task.Delay(TimeSpan.FromSeconds(2), stop);
            }
        }
    }

    private void Pulse() => Interlocked.Exchange(ref _next, NewPulse()).TrySetResult();
    private static TaskCompletionSource NewPulse() => new(TaskCreationOptions.RunContinuationsAsynchronously);
}
