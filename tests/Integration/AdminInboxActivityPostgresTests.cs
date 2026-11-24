using static FsusBlog.V2.Integration.Tests.InboxFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminInboxActivityPostgresTests
{
    [PostgresFact]
    public async Task ActivityPagesPinTheLatestVisibleMessageAcrossCommitsAndPreserveLiveFilters()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (owner, secondOwner) = (Guid.NewGuid(), Guid.NewGuid());
        var admin = (await fixture.AdminAsync("activity-admin", 5, RandomNumberGenerator.GetBytes(8), [2], ct)).Token;
        var other = (await fixture.AdminAsync("other-activity-admin", 5, RandomNumberGenerator.GetBytes(8), [2], ct)).Token;
        await fixture.Exec("""
            insert into public.blog_user(id,name,enabled,generation)
            values($1,'activity-reader',true,1),($2,'activity-notice-recipient',true,1)
            """, owner, secondOwner);
        await fixture.Exec("""
            insert into public.inbox_conversation(id,account_id,subject,status,is_system,last_message_at)
            select id,$1,'Ticket '||id,0,false,'2022-01-01 UTC' from generate_series(1,27) id
            """, owner);
        await fixture.Exec("""
            insert into public.inbox_message(conversation_id,id,sender,is_internal,body,sent_at)
            select id,id,0,id=27,'Fixture message',timestamp with time zone '2022-01-01 UTC'
                + case when id=1 then interval '1 second' when id=3 then interval '4 microseconds'
                    when id=4 then interval '3 microseconds' else interval '5 microseconds' end
            from generate_series(1,27) id;
            update public.inbox_conversation set last_message_id=id;
            insert into public.inbox_message(conversation_id,id,sender,is_internal,body,sent_at)
            values (2,28,1,true,'Internal annotation',now());
            update public.inbox_conversation set last_message_id=28,last_message_at=now() where id=2;
            select setval(pg_get_serial_sequence('public.inbox_conversation','id'),27);
            select setval(pg_get_serial_sequence('public.inbox_message','id'),28)
            """);
        await using var server = await StartAdmin(fixture, ct, "FSUSBLOG_ADMIN_INBOX_SHARED_READ", InboxActivityFence.Setting);
        const string activity = "?order=activity&shared=1";
        var legacy = Page(await Get("", admin), FrameType.AdminInboxPage);
        Assert.Equal(27L, legacy.Ids[0]);
        var first = Page(await Get(activity, admin), FrameType.AdminInboxSharedPage);
        Assert.Equal(new long[] { 1 }.Concat(Enumerable.Range(5, 22).Reverse().Select(value => (long)value)).Append(2), first.Ids);
        Assert.Equal(75, first.Cursor.Length);
        foreach (var (query, tok) in new[]
        {
            (activity + "&cursor=" + first.Cursor, other),
            (activity + "&status=unread&cursor=" + first.Cursor, admin),
            ("?shared=1&cursor=" + first.Cursor, admin),
            (activity + "&cursor=" + legacy.Cursor, admin),
        })
            await Get(query, tok, BadRequest);

        await fixture.InTx(async (db, tx) =>
        {
            var inbox = new InboxStore(db, tx, owner, fenceVisibleMessages: true);
            await inbox.AppendAdministratorReply(4, "Visible reply newer than first snapshot", ct);
            await inbox.SendNoticeAsync("activity-new-notice", "New visible conversation", "New after first page", ct);
        }, ct);
        await fixture.Exec("update public.inbox_conversation set status=1 where id=4");
        var second = Page(await Get(activity + "&cursor=" + first.Cursor, admin), FrameType.AdminInboxSharedPage);
        Assert.Equal(new long[] { 3, 4 }, second.Ids);
        Assert.Empty(second.Cursor);
        Assert.Equal(new long[] { 28, 4, 1 }, Page(await Get(activity, admin), FrameType.AdminInboxSharedPage).Ids.Take(3));
        Assert.Equal(new long[] { 4 }, Page(await Get(activity + "&status=pending", admin), FrameType.AdminInboxSharedPage).Ids);

        // A lower allocated ID cannot commit behind the first page's higher snapshot.
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await using var held = await db.BeginTransactionAsync(ct);
        var pending = await new InboxStore(db, held, secondOwner, fenceVisibleMessages: true)
            .SendNoticeAsync("delay-between-insert-and-commit", "Paused notice", "Committed before anchor", ct);
        long later = await fixture.InTx(async (concurrent, committed) =>
            (await new InboxStore(concurrent, committed, owner, fenceVisibleMessages: true)
                .SendNoticeAsync("commit-ahead", "Committed notice", "Allocated after paused notice", ct)).Message.ConversationId, ct);
        var waiting = Get(activity, admin);
        for (var attempt = 0; ; attempt++)
        {
            if (await fixture.Scalar<bool>("""
                SELECT EXISTS (SELECT FROM pg_locks WHERE locktype='advisory' AND NOT granted
                    AND mode='ExclusiveLock' AND objid=2 AND database=(select oid from pg_database where datname=current_database()))
                """)) break;
            Assert.True(attempt < 30, "The first page never waited for the paused inbox writer.");
            await Task.Delay(25, ct);
        }
        Assert.False(waiting.IsCompleted);
        await held.CommitAsync(ct);
        Assert.Equal(new[] { later, pending.Message.ConversationId }, Page(await waiting, FrameType.AdminInboxSharedPage).Ids.Take(2));

        async Task<byte[]> Get(string query, string token, HttpStatusCode expected = OK)
        {
            using var request = AdminRequest(HttpMethod.Get, WireRoutes.AdminInboxQueue + query, token);
            using var response = Expect(expected, await server.Client.SendAsync(request, ct));
            if (response.IsSuccessStatusCode)
                Assert.Equal("1", Assert.Single(response.Headers.GetValues(WireHeaders.AdminInboxActivityOrder)));
            return await response.Content.ReadAsByteArrayAsync(ct);
        }
    }
}
