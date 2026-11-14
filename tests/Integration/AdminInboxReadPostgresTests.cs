using System.Buffers.Binary;
using System.Net;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core.Communication;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminInboxReadPostgresTests
{
    [PostgresFact]
    public async Task IndependentAdministratorsShareOnlyExactVisibleReadSnapshots()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var account = Guid.NewGuid();
        var firstAdmin = Guid.NewGuid();
        var secondAdmin = Guid.NewGuid();
        var firstToken = Secret();
        var secondToken = Secret();
        var accountToken = Secret();
        await Administrator(firstAdmin, "read-support-one", firstToken);
        await Administrator(secondAdmin, "read-support-two", secondToken);
        await Sql("insert into public.blog_user (id,name,can_author,enabled,generation) values ($1,'read-our-own',false,true,1)", account);
        await Sql("insert into public.user_session(digest,user_id,generation,expires_at) values($1,$2,1,now()+interval '5 minutes')",
            Store.TokenDigest(accountToken)!, account);
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            var inbox = new InboxStore(db, tx, account);
            await inbox.CreateAsync("ticket-shared-read", "Reported support case", "Initial account message", ct);
            await inbox.SendNoticeAsync("fixture-notice-read", "System notice", "System message", ct);
            await tx.CommitAsync(ct);
        }
        var ticket = (long)(await Scalar("select id from public.inbox_conversation where not is_system"))!;
        var initial = (long)(await Scalar("select read_through from public.inbox_conversation where id=$1", ticket))!;
        // An internal-only head must never be endorsed as a shared read coordinate.
        await Sql("""
            insert into public.inbox_message(conversation_id,sender,is_internal,body,sent_at)
            select $1,1,value=25,'Support fixture '||value,clock_timestamp() from generate_series(1,25) value
            """, ticket);
        var internalId = (long)(await Scalar("select id from public.inbox_message where is_internal"))!;
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, new Dictionary<string, string>
        {
            ["FSUSBLOG_ADMIN_ORIGIN"] = "http://localhost", ["FSUSBLOG_ADMIN_RP_ID"] = "localhost",
            [AdminInboxEndpoints.SharedReadSetting] = "true"
        });
        var queue = WireRoutes.AdminInboxQueue + "?shared=1&status=unread";
        var detail = WireRoutes.AdminInboxThread.Replace("{id:long}", ticket.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);
        var ack = WireRoutes.AdminInboxAcknowledge.Replace("{id:long}", ticket.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);
        var untouchedAccount = (await Send(WireRoutes.InboxReplay, accountToken, HttpStatusCode.OK, site: true)).Body;

        await Send(queue, accountToken, HttpStatusCode.Unauthorized);
        await Send(ack, firstToken, HttpStatusCode.NotFound, through: initial, outside: true);
        var list = await Send(queue, firstToken, HttpStatusCode.OK);
        using (var rows = Read(list.Body, FrameType.AdminInboxSharedPage))
        {
            Assert.Empty(Text(rows));
            Assert.Equal(1, rows.ReadInt32());
            Assert.Equal(ticket, rows.ReadInt64());
            Assert.Equal(1, Unread(rows, afterId: true));
        }
        var legacy = await Send(detail, firstToken, HttpStatusCode.OK);
        Assert.Null(legacy.Snapshot);
        using (var thread = Read(legacy.Body, FrameType.AdminInboxThread)) Assert.Equal(ticket, thread.ReadInt64());
        var newest = await Send(detail + "?shared=1", firstToken, HttpStatusCode.OK);
        Assert.NotNull(newest.Snapshot);
        using var frame = Read(newest.Body, FrameType.AdminInboxSharedThread);
        Assert.Equal(1, Unread(frame));
        var olderCursor = Text(frame);
        Assert.NotEmpty(olderCursor);
        var latest = Messages(frame);
        Assert.Equal(internalId, latest[^1].Id);
        Assert.True(latest[^1].Internal);
        long boundary = latest[^2].Id;
        var older = await Send(detail + "?shared=1&before=" + olderCursor, firstToken, HttpStatusCode.OK);
        Assert.Null(older.Snapshot);
        Assert.Equal(0L, await Scalar("select count(*) from public.inbox_admin_read"));
        await Send(ack, firstToken, HttpStatusCode.Conflict, newest.Snapshot, internalId);
        await Send(ack, secondToken, HttpStatusCode.Conflict, newest.Snapshot, boundary);

        long newcomer;
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            var appended = await new InboxStore(db, tx, account).ReplyAsync(ticket, initial, "raced-after-page", "Arrived after snapshot", ct);
            newcomer = appended.Message.Id;
            await tx.CommitAsync(ct);
        }
        var finalAccount = (await Send(WireRoutes.InboxReplay, accountToken, HttpStatusCode.OK, site: true)).Body;
        Assert.NotEqual(untouchedAccount, finalAccount);
        Assert.Equal("1", (await Send(ack, firstToken, HttpStatusCode.OK, newest.Snapshot, boundary)).Unread);
        Assert.Equal(boundary, await Scalar("select read_through from public.inbox_admin_read"));
        var second = await Send(detail + "?shared=1", secondToken, HttpStatusCode.OK);
        using (var secondFrame = Read(second.Body, FrameType.AdminInboxSharedThread))
            Assert.Equal(1, Unread(secondFrame));
        var outcomes = await Task.WhenAll(
            Send(ack, secondToken, HttpStatusCode.OK, second.Snapshot, newcomer),
            Send(ack, firstToken, HttpStatusCode.OK, newest.Snapshot, boundary));
        Assert.Equal("0", outcomes[0].Unread);
        Assert.Equal(newcomer, await Scalar("select read_through from public.inbox_admin_read"));
        Assert.Equal(secondAdmin, await Scalar("select principal_id from public.inbox_admin_read"));
        Assert.Equal("0", (await Send(ack, firstToken, HttpStatusCode.OK, newest.Snapshot, boundary)).Unread);
        Assert.Equal(secondAdmin, await Scalar("select principal_id from public.inbox_admin_read"));
        using var remaining = Read((await Send(queue, firstToken, HttpStatusCode.OK)).Body, FrameType.AdminInboxSharedPage);
        Assert.Empty(Text(remaining));
        Assert.Equal(0, remaining.ReadInt32());
        Assert.Equal(initial, await Scalar("select read_through from public.inbox_conversation where id=$1", ticket));
        Assert.Equal(finalAccount, (await Send(WireRoutes.InboxReplay, accountToken, HttpStatusCode.OK, site: true)).Body);
        await Sql("update public.admin_principal set generation=generation+1 where id=$1", secondAdmin);
        await Send(ack, secondToken, HttpStatusCode.Unauthorized, second.Snapshot, newcomer);

        async Task<(byte[] Body, string? Snapshot, string? Unread)> Send(string path, string token, HttpStatusCode expectation,
            string? snapshot = null, long? through = null, bool site = false, bool outside = false)
        {
            using var request = new HttpRequestMessage(through.HasValue ? HttpMethod.Post : HttpMethod.Get, path);
            if (!site && !outside) request.Headers.Host = "localhost";
            request.Headers.Add("Cookie", $"{(site ? "fsus-v2-session" : "fsus-v2-admin-session")}={token}");
            if (through.HasValue)
            {
                var payload = new byte[8];
                BinaryPrimitives.WriteInt64LittleEndian(payload, through.Value);
                request.Content = new ByteArrayContent(Aeds.Encode(FrameType.ConversationReadRequest, payload));
                request.Content.Headers.ContentType = new(Aeds.ContentType);
            }
            if (snapshot is not null) request.Headers.Add(WireHeaders.AdminInboxReadSnapshot, snapshot);
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(expectation, response.StatusCode);
            return (await response.Content.ReadAsByteArrayAsync(ct),
                response.Headers.TryGetValues(WireHeaders.AdminInboxReadSnapshot, out var tokens) ? Assert.Single(tokens) : null,
                response.Headers.TryGetValues(WireHeaders.AdminInboxUnread, out var counts) ? Assert.Single(counts) : null);
        }

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
            await using var query = Store.Sql(db, null, sql, args);
            await query.ExecuteNonQueryAsync(ct);
        }

        async Task<object?> Scalar(string sql, params object[] args)
        {
            await using var query = Store.Sql(db, null, sql, args);
            return await query.ExecuteScalarAsync(ct);
        }
    }

    private static BinaryReader Read(byte[] frame, FrameType type) => new(new MemoryStream(Aeds.Decode(frame, type).ToArray()));
    private static string Text(BinaryReader row) => System.Text.Encoding.UTF8.GetString(row.ReadBytes(row.ReadInt32()));

    private static int Unread(BinaryReader row, bool afterId = false)
    {
        if (!afterId) row.ReadInt64();
        row.ReadBytes(16);
        Text(row);
        row.ReadInt32();
        row.ReadBoolean();
        row.ReadInt64();
        return row.ReadInt32();
    }

    private static (long Id, bool Internal)[] Messages(BinaryReader row) => Enumerable.Range(0, row.ReadInt32()).Select(_ =>
    {
        var id = row.ReadInt64();
        row.ReadInt32();
        var hidden = row.ReadBoolean();
        row.ReadInt64();
        Text(row);
        return (id, hidden);
    }).ToArray();

    private static string Secret() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
}
