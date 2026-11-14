using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminInboxPostgresTests
{
    [PostgresFact]
    public async Task CurrentIndependentAdministratorCanPageWithoutMutatingAccountVisibility()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var admin = Guid.NewGuid();
        var other = Guid.NewGuid();
        var user = Guid.NewGuid();
        var adminToken = Secret();
        var otherToken = Secret();
        var siteToken = Secret();
        await Administrator(admin, "support-primary", adminToken);
        await Administrator(other, "support-another", otherToken);
        await Sql("insert into public.blog_user(id,name,can_author,enabled,generation) values($1,'support-site',true,true,1)", user);
        await Sql("insert into public.user_session(digest,user_id,generation,expires_at) values($1,$2,1,now()+interval '5 minutes')",
            Store.TokenDigest(siteToken)!, user);
        await Sql("""
            insert into public.inbox_conversation(id,account_id,subject,status,is_system,last_message_at)
            select id,$1,'Support case '||id,case when id=1 then 2 else 0 end,false,now() from generate_series(1,26) id
            """, user);
        await Sql("""
            insert into public.inbox_message(conversation_id,id,sender,is_internal,body,sent_at)
            select id,id,0,false,'Customer started '||id,now() from generate_series(1,26) id;
            update public.inbox_conversation set last_message_id=id,read_through=id;
            insert into public.inbox_message(conversation_id,id,sender,is_internal,body,sent_at)
            select 26,id,1,id=100,case when id=100 then 'invisible internal text' else 'Response '||id end,now()
            from generate_series(100,124) id;
            update public.inbox_conversation set last_message_id=124 where id=26
            """);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            ["FSUSBLOG_ADMIN_ORIGIN"] = "http://localhost", ["FSUSBLOG_ADMIN_RP_ID"] = "localhost"
        });
        await Get(WireRoutes.AdminInboxQueue, HttpStatusCode.NotFound, adminToken, host: false);
        await Get(WireRoutes.AdminInboxQueue, HttpStatusCode.Unauthorized, siteToken, site: true);
        await Get(WireRoutes.AdminInboxQueue, HttpStatusCode.Unauthorized, siteToken);
        var first = Page(await Get(WireRoutes.AdminInboxQueue, HttpStatusCode.OK, adminToken));
        Assert.Equal(Enumerable.Range(3, 24).Reverse().Select(i => (long)i), first.Ids);
        Assert.NotEmpty(first.Cursor);
        var next = $"{WireRoutes.AdminInboxQueue}?cursor={first.Cursor}";
        await Get(next, HttpStatusCode.BadRequest, otherToken);
        await Get(next + "&status=open", HttpStatusCode.BadRequest, adminToken);
        Assert.Equal(new long[] { 2, 1 }, Page(await Get(next, HttpStatusCode.OK, adminToken)).Ids);
        Assert.Equal(new long[] { 1 }, Page(await Get(WireRoutes.AdminInboxQueue + "?status=closed", HttpStatusCode.OK, adminToken)).Ids);
        var thread = WireRoutes.AdminInboxThread.Replace("{id:long}", "26", StringComparison.Ordinal);
        using var newest = Reader(await Get(thread, HttpStatusCode.OK, adminToken), FrameType.AdminInboxThread);
        Assert.Equal(26L, InboxId(newest));
        string older = Text(newest);
        Assert.NotEmpty(older);
        var latest = Messages(newest);
        Assert.Equal(24, latest.Count);
        Assert.Equal(101, latest[0].Id);
        using var historical = Reader(await Get(thread + "?before=" + older, HttpStatusCode.OK, adminToken), FrameType.AdminInboxThread);
        Assert.Equal(26L, InboxId(historical));
        Assert.Empty(Text(historical));
        var earliest = Messages(historical);
        Assert.Equal(new long[] { 26, 100 }, earliest.Select(message => message.Id));
        Assert.True(earliest[1].Internal);
        Assert.Equal("invisible internal text", earliest[1].Body);
        await Get(thread.Replace("26.aeds", "25.aeds", StringComparison.Ordinal) + "?before=" + older, HttpStatusCode.BadRequest, adminToken);
        var account = await Get(WireRoutes.InboxDetail.Replace("{id:long}", "26", StringComparison.Ordinal), HttpStatusCode.OK, siteToken,
            host: false, site: true);
        Assert.Equal(-1, account.AsSpan().IndexOf("invisible internal text"u8));
        await using (var stored = Store.Sql(db, null, "select read_through from public.inbox_conversation where id=26"))
            Assert.Equal(26L, await stored.ExecuteScalarAsync(ct));
        await Sql("update public.admin_principal set generation=generation+1 where id=$1", admin);
        await Get(thread, HttpStatusCode.Unauthorized, adminToken);

        async Task Administrator(Guid id, string handle, string token)
        {
            await Sql("insert into public.admin_principal(id,handle,user_handle,enabled,generation) values($1,$2,$3,true,1)", id,
                handle, RandomNumberGenerator.GetBytes(32));
            await Sql("insert into public.admin_passkey_credential values($1,$2,$3,0,false,false)", RandomNumberGenerator.GetBytes(8), id, new byte[] { 2 });
            await Sql("insert into public.admin_permission values($1,$2)", id, CurrentSchema.AdminManagePermission);
            await Sql("insert into public.admin_session values($1,$2,1,now()+interval '5 minutes')", Store.TokenDigest(token)!, id);
        }

        async Task Sql(string sql, params object[] args)
        {
            await using var cmd = Store.Sql(db, null, sql, args);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        async Task<byte[]> Get(string path, HttpStatusCode expected, string secret, bool host = true, bool site = false)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            if (host) request.Headers.Host = "localhost";
            request.Headers.Add("Cookie", $"{(site ? "fsus-v2-session" : "fsus-v2-admin-session")}={secret}");
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(expected, response.StatusCode);
            if (response.IsSuccessStatusCode) Assert.True(response.Headers.CacheControl?.NoStore);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }
    }

    private static (string Cursor, long[] Ids) Page(byte[] frame)
    {
        using var reader = Reader(frame, FrameType.AdminInboxPage);
        var cursor = Text(reader);
        return (cursor, Enumerable.Range(0, reader.ReadInt32()).Select(_ => InboxId(reader)).ToArray());
    }

    private static long InboxId(BinaryReader reader)
    {
        var id = reader.ReadInt64();
        reader.ReadBytes(16);
        Text(reader);
        reader.ReadInt32();
        reader.ReadBoolean();
        reader.ReadInt64();
        return id;
    }

    private static List<(long Id, bool Internal, string Body)> Messages(BinaryReader reader)
    {
        int count = reader.ReadInt32();
        List<(long Id, bool Internal, string Body)> result = [];
        for (var i = 0; i < count; ++i)
        {
            var id = reader.ReadInt64();
            reader.ReadInt32();
            var hidden = reader.ReadBoolean();
            reader.ReadInt64();
            result.Add((id, hidden, Text(reader)));
        }
        return result;
    }

    private static BinaryReader Reader(byte[] frame, FrameType type) => new(new MemoryStream(Aeds.Decode(frame, type).ToArray()));
    private static string Text(BinaryReader reader) => Encoding.UTF8.GetString(reader.ReadBytes(reader.ReadInt32()));
    private static string Secret() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
}
