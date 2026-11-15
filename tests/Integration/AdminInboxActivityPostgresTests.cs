using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminInboxActivityPostgresTests
{
    [PostgresFact]
    public async Task ActivityPagesPinTheLatestVisibleMessageAcrossCommitsAndPreserveLiveFilters()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = Guid.NewGuid();
        var secondOwner = Guid.NewGuid();
        var admin = await Administrator("activity-admin");
        var other = await Administrator("other-activity-admin");
        await Sql("""
            insert into public.blog_user(id,name,can_author,enabled,generation)
            values($1,'activity-reader',false,true,1),($2,'activity-notice-recipient',false,true,1)
            """, owner, secondOwner);
        await Sql("""
            insert into public.inbox_conversation(id,account_id,subject,status,is_system,last_message_at)
            select id,$1,'Ticket '||id,0,false,'2022-01-01 UTC' from generate_series(1,27) id
            """, owner);
        await Sql("""
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
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            ["FSUSBLOG_ADMIN_ORIGIN"] = "http://localhost", ["FSUSBLOG_ADMIN_RP_ID"] = "localhost",
            ["FSUSBLOG_ADMIN_INBOX_SHARED_READ"] = "true", [InboxActivityFence.Setting] = "true"
        });
        const string activity = "?order=activity&shared=1";
        var legacy = Page(await Get("", admin), FrameType.AdminInboxPage);
        Assert.Equal(27L, legacy.Ids[0]);
        var first = Page(await Get(activity, admin), FrameType.AdminInboxSharedPage);
        Assert.Equal(new long[] { 1 }.Concat(Enumerable.Range(5, 22).Reverse().Select(value => (long)value)).Append(2), first.Ids);
        Assert.Equal(75, first.Cursor.Length);
        await Get(activity + "&cursor=" + first.Cursor, other, HttpStatusCode.BadRequest);
        await Get(activity + "&status=unread&cursor=" + first.Cursor, admin, HttpStatusCode.BadRequest);
        await Get("?shared=1&cursor=" + first.Cursor, admin, HttpStatusCode.BadRequest);
        await Get(activity + "&cursor=" + legacy.Cursor, admin, HttpStatusCode.BadRequest);

        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            var inbox = new InboxStore(db, tx, owner, fenceVisibleMessages: true);
            await inbox.AppendAdministratorReply(4, "Visible reply newer than first snapshot", ct);
            await inbox.SendNoticeAsync("activity-new-notice", "New visible conversation", "New after first page", ct);
            await tx.CommitAsync(ct);
        }
        await Sql("update public.inbox_conversation set status=1 where id=4");
        var second = Page(await Get(activity + "&cursor=" + first.Cursor, admin), FrameType.AdminInboxSharedPage);
        Assert.Equal(new long[] { 3, 4 }, second.Ids);
        Assert.Empty(second.Cursor);
        var fresh = Page(await Get(activity, admin), FrameType.AdminInboxSharedPage);
        Assert.Equal(new long[] { 28, 4, 1 }, fresh.Ids.Take(3));
        var filter = Page(await Get(activity + "&status=pending", admin), FrameType.AdminInboxSharedPage);
        Assert.Equal(new long[] { 4 }, filter.Ids);

        // A lower allocated ID cannot commit behind the first page's higher snapshot.
        await using var held = await db.BeginTransactionAsync(ct);
        var pending = await new InboxStore(db, held, secondOwner, fenceVisibleMessages: true)
            .SendNoticeAsync("delay-between-insert-and-commit", "Paused notice", "Committed before anchor", ct);
        long later;
        await using (var concurrent = await fixture.DataSource.OpenConnectionAsync(ct))
        await using (var committed = await concurrent.BeginTransactionAsync(ct))
        {
            var inbox = new InboxStore(concurrent, committed, owner, fenceVisibleMessages: true);
            later = (await inbox.SendNoticeAsync("commit-ahead", "Committed notice", "Allocated after paused notice", ct)).Message.ConversationId;
            await committed.CommitAsync(ct);
        }
        var waiting = Get(activity, admin);
        await using (var observe = await fixture.DataSource.OpenConnectionAsync(ct))
        {
            for (var attempt = 0; ; attempt++)
            {
                await using var locks = Store.Sql(observe, null, """
                    SELECT EXISTS (SELECT FROM pg_locks WHERE locktype='advisory' AND NOT granted
                        AND mode='ExclusiveLock' AND objid=2 AND database=(select oid from pg_database where datname=current_database()))
                    """);
                if (await locks.ExecuteScalarAsync(ct) is true) break;
                Assert.True(attempt < 30, "The first page never waited for the paused inbox writer.");
                await Task.Delay(25, ct);
            }
        }
        Assert.False(waiting.IsCompleted);
        await held.CommitAsync(ct);
        var fenced = Page(await waiting, FrameType.AdminInboxSharedPage);
        Assert.Equal(new[] { later, pending.Message.ConversationId }, fenced.Ids.Take(2));

        async Task<byte[]> Get(string query, string token, HttpStatusCode expected = HttpStatusCode.OK)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, WireRoutes.AdminInboxQueue + query);
            request.Headers.Host = "localhost";
            request.Headers.Add("Cookie", $"fsus-v2-admin-session={token}");
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(expected, response.StatusCode);
            if (response.IsSuccessStatusCode)
                Assert.Equal("1", Assert.Single(response.Headers.GetValues(WireHeaders.AdminInboxActivityOrder)));
            return await response.Content.ReadAsByteArrayAsync(ct);
        }

        async Task<string> Administrator(string name)
        {
            var principal = Guid.NewGuid();
            var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
            await Sql("insert into public.admin_principal(id,handle,user_handle,enabled,generation) values($1,$2,$3,true,1)", principal,
                name, RandomNumberGenerator.GetBytes(32));
            await Sql("insert into public.admin_passkey_credential values($1,$2,$3,0,false,false)", RandomNumberGenerator.GetBytes(8), principal, new byte[] { 2 });
            await Sql("insert into public.admin_permission values($1,$2)", principal, CurrentSchema.AdminManagePermission);
            await Sql("insert into public.admin_session values($1,$2,1,now()+interval '5 minutes')", Store.TokenDigest(token)!, principal);
            return token;
        }

        Task Sql(string command, params object[] values) =>
            FixtureSql.ExecuteAsync(db, null, ct, command, values);
    }

    private static (long[] Ids, string Cursor) Page(byte[] frame, FrameType type)
    {
        using var reader = new BinaryReader(new MemoryStream(Aeds.Decode(frame, type).ToArray()));
        var cursor = Encoding.UTF8.GetString(reader.ReadBytes(reader.ReadInt32()));
        long[] ids = new long[reader.ReadInt32()];
        for (var index = 0; index < ids.Length; index++)
        {
            ids[index] = reader.ReadInt64();
            reader.ReadBytes(16);
            reader.ReadBytes(reader.ReadInt32());
            reader.ReadInt32();
            reader.ReadBoolean();
            reader.ReadInt64();
            if (type == FrameType.AdminInboxSharedPage) reader.ReadInt32();
        }
        return (ids, cursor);
    }
}
