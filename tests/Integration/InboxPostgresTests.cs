using System.Net.WebSockets;
using FsusBlog.V2.Core.Communication;

namespace FsusBlog.V2.Integration.Tests;

public sealed class InboxPostgresTests
{
    [PostgresFact]
    public async Task LegacyInboxWritesRequireOneUseProofBoundToConversationAndCommand()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var (alice, aliceSession, _) = await db.SignInSiteUser("alice", ct, minutes: 1);
        var (_, bobSession, _) = await db.SignInSiteUser("bob", ct, minutes: 1);
        await using var server = await ServerProcess.Start(db.ConnectionString, ct,
            new Dictionary<string, string> { ["FSUSBLOG_PRIVATE_INBOX_WRITES"] = "true" });

        const string key = "ticket:1";
        var create = InboxWire.EncodeCreate("Support request", "I need help.");
        await CheckStatusAsync(Unauthorized, Send(WireRoutes.InboxList, create, key, aliceSession));
        string proof = await Challenge(WireRoutes.InboxCreatePowChallenge, create, key, aliceSession);
        await CheckStatusAsync(Unauthorized, Send(WireRoutes.InboxList, create, "ticket:other", aliceSession, proof));
        await CheckStatusAsync(Unauthorized, Send(WireRoutes.InboxList, create, key, bobSession, proof));
        byte[] opened = Aeds.Decode(await OkBytes(Send(WireRoutes.InboxList, create, key, aliceSession, proof), ct), FrameType.ConversationDetailV2).ToArray();
        var (id, snapshot) = (BinaryPrimitives.ReadInt64LittleEndian(opened), BinaryPrimitives.ReadInt64LittleEndian(opened.AsSpan(24)));
        Assert.Equal(0, opened[34]);
        await CheckStatusAsync(Unauthorized, Send(WireRoutes.InboxList, create, key, aliceSession, proof));
        byte[] retry = Aeds.Decode(await OkBytes(Send(WireRoutes.InboxList, create, key, aliceSession,
            await Challenge(WireRoutes.InboxCreatePowChallenge, create, key, aliceSession)), ct), FrameType.ConversationDetailV2).ToArray();
        Assert.Equal((id, (byte)1), (BinaryPrimitives.ReadInt64LittleEndian(retry), retry[34]));

        var replyFrame = InboxWire.EncodeReply(snapshot, "A follow-up.");
        var challengePath = WireRoutes.InboxReplyPowChallenge.Replace("{id:long}", id.ToString(CultureInfo.InvariantCulture));
        var replyPath = WireRoutes.InboxReply.Replace("{id:long}", id.ToString(CultureInfo.InvariantCulture));
        await CheckStatusAsync(NotFound, Send(challengePath, replyFrame, "reply:1", bobSession, issuing: true));
        string replyProof = await Challenge(challengePath, replyFrame, "reply:1", aliceSession);
        string wrongPath = WireRoutes.InboxReply.Replace("{id:long}", (id + 1).ToString(CultureInfo.InvariantCulture));
        await CheckStatusAsync(Unauthorized, Send(wrongPath, replyFrame, "reply:1", aliceSession, replyProof));
        await CheckStatusAsync(Unauthorized, Send(replyPath, InboxWire.EncodeReply(snapshot, "Different follow-up."), "reply:1", aliceSession, replyProof));
        var response = Aeds.Decode(await OkBytes(Send(replyPath, replyFrame, "reply:1", aliceSession, replyProof), ct), FrameType.ConversationMessage);
        Assert.Equal(id, BinaryPrimitives.ReadInt64LittleEndian(response[8..]));
        var persisted = await InTransaction(db, alice, inbox => inbox.GetAsync(id, null, 50, ct), ct);
        Assert.Equal(new[] { "I need help.", "A follow-up." }, persisted!.Messages.Select(m => m.Body));

        async Task<HttpResponseMessage> Send(string path, byte[] frame, string command, string token, string? work = null, bool issuing = false)
        {
            using var request = SiteAedsFixture.Request(HttpMethod.Post, path, frame, token, handle: null);
            request.Headers.Add(WireHeaders.ClientMutationId, command);
            if (issuing) request.Headers.Add(WireHeaders.PowClientNonce, ClientNonce);
            if (work is not null) request.Headers.Add(WireHeaders.PowProof, work);
            return await server.Client.SendAsync(request, ct);
        }

        async Task<string> Challenge(string path, byte[] frame, string command, string token) =>
            PowFixture.SolveFrame(await OkBytes(Send(path, frame, command, token, issuing: true), ct), ClientNonce, ct);
    }

    private const string ClientNonce = "253ad5c923194c56b9d7e6622ffabeab";

    [PostgresFact]
    public async Task InboxSocketOnlyWakesForOwnedCommitAndClosesOnRevocation()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var (alice, aliceSession, _) = await db.SignInSiteUser("alice", ct, minutes: 1);
        var (_, bobSession, _) = await db.SignInSiteUser("bob", ct, minutes: 1);
        await using var server = await ServerProcess.Start(db.ConnectionString, ct);
        var origin = server.Client.BaseAddress!.GetLeftPart(UriPartial.Authority);
        var address = new UriBuilder(origin) { Scheme = "ws", Path = WireRoutes.InboxStream }.Uri;

        foreach (var (source, token, expected) in new[]
        {
            ("https://another.invalid", (string?)aliceSession, Forbidden),
            (origin, (string?)null, Unauthorized)
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
        await db.WithConnection(async connection =>
        {
            await using var tx = await connection.BeginTransactionAsync(ct);
            await new InboxStore(connection, tx, alice).SendNoticeAsync("will-rollback", "Rolled back", "No event", ct);
            await tx.RollbackAsync(ct);
        }, ct);
        Assert.False(ownFrame.IsCompleted);
        await InTransaction(db, alice, inbox => inbox.SendNoticeAsync("committed", "A notice", "Private body", ct), ct);
        var frame = await ownFrame.WaitAsync(TimeSpan.FromSeconds(8), ct);
        Assert.Equal((WebSocketMessageType.Binary, true), (frame.MessageType, frame.EndOfMessage));
        Assert.Equal(Wire.EncodeEmptySuccess(), payload[..frame.Count]);
        Assert.False(unrelated.IsCompleted);

        Assert.Equal(1, await db.Exec("update public.blog_user set generation=generation+1 where id=$1", alice));
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
        var (alice, aliceSession, _) = await db.SignInSiteUser("alice", ct, minutes: 1);
        var (_, bobSession, _) = await db.SignInSiteUser("bob", ct, minutes: 1);
        await using var server = await ServerProcess.Start(db.ConnectionString, ct,
            new Dictionary<string, string> { ["FSUSBLOG_PRIVATE_INBOX_WRITES"] = "false" });
        var client = server.Client;

        await CheckStatusAsync(Unauthorized, client.GetAsync(WireRoutes.InboxReplay, ct));
        using var disabled = Ok(await InboxGet(client, WireRoutes.InboxWriteAvailability, aliceSession, ct));
        Assert.Equal("0", Assert.Single(disabled.Headers.GetValues(WireHeaders.InboxWriteEnabled)));
        Assert.Equal(FrameType.EmptySuccess, Kind(await disabled.Content.ReadAsByteArrayAsync(ct)));
        await CheckStatusAsync(NotFound, client.PostAsync(WireRoutes.InboxList, null, ct));
        await InTransaction(db, alice, inbox => inbox.SendNoticeAsync("before-opening", "Notice", "Already seen", ct), ct);
        using var list = Ok(await InboxGet(client, WireRoutes.InboxList, aliceSession, ct));
        Assert.Equal(FrameType.ConversationList, Kind(await list.Content.ReadAsByteArrayAsync(ct)));
        var cursor = Cursor(list);

        var notice = await InTransaction(db, alice, inbox => inbox.SendNoticeAsync("after-opening", "Notice", "New notice", ct), ct);
        var replayPath = $"{WireRoutes.InboxReplay}?after={cursor}&limit=1";
        using var first = Ok(await InboxGet(client, replayPath, aliceSession, ct));
        Assert.True(first.Headers.CacheControl?.NoStore);
        var firstPayload = Aeds.Decode(await first.Content.ReadAsByteArrayAsync(ct), FrameType.InboxReplay).ToArray();
        Assert.Equal((1, WireLayouts.InboxReplayHasMore, notice.Message.Id),
            (EventCount(firstPayload), firstPayload[1], BinaryPrimitives.ReadInt64LittleEndian(firstPayload.AsSpan(36))));

        var secondPayload = Aeds.Decode(await OkBytes(InboxGet(client, $"{WireRoutes.InboxReplay}?after={Cursor(first)}", aliceSession, ct), ct),
            FrameType.InboxReplay);
        Assert.Equal((1, WireLayouts.InboxMessageAppend), (EventCount(secondPayload), BinaryPrimitives.ReadInt32LittleEndian(secondPayload[24..])));

        Assert.Equal(FrameType.ApiError, Kind(await ExpectBytes(Conflict, InboxGet(client, replayPath, bobSession, ct), ct)));
        Assert.Equal(0, EventCount(Aeds.Decode(await OkBytes(InboxGet(client, WireRoutes.InboxReplay, bobSession, ct), ct), FrameType.InboxReplay)));

        Assert.Equal(1, await db.Exec("delete from public.inbox_event where account_id=$1 and sequence=3", alice));
        using var gap = await InboxGet(client, replayPath, aliceSession, ct);
        var gapPayload = Aeds.Decode(await gap.Content.ReadAsByteArrayAsync(ct), FrameType.InboxReplay);
        Assert.Equal((WireLayouts.InboxReplayRequiresResync, 0, false),
            (gapPayload[1], EventCount(gapPayload), gap.Headers.Contains(WireHeaders.InboxReplayCursor)));

        Assert.Equal(1, await db.Exec("update public.blog_user set generation=generation+1 where id=$1", alice));
        using var revoked = Expect(Unauthorized, await InboxGet(client, replayPath, aliceSession, ct));
        Assert.False(revoked.Headers.Contains(WireHeaders.InboxReplayCursor));
    }

    [PostgresFact]
    public async Task MessageMutationReadPositionAndPrivateReplayAreAtomic()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var (alice, bob) = (Guid.NewGuid(), Guid.NewGuid());
        await db.SiteAccountAsync(alice, "alice", ct: ct);
        await db.SiteAccountAsync(bob, "bob", ct: ct);

        var ticket = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ =>
            InTransaction(db, alice, inbox => inbox.CreateAsync("ticket:1", "Support", "A ticket", ct), ct)));
        Assert.Single(ticket, result => !result.Replayed);
        var opening = ticket[0].Message;
        Assert.All(ticket, item => Assert.Equal(opening, item.Message));

        var notice = await InTransaction(db, alice, inbox => inbox.SendNoticeAsync("ticket:1", "Notice", "For Alice", ct), ct);
        var repeat = await InTransaction(db, alice, inbox => inbox.SendNoticeAsync("ticket:1", "Notice", "For Alice", ct), ct);
        Assert.True(repeat.Replayed);
        Assert.Equal(notice.Message, repeat.Message);

        var unread = await InTransaction(db, alice, inbox => inbox.ListAsync(null, 20, "unread", ct), ct);
        Assert.Equal((notice.Message.ConversationId, 1), (Assert.Single(unread.Conversations).Id, unread.Total));
        Assert.Empty((await InTransaction(db, bob, inbox => inbox.ListAsync(null, 20, null, ct), ct)).Conversations);
        Assert.Null(await InTransaction(db, bob, inbox => inbox.GetAsync(opening.ConversationId, null, 50, ct), ct));

        await BusinessAssert.Denied(Rejection.Invalid, () => InTransaction(db, alice,
            inbox => inbox.MarkReadAsync(opening.ConversationId, notice.Message.Id, ct), ct));
        await BusinessAssert.Denied(Rejection.NotFound, () => InTransaction(db, bob,
            inbox => inbox.MarkReadAsync(opening.ConversationId, opening.Id, ct), ct));
        var internalId = await db.Scalar<long>("""
            INSERT INTO public.inbox_message (conversation_id, sender, is_internal, body, sent_at)
            VALUES ($1, 1, true, 'Internal staff note', clock_timestamp()) RETURNING id
            """, opening.ConversationId);
        await BusinessAssert.Denied(Rejection.Invalid, () => InTransaction(db, alice,
            inbox => inbox.MarkReadAsync(opening.ConversationId, internalId, ct), ct));

        var reply = await InTransaction(db, alice, inbox => inbox.ReplyAsync(opening.ConversationId, opening.Id, "reply-1", "Follow up", ct), ct);
        await BusinessAssert.Denied(Rejection.Conflict, () => InTransaction(db, alice,
            inbox => inbox.ReplyAsync(opening.ConversationId, opening.Id, "reply-1", "Other text", ct), ct));
        var current = await InTransaction(db, alice, inbox => inbox.GetAsync(opening.ConversationId, null, 50, ct), ct);
        Assert.Equal([opening.Id, reply.Message.Id], current!.Messages.Select(message => message.Id));

        Assert.Equal(0, (await InTransaction(db, alice, inbox => inbox.MarkReadAsync(notice.Message.ConversationId, notice.Message.Id, ct), ct)).UnreadCount);
        var first = await InTransaction(db, alice, inbox => inbox.ReplayAsync(0, 2, ct), ct);
        Assert.True(first.HasMore);
        Assert.Equal([1L, 2L], first.Events.Select(item => item.Sequence));
        var second = await InTransaction(db, alice, inbox => inbox.ReplayAsync(first.Next, 20, ct), ct);
        Assert.Equal((false, false, InboxEventKind.ReadUpdated), (second.HasMore, second.RequiresResync, second.Events[^1].Kind));
        Assert.DoesNotContain(first.Events.Concat(second.Events), item => item.MessageId == internalId);
        Assert.Empty((await InTransaction(db, bob, inbox => inbox.ReplayAsync(0, 20, ct), ct)).Events);
        Assert.True((await InTransaction(db, bob, inbox => inbox.ReplayAsync(second.Next, 20, ct), ct)).RequiresResync);

        await db.WithConnection(async connection =>
        {
            await using var transaction = await connection.BeginTransactionAsync(ct);
            await new InboxStore(connection, transaction, alice).SendNoticeAsync("rollback", "Temporary", "Rollback me", ct);
            await transaction.RollbackAsync(ct);
        }, ct);
        var afterRollback = await InTransaction(db, alice, inbox => inbox.ReplayAsync(second.Next, 20, ct), ct);
        Assert.Empty(afterRollback.Events);
        Assert.Equal(second.Next, afterRollback.Next);
    }

    [PostgresFact]
    public async Task FirstListPageFreezesMessageVisibilityAcrossNewActivity()
    {
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var user = Guid.NewGuid();
        await db.SiteAccountAsync(user, "reader", ct: ct);
        var older = await InTransaction(db, user, inbox => inbox.CreateAsync("older", "First", "Old preview", ct), ct);
        var newer = await InTransaction(db, user, inbox => inbox.CreateAsync("newer", "Second", "New preview", ct), ct);
        var first = await InTransaction(db, user, inbox => inbox.ListAsync(null, 1, null, ct), ct);
        Assert.Equal(newer.Message.ConversationId, Assert.Single(first.Conversations).Id);
        Assert.NotNull(first.Next);

        var reply = await InTransaction(db, user, inbox =>
            inbox.ReplyAsync(older.Message.ConversationId, older.Message.Id, "recent", "Future preview", ct), ct);
        var second = await InTransaction(db, user, inbox => inbox.ListAsync(first.Next, 1, null, ct), ct);
        var oldPreview = Assert.Single(second.Conversations);
        Assert.Equal((2, older.Message.ConversationId, "Old preview"), (second.Total, oldPreview.Id, oldPreview.Preview));
        Assert.Equal(reply.Message, Assert.Single((await InTransaction(db, user, inbox =>
            inbox.DeltaAsync(older.Message.ConversationId, older.Message.Id, 50, ct), ct))!.Messages));
    }

    private static Task<T> InTransaction<T>(ScratchDatabase db, Guid user, Func<InboxStore, Task<T>> operation, CancellationToken ct) =>
        db.InTx((connection, transaction) => operation(new InboxStore(connection, transaction, user)), ct);

    private static Task<HttpResponseMessage> InboxGet(HttpClient client, string path, string session, CancellationToken ct) =>
        SiteAedsFixture.Send(client, HttpMethod.Get, path, frame: null, session, handle: null, ct);

    private static FrameType Kind(byte[] frame) { Aeds.Decode(frame, out var type); return type; }
    private static string Cursor(HttpResponseMessage response) => Assert.Single(response.Headers.GetValues(WireHeaders.InboxReplayCursor));
    private static int EventCount(ReadOnlySpan<byte> payload) => BinaryPrimitives.ReadInt32LittleEndian(payload[4..]);
}
