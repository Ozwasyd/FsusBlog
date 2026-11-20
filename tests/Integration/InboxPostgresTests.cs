using System.Buffers.Binary;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Communication;
using FsusBlog.V2.Server;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class InboxPostgresTests
{
    [PostgresFact]
    public async Task LegacyInboxWritesRequireOneUseProofBoundToConversationAndCommand()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var alice = await AddUser(db.DataSource, "alice", ct);
        var bob = await AddUser(db.DataSource, "bob", ct);
        var aliceSession = (await db.SignIn(alice, ct, minutes: 1)).Token;
        var bobSession = (await db.SignIn(bob, ct, minutes: 1)).Token;
        await using var server = await ServerProcess.Start(db.ConnectionString, ct,
            new Dictionary<string, string> { ["FSUSBLOG_PRIVATE_INBOX_WRITES"] = "true" });

        const string key = "ticket:1";
        var create = InboxWire.EncodeCreate("Support request", "I need help.");
        using var missing = await Send(WireRoutes.InboxList, create, key, aliceSession);
        Assert.Equal(HttpStatusCode.Unauthorized, missing.StatusCode);
        string proof = await Challenge(WireRoutes.InboxCreatePowChallenge, create, key, aliceSession);
        using var wrongKey = await Send(WireRoutes.InboxList, create, "ticket:other", aliceSession, proof);
        Assert.Equal(HttpStatusCode.Unauthorized, wrongKey.StatusCode);
        using var wrongAccount = await Send(WireRoutes.InboxList, create, key, bobSession, proof);
        Assert.Equal(HttpStatusCode.Unauthorized, wrongAccount.StatusCode);
        using var first = await Send(WireRoutes.InboxList, create, key, aliceSession, proof);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        byte[] opened = Aeds.Decode(await first.Content.ReadAsByteArrayAsync(ct), FrameType.ConversationDetailV2).ToArray();
        var id = BinaryPrimitives.ReadInt64LittleEndian(opened);
        var snapshot = BinaryPrimitives.ReadInt64LittleEndian(opened.AsSpan(24));
        Assert.Equal(0, opened[34]);
        using var replay = await Send(WireRoutes.InboxList, create, key, aliceSession, proof);
        Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);
        using var fresh = await Send(WireRoutes.InboxList, create, key, aliceSession,
            await Challenge(WireRoutes.InboxCreatePowChallenge, create, key, aliceSession));
        Assert.Equal(HttpStatusCode.OK, fresh.StatusCode);
        byte[] retry = Aeds.Decode(await fresh.Content.ReadAsByteArrayAsync(ct), FrameType.ConversationDetailV2).ToArray();
        Assert.Equal(id, BinaryPrimitives.ReadInt64LittleEndian(retry));
        Assert.Equal(1, retry[34]);

        var replyFrame = InboxWire.EncodeReply(snapshot, "A follow-up.");
        var challengePath = WireRoutes.InboxReplyPowChallenge.Replace("{id:long}", id.ToString(System.Globalization.CultureInfo.InvariantCulture));
        var replyPath = WireRoutes.InboxReply.Replace("{id:long}", id.ToString(System.Globalization.CultureInfo.InvariantCulture));
        using var foreign = await Send(challengePath, replyFrame, "reply:1", bobSession, issuing: true);
        Assert.Equal(HttpStatusCode.NotFound, foreign.StatusCode);
        string replyProof = await Challenge(challengePath, replyFrame, "reply:1", aliceSession);
        string wrongPath = WireRoutes.InboxReply.Replace("{id:long}", (id + 1).ToString(System.Globalization.CultureInfo.InvariantCulture));
        using var wrongThread = await Send(wrongPath, replyFrame, "reply:1", aliceSession, replyProof);
        Assert.Equal(HttpStatusCode.Unauthorized, wrongThread.StatusCode);
        using var changedReply = await Send(replyPath, InboxWire.EncodeReply(snapshot, "Different follow-up."), "reply:1", aliceSession, replyProof);
        Assert.Equal(HttpStatusCode.Unauthorized, changedReply.StatusCode);
        using var replied = await Send(replyPath, replyFrame, "reply:1", aliceSession, replyProof);
        Assert.Equal(HttpStatusCode.OK, replied.StatusCode);
        var response = Aeds.Decode(await replied.Content.ReadAsByteArrayAsync(ct), FrameType.ConversationMessage).ToArray();
        Assert.Equal(id, BinaryPrimitives.ReadInt64LittleEndian(response.AsSpan(8)));
        var persisted = await InTransaction(db.DataSource, alice, inbox => inbox.GetAsync(id, null, 50, ct), ct);
        Assert.Equal(new[] { "I need help.", "A follow-up." }, persisted!.Messages.Select(m => m.Body));

        async Task<HttpResponseMessage> Send(string path, byte[] frame, string command, string token, string? work = null, bool issuing = false)
        {
            using var request = SiteAedsFixture.Request(HttpMethod.Post, path, frame, token, handle: null);
            request.Headers.Add(WireHeaders.ClientMutationId, command);
            if (issuing) request.Headers.Add(WireHeaders.PowClientNonce, ClientNonce);
            if (work is not null) request.Headers.Add(WireHeaders.PowProof, work);
            return await server.Client.SendAsync(request, ct);
        }

        async Task<string> Challenge(string path, byte[] frame, string command, string token)
        {
            using var result = await Send(path, frame, command, token, issuing: true);
            Assert.Equal(HttpStatusCode.OK, result.StatusCode);
            return InboxFixture.SolveChallenge(await result.Content.ReadAsByteArrayAsync(ct), ClientNonce);
        }
    }

    private const string ClientNonce = "253ad5c923194c56b9d7e6622ffabeab";

    [PostgresFact]
    public async Task InboxSocketOnlyWakesForOwnedCommitAndClosesOnRevocation()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var alice = await AddUser(db.DataSource, "alice", ct);
        var bob = await AddUser(db.DataSource, "bob", ct);
        var aliceSession = (await db.SignIn(alice, ct, minutes: 1)).Token;
        var bobSession = (await db.SignIn(bob, ct, minutes: 1)).Token;
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        var origin = server.Client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        var address = new UriBuilder(origin) { Scheme = "ws", Path = WireRoutes.InboxStream }.Uri;

        foreach (var (source, token, expected) in new[]
        {
            ("https://another.invalid", (string?)aliceSession, HttpStatusCode.Forbidden),
            (origin, (string?)null, HttpStatusCode.Unauthorized)
        })
        {
            using var denied = Client(source, token);
            await Assert.ThrowsAsync<WebSocketException>(() => denied.ConnectAsync(address, ct));
            Assert.Equal(expected, denied.HttpStatusCode);
        }

        using var own = Client(origin, aliceSession);
        using var other = Client(origin, bobSession);
        await own.ConnectAsync(address, ct);
        await other.ConnectAsync(address, ct);
        var payload = new byte[64];
        var ownFrame = own.ReceiveAsync(new ArraySegment<byte>(payload), ct);
        var unrelated = other.ReceiveAsync(new ArraySegment<byte>(new byte[64]), ct);
        await using (var connection = await db.DataSource.OpenConnectionAsync(ct))
        await using (var tx = await connection.BeginTransactionAsync(ct))
        {
            await new InboxStore(connection, tx, alice).SendNoticeAsync("will-rollback", "Rolled back", "No event", ct);
            await tx.RollbackAsync(ct);
        }
        Assert.False(ownFrame.IsCompleted);
        await InTransaction(db.DataSource, alice, inbox => inbox.SendNoticeAsync("committed", "A notice", "Private body", ct), ct);
        var frame = await ownFrame.WaitAsync(TimeSpan.FromSeconds(8), ct);
        Assert.Equal(WebSocketMessageType.Binary, frame.MessageType);
        Assert.True(frame.EndOfMessage);
        Assert.Equal(Wire.EncodeEmptySuccess(), payload[..frame.Count]);
        Assert.False(unrelated.IsCompleted);

        await using (var revoke = db.DataSource.CreateCommand("update public.blog_user set generation=generation+1 where id=$1"))
        {
            revoke.Parameters.AddWithValue(alice);
            Assert.Equal(1, await revoke.ExecuteNonQueryAsync(ct));
        }
        var closed = await own.ReceiveAsync(new ArraySegment<byte>(payload), ct).WaitAsync(TimeSpan.FromSeconds(8), ct);
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, closed.CloseStatus);
        await own.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, ct);
        Assert.False(unrelated.IsCompleted);
        other.Abort();
        await Assert.ThrowsAnyAsync<Exception>(async () => await unrelated);

        static ClientWebSocket Client(string source, string? token) =>
            InboxFixture.WakeClient(source, token is null ? null : $"fsus-v2-session={token}");
    }

    [PostgresFact]
    public async Task HttpReplayRechecksSessionAndRejectsAnotherSessionsCursor()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var alice = await AddUser(db.DataSource, "alice", ct);
        var bob = await AddUser(db.DataSource, "bob", ct);
        var aliceSession = (await db.SignIn(alice, ct, minutes: 1)).Token;
        var bobSession = (await db.SignIn(bob, ct, minutes: 1)).Token;
        await using var server = await ServerProcess.Start(db.ConnectionString, ct,
            new Dictionary<string, string> { ["FSUSBLOG_PRIVATE_INBOX_WRITES"] = "false" });
        var client = server.Client;

        using var missing = await client.GetAsync(WireRoutes.InboxReplay, ct);
        Assert.Equal(HttpStatusCode.Unauthorized, missing.StatusCode);
        using var disabled = await InboxGet(client, WireRoutes.InboxWriteAvailability, aliceSession, ct);
        Assert.Equal(HttpStatusCode.OK, disabled.StatusCode);
        Assert.Equal("0", Assert.Single(disabled.Headers.GetValues(WireHeaders.InboxWriteEnabled)));
        Assert.Equal(FrameType.EmptySuccess, Kind(await disabled.Content.ReadAsByteArrayAsync(ct)));
        using var disabledWrite = await client.PostAsync(WireRoutes.InboxList, null, ct);
        Assert.Equal(HttpStatusCode.NotFound, disabledWrite.StatusCode);
        await InTransaction(db.DataSource, alice, inbox => inbox.SendNoticeAsync("before-opening", "Notice", "Already seen", ct), ct);
        using var list = await InboxGet(client, WireRoutes.InboxList, aliceSession, ct);
        Assert.Equal(HttpStatusCode.OK, list.StatusCode);
        Assert.Equal(FrameType.ConversationList, Kind(await list.Content.ReadAsByteArrayAsync(ct)));
        var cursor = Cursor(list);

        var notice = await InTransaction(db.DataSource, alice, inbox => inbox.SendNoticeAsync("after-opening", "Notice", "New notice", ct), ct);
        var replayPath = $"{WireRoutes.InboxReplay}?after={cursor}&limit=1";
        using var first = await InboxGet(client, replayPath, aliceSession, ct);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.True(first.Headers.CacheControl?.NoStore);
        var firstPayload = Aeds.Decode(await first.Content.ReadAsByteArrayAsync(ct), FrameType.InboxReplay).ToArray();
        Assert.Equal(1, EventCount(firstPayload));
        Assert.Equal(WireLayouts.InboxReplayHasMore, firstPayload[1]);
        Assert.Equal(notice.Message.Id, BinaryPrimitives.ReadInt64LittleEndian(firstPayload.AsSpan(36)));

        using var second = await InboxGet(client, $"{WireRoutes.InboxReplay}?after={Cursor(first)}", aliceSession, ct);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var secondPayload = Aeds.Decode(await second.Content.ReadAsByteArrayAsync(ct), FrameType.InboxReplay).ToArray();
        Assert.Equal(1, EventCount(secondPayload));
        Assert.Equal(WireLayouts.InboxMessageAppend, BinaryPrimitives.ReadInt32LittleEndian(secondPayload.AsSpan(24)));

        using var crossAccount = await InboxGet(client, replayPath, bobSession, ct);
        Assert.Equal(HttpStatusCode.Conflict, crossAccount.StatusCode);
        Assert.Equal(FrameType.ApiError, Kind(await crossAccount.Content.ReadAsByteArrayAsync(ct)));
        using var empty = await InboxGet(client, WireRoutes.InboxReplay, bobSession, ct);
        Assert.Equal(0, EventCount(Aeds.Decode(await empty.Content.ReadAsByteArrayAsync(ct), FrameType.InboxReplay)));

        await using (var erase = db.DataSource.CreateCommand("delete from public.inbox_event where account_id=$1 and sequence=3"))
        {
            erase.Parameters.AddWithValue(alice);
            Assert.Equal(1, await erase.ExecuteNonQueryAsync(ct));
        }
        using var gap = await InboxGet(client, replayPath, aliceSession, ct);
        var gapPayload = Aeds.Decode(await gap.Content.ReadAsByteArrayAsync(ct), FrameType.InboxReplay).ToArray();
        Assert.Equal(WireLayouts.InboxReplayRequiresResync, gapPayload[1]);
        Assert.Equal(0, EventCount(gapPayload));
        Assert.False(gap.Headers.Contains(WireHeaders.InboxReplayCursor));

        await using (var revoke = db.DataSource.CreateCommand("update public.blog_user set generation=generation+1 where id=$1"))
        {
            revoke.Parameters.AddWithValue(alice);
            Assert.Equal(1, await revoke.ExecuteNonQueryAsync(ct));
        }
        using var revoked = await InboxGet(client, replayPath, aliceSession, ct);
        Assert.Equal(HttpStatusCode.Unauthorized, revoked.StatusCode);
        Assert.False(revoked.Headers.Contains(WireHeaders.InboxReplayCursor));
    }

    [PostgresFact]
    public async Task MessageMutationReadPositionAndPrivateReplayAreAtomic()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var alice = await AddUser(db.DataSource, "alice", ct);
        var bob = await AddUser(db.DataSource, "bob", ct);

        var ticket = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ =>
            InTransaction(db.DataSource, alice, inbox => inbox.CreateAsync("ticket:1", "Support", "A ticket", ct), ct)));
        Assert.Single(ticket, result => !result.Replayed);
        var opening = ticket[0].Message;
        Assert.All(ticket, item => Assert.Equal(opening, item.Message));

        var notice = await InTransaction(db.DataSource, alice, inbox => inbox.SendNoticeAsync("ticket:1", "Notice", "For Alice", ct), ct);
        var repeat = await InTransaction(db.DataSource, alice, inbox => inbox.SendNoticeAsync("ticket:1", "Notice", "For Alice", ct), ct);
        Assert.True(repeat.Replayed);
        Assert.Equal(notice.Message, repeat.Message);

        var unread = await InTransaction(db.DataSource, alice, inbox => inbox.ListAsync(null, 20, "unread", ct), ct);
        Assert.Equal(notice.Message.ConversationId, Assert.Single(unread.Conversations).Id);
        Assert.Equal(1, unread.Total);
        Assert.Empty((await InTransaction(db.DataSource, bob, inbox => inbox.ListAsync(null, 20, null, ct), ct)).Conversations);
        Assert.Null(await InTransaction(db.DataSource, bob, inbox => inbox.GetAsync(opening.ConversationId, null, 50, ct), ct));

        var invalidRead = await Assert.ThrowsAsync<BusinessException>(() => InTransaction(db.DataSource, alice,
            inbox => inbox.MarkReadAsync(opening.ConversationId, notice.Message.Id, ct), ct));
        Assert.Equal(Rejection.Invalid, invalidRead.Rejection);
        var wrongAccount = await Assert.ThrowsAsync<BusinessException>(() => InTransaction(db.DataSource, bob,
            inbox => inbox.MarkReadAsync(opening.ConversationId, opening.Id, ct), ct));
        Assert.Equal(Rejection.NotFound, wrongAccount.Rejection);
        var internalId = await AddInternalMessage(db.DataSource, opening.ConversationId, ct);
        var internalRead = await Assert.ThrowsAsync<BusinessException>(() => InTransaction(db.DataSource, alice,
            inbox => inbox.MarkReadAsync(opening.ConversationId, internalId, ct), ct));
        Assert.Equal(Rejection.Invalid, internalRead.Rejection);

        var reply = await InTransaction(db.DataSource, alice, inbox => inbox.ReplyAsync(opening.ConversationId, opening.Id, "reply-1", "Follow up", ct), ct);
        var conflicting = await Assert.ThrowsAsync<BusinessException>(() => InTransaction(db.DataSource, alice,
            inbox => inbox.ReplyAsync(opening.ConversationId, opening.Id, "reply-1", "Other text", ct), ct));
        Assert.Equal(Rejection.Conflict, conflicting.Rejection);
        var current = await InTransaction(db.DataSource, alice, inbox => inbox.GetAsync(opening.ConversationId, null, 50, ct), ct);
        Assert.NotNull(current);
        Assert.Equal([opening.Id, reply.Message.Id], current.Messages.Select(message => message.Id));

        var read = await InTransaction(db.DataSource, alice, inbox => inbox.MarkReadAsync(notice.Message.ConversationId, notice.Message.Id, ct), ct);
        Assert.Equal(0, read.UnreadCount);
        var first = await InTransaction(db.DataSource, alice, inbox => inbox.ReplayAsync(0, 2, ct), ct);
        Assert.True(first.HasMore);
        Assert.Equal([1L, 2L], first.Events.Select(item => item.Sequence));
        var second = await InTransaction(db.DataSource, alice, inbox => inbox.ReplayAsync(first.Next, 20, ct), ct);
        Assert.False(second.HasMore);
        Assert.False(second.RequiresResync);
        Assert.Equal(InboxEventKind.ReadUpdated, second.Events[^1].Kind);
        Assert.DoesNotContain(first.Events.Concat(second.Events), item => item.MessageId == internalId);
        Assert.Empty((await InTransaction(db.DataSource, bob, inbox => inbox.ReplayAsync(0, 20, ct), ct)).Events);
        Assert.True((await InTransaction(db.DataSource, bob, inbox => inbox.ReplayAsync(second.Next, 20, ct), ct)).RequiresResync);

        await using (var connection = await db.DataSource.OpenConnectionAsync(ct))
        await using (var transaction = await connection.BeginTransactionAsync(ct))
        {
            await new InboxStore(connection, transaction, alice).SendNoticeAsync("rollback", "Temporary", "Rollback me", ct);
            await transaction.RollbackAsync(ct);
        }
        var afterRollback = await InTransaction(db.DataSource, alice, inbox => inbox.ReplayAsync(second.Next, 20, ct), ct);
        Assert.Empty(afterRollback.Events);
        Assert.Equal(second.Next, afterRollback.Next);
    }

    [PostgresFact]
    public async Task FirstListPageFreezesMessageVisibilityAcrossNewActivity()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var user = await AddUser(db.DataSource, "reader", ct);
        var older = await InTransaction(db.DataSource, user, inbox => inbox.CreateAsync("older", "First", "Old preview", ct), ct);
        var newer = await InTransaction(db.DataSource, user, inbox => inbox.CreateAsync("newer", "Second", "New preview", ct), ct);
        var first = await InTransaction(db.DataSource, user, inbox => inbox.ListAsync(null, 1, null, ct), ct);
        Assert.Equal(newer.Message.ConversationId, Assert.Single(first.Conversations).Id);
        Assert.NotNull(first.Next);

        var reply = await InTransaction(db.DataSource, user, inbox =>
            inbox.ReplyAsync(older.Message.ConversationId, older.Message.Id, "recent", "Future preview", ct), ct);
        var second = await InTransaction(db.DataSource, user, inbox => inbox.ListAsync(first.Next, 1, null, ct), ct);
        Assert.Equal(2, second.Total);
        var oldPreview = Assert.Single(second.Conversations);
        Assert.Equal(older.Message.ConversationId, oldPreview.Id);
        Assert.Equal("Old preview", oldPreview.Preview);

        var delta = await InTransaction(db.DataSource, user, inbox => inbox.DeltaAsync(older.Message.ConversationId, older.Message.Id, 50, ct), ct);
        Assert.NotNull(delta);
        Assert.Equal(reply.Message, Assert.Single(delta.Messages));
    }

    private static async Task<T> InTransaction<T>(NpgsqlDataSource data, Guid user,
        Func<InboxStore, Task<T>> operation, CancellationToken ct)
    {
        await using var connection = await data.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        var result = await operation(new InboxStore(connection, transaction, user));
        await transaction.CommitAsync(ct);
        return result;
    }

    private static async Task<Guid> AddUser(NpgsqlDataSource data, string name, CancellationToken ct)
    {
        var user = Guid.NewGuid();
        await using var insert = data.CreateCommand("INSERT INTO public.blog_user (id, name, enabled, generation) VALUES ($1, $2, true, 1)");
        insert.Parameters.AddWithValue(user);
        insert.Parameters.AddWithValue(name);
        await insert.ExecuteNonQueryAsync(ct);
        return user;
    }

    private static async Task<HttpResponseMessage> InboxGet(HttpClient client, string path, string session, CancellationToken ct)
    {
        using var request = SiteAedsFixture.Request(HttpMethod.Get, path, frame: null, session, handle: null);
        return await client.SendAsync(request, ct);
    }

    private static FrameType Kind(byte[] frame)
    {
        Aeds.Decode(frame, out var type);
        return type;
    }

    private static string Cursor(HttpResponseMessage response) => Assert.Single(response.Headers.GetValues(WireHeaders.InboxReplayCursor));

    private static int EventCount(ReadOnlySpan<byte> payload) => BinaryPrimitives.ReadInt32LittleEndian(payload[4..]);

    private static async Task<long> AddInternalMessage(NpgsqlDataSource data, long conversation, CancellationToken ct)
    {
        await using var insert = data.CreateCommand("""
            INSERT INTO public.inbox_message (conversation_id, sender, is_internal, body, sent_at)
            VALUES ($1, 1, true, 'Internal staff note', clock_timestamp()) RETURNING id
            """);
        insert.Parameters.AddWithValue(conversation);
        return (long)(await insert.ExecuteScalarAsync(ct))!;
    }
}
