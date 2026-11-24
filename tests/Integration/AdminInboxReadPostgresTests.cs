using FsusBlog.V2.Core.Communication;

using static FsusBlog.V2.Integration.Tests.InboxFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminInboxReadPostgresTests
{
    [PostgresFact]
    public async Task IndependentAdministratorsShareOnlyExactVisibleReadSnapshots()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (firstAdmin, firstToken, _) = await fixture.AdminAsync("read-support-one", 5, RandomNumberGenerator.GetBytes(8), [2], ct);
        var (secondAdmin, secondToken, _) = await fixture.AdminAsync("read-support-two", 5, RandomNumberGenerator.GetBytes(8), [2], ct);
        var (account, accountToken, _) = await fixture.SignInSiteUser("read-our-own", ct, minutes: 5);
        await fixture.InTx(async (db, tx) =>
        {
            var inbox = new InboxStore(db, tx, account);
            await inbox.CreateAsync("ticket-shared-read", "Reported support case", "Initial account message", ct);
            await inbox.SendNoticeAsync("fixture-notice-read", "System notice", "System message", ct);
        }, ct);
        var ticket = await fixture.Scalar<long>("select id from public.inbox_conversation where not is_system");
        var initial = await fixture.Scalar<long>("select read_through from public.inbox_conversation where id=$1", ticket);
        // An internal-only head must never be endorsed as a shared read coordinate.
        await fixture.Exec("""
            insert into public.inbox_message(conversation_id,sender,is_internal,body,sent_at)
            select $1,1,value=25,'Support fixture '||value,clock_timestamp() from generate_series(1,25) value
            """, ticket);
        var internalId = await fixture.Scalar<long>("select id from public.inbox_message where is_internal");
        await using var server = await StartAdmin(fixture, ct, AdminInboxEndpoints.SharedReadSetting);
        var queue = WireRoutes.AdminInboxQueue + "?shared=1&status=unread";
        var detail = WireRoutes.AdminInboxThread.Replace("{id:long}", ticket.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);
        var ack = WireRoutes.AdminInboxAcknowledge.Replace("{id:long}", ticket.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);
        var untouchedAccount = (await Send(WireRoutes.InboxReplay, accountToken, OK, site: true)).Body;

        await Send(queue, accountToken, Unauthorized);
        await Send(ack, firstToken, NotFound, through: initial, outside: true);
        using (var rows = Reader((await Send(queue, firstToken, OK)).Body, FrameType.AdminInboxSharedPage))
            Assert.Equal(("", 1, ticket, 1), (Text(rows), rows.ReadInt32(), rows.ReadInt64(), Unread(rows, afterId: true)));
        var legacy = await Send(detail, firstToken, OK);
        Assert.Null(legacy.Snapshot);
        using (var thread = Reader(legacy.Body, FrameType.AdminInboxThread)) Assert.Equal(ticket, thread.ReadInt64());
        var newest = await Send(detail + "?shared=1", firstToken, OK);
        Assert.NotNull(newest.Snapshot);
        using var frame = Reader(newest.Body, FrameType.AdminInboxSharedThread);
        Assert.Equal(1, Unread(frame));
        var olderCursor = Text(frame);
        Assert.NotEmpty(olderCursor);
        var latest = Messages(frame);
        Assert.Equal((internalId, true), (latest[^1].Id, latest[^1].Internal));
        long boundary = latest[^2].Id;
        Assert.Null((await Send(detail + "?shared=1&before=" + olderCursor, firstToken, OK)).Snapshot);
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.inbox_admin_read"));
        await Send(ack, firstToken, Conflict, newest.Snapshot, internalId);
        await Send(ack, secondToken, Conflict, newest.Snapshot, boundary);

        long newcomer = await fixture.InTx(async (db, tx) =>
            (await new InboxStore(db, tx, account).ReplyAsync(ticket, initial, "raced-after-page", "Arrived after snapshot", ct)).Message.Id, ct);
        var finalAccount = (await Send(WireRoutes.InboxReplay, accountToken, OK, site: true)).Body;
        Assert.NotEqual(untouchedAccount, finalAccount);
        Assert.Equal("1", (await Send(ack, firstToken, OK, newest.Snapshot, boundary)).Unread);
        Assert.Equal(boundary, await fixture.Scalar<long>("select read_through from public.inbox_admin_read"));
        var second = await Send(detail + "?shared=1", secondToken, OK);
        using (var secondFrame = Reader(second.Body, FrameType.AdminInboxSharedThread))
            Assert.Equal(1, Unread(secondFrame));
        var outcomes = await Task.WhenAll(
            Send(ack, secondToken, OK, second.Snapshot, newcomer),
            Send(ack, firstToken, OK, newest.Snapshot, boundary));
        Assert.Equal("0", outcomes[0].Unread);
        Assert.Equal(newcomer, await fixture.Scalar<long>("select read_through from public.inbox_admin_read"));
        Assert.Equal(secondAdmin, await fixture.Scalar<Guid>("select principal_id from public.inbox_admin_read"));
        Assert.Equal("0", (await Send(ack, firstToken, OK, newest.Snapshot, boundary)).Unread);
        Assert.Equal(secondAdmin, await fixture.Scalar<Guid>("select principal_id from public.inbox_admin_read"));
        using var remaining = Reader((await Send(queue, firstToken, OK)).Body, FrameType.AdminInboxSharedPage);
        Assert.Equal(("", 0), (Text(remaining), remaining.ReadInt32()));
        Assert.Equal(initial, await fixture.Scalar<long>("select read_through from public.inbox_conversation where id=$1", ticket));
        Assert.Equal(finalAccount, (await Send(WireRoutes.InboxReplay, accountToken, OK, site: true)).Body);
        await fixture.Exec("update public.admin_principal set generation=generation+1 where id=$1", secondAdmin);
        await Send(ack, secondToken, Unauthorized, second.Snapshot, newcomer);

        async Task<(byte[] Body, string? Snapshot, string? Unread)> Send(string path, string token, HttpStatusCode expectation,
            string? snapshot = null, long? through = null, bool site = false, bool outside = false)
        {
            using var request = AdminRequest(through.HasValue ? HttpMethod.Post : HttpMethod.Get, path, token,
                through.HasValue ? ReadCommand(through.Value) : null, adminHost: !site && !outside, site: site);
            if (snapshot is not null) request.Headers.Add(WireHeaders.AdminInboxReadSnapshot, snapshot);
            using var response = Expect(expectation, await server.Client.SendAsync(request, ct));
            return (await response.Content.ReadAsByteArrayAsync(ct),
                response.Headers.TryGetValues(WireHeaders.AdminInboxReadSnapshot, out var tokens) ? Assert.Single(tokens) : null,
                response.Headers.TryGetValues(WireHeaders.AdminInboxUnread, out var counts) ? Assert.Single(counts) : null);
        }
    }

    private static byte[] ReadCommand(long through)
    {
        var payload = new byte[8];
        BinaryPrimitives.WriteInt64LittleEndian(payload, through);
        return Aeds.Encode(FrameType.ConversationReadRequest, payload);
    }

    private static int Unread(BinaryReader row, bool afterId = false)
    {
        if (!afterId) row.ReadInt64();
        SkipConversationFields(row);
        return row.ReadInt32();
    }
}
