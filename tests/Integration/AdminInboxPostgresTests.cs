using System.Net;
using System.Net.WebSockets;
using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;

using static FsusBlog.V2.Integration.Tests.InboxFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminInboxPostgresTests
{
    [PostgresFact]
    public async Task CreationPositionDetectsAnOlderCommittedTicketWithoutAChangeToMaximumId()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (_, adminToken, _) = await FixtureSql.AdminAsync(db, ct, "create-observer", 5, RandomNumberGenerator.GetBytes(8), [2]);
        var firstAccount = Guid.NewGuid();
        var secondAccount = Guid.NewGuid();
        var firstToken = Secret();
        var secondToken = Secret();
        await SeedSession(db, firstAccount, "first ticket account", firstToken, ct);
        await SeedSession(db, secondAccount, "second ticket account", secondToken, ct);

        var accountStore = new Store(fixture.DataSource);
        var adminStore = new AdminInboxStore(new AdminSessionGate(fixture.DataSource, null));
        Assert.Empty(await adminStore.InboxQueuePosition(adminToken, -1, false, ct));
        var denied = await Assert.ThrowsAsync<BusinessException>(() => adminStore.InboxQueuePosition(firstToken, -1, false, ct));
        Assert.Equal(Rejection.Unauthorized, denied.Rejection);

        var allocated = new TaskCompletionSource<long>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = accountStore.WithSession(firstToken, false, async (connection, tx, actor) =>
        {
            long id = await AddTicket(new InboxStore(connection, tx, actor.Id), "allocated-first");
            allocated.SetResult(id);
            await release.Task.WaitAsync(ct);
            return id;
        }, ct);
        long lower, higher;
        try
        {
            // A failed account transaction cannot leave the test waiting for its allocation signal.
            var ready = await Task.WhenAny(allocated.Task, pending).WaitAsync(ct);
            lower = await ready;
            higher = await accountStore.WithSession(secondToken, false, (connection, tx, actor) =>
                AddTicket(new InboxStore(connection, tx, actor.Id), "committed-first"), ct);
            Assert.True(lower < higher);
            Assert.Equal(Position([higher]), await adminStore.InboxQueuePosition(adminToken, -1, false, ct));
            Assert.Equal(higher, await VisibleMaximum());
        }
        finally
        {
            release.TrySetResult();
            await pending;
        }

        Assert.Equal(Position([higher, lower]), await adminStore.InboxQueuePosition(adminToken, -1, false, ct));
        Assert.Equal(higher, await VisibleMaximum());

        // The extra row determines whether a cursor exists. Rows below that boundary cannot change the watch position.
        var newer = await accountStore.WithSession(secondToken, false, async (connection, tx, actor) =>
        {
            var inbox = new InboxStore(connection, tx, actor.Id);
            List<long> ids = [];
            for (var i = 0; i < Wire.AdminInboxPageSize; i++)
                ids.Add(await AddTicket(inbox, $"new-ticket-{i}"));
            return ids;
        }, ct);
        newer.Reverse();
        var bounded = Position(newer.Append(higher));
        Assert.Equal(bounded, await adminStore.InboxQueuePosition(adminToken, -1, false, ct));
        var page = await adminStore.ReadInbox(adminToken, -1, null, ct);
        Assert.Equal(newer, page.Rows.Select(row => row.Id));
        Assert.NotNull(page.Next);
        await Execute("""
            insert into public.inbox_conversation(account_id,subject,status,is_system,last_message_at)
            values($1,'Conversation without messages',0,false,now())
            """, firstAccount);
        Assert.Equal(bounded, await adminStore.InboxQueuePosition(adminToken, -1, false, ct));

        async Task<long> AddTicket(InboxStore inbox, string key) =>
            (await inbox.CreateAsync(key, "Support case", "Account's initial support message", ct)).Message.ConversationId;

        static string Position(IEnumerable<long> ids) => string.Join(",", ids.Select(id => FormattableString.Invariant($"{id}:0:{id}:0")));

        async Task<long> VisibleMaximum()
        {
            return (long)(await FixtureSql.ScalarAsync(db, null, ct, "select max(id) from public.inbox_conversation where last_message_id is not null"))!;
        }

        Task Execute(string sql, params object[] args) =>
            FixtureSql.ExecuteAsync(db, null, ct, sql, args);
    }

    [PostgresFact]
    public async Task CurrentIndependentAdministratorCanPageReplyAndUpdateStatusWithPrivateAccountDelivery()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (admin, adminToken, _) = await FixtureSql.AdminAsync(db, ct, "support-primary", 5, RandomNumberGenerator.GetBytes(8), [2]);
        var (other, otherToken, _) = await FixtureSql.AdminAsync(db, ct, "support-another", 5, RandomNumberGenerator.GetBytes(8), [2]);
        var user = Guid.NewGuid();
        var siteToken = Secret();
        await SeedSession(db, user, "support-site", siteToken, ct, canAuthor: true);
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
        await Sql("select setval(pg_get_serial_sequence('public.inbox_message','id'),124)");
        await using var server = await StartAdmin(fixture, ct,
            AdminInboxEndpoints.ReplySetting, AdminInboxEndpoints.StatusSetting,
            AdminInboxEndpoints.LiveSetting);
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
        Assert.Equal(26L, ConversationId(newest));
        string older = Text(newest);
        Assert.NotEmpty(older);
        var latest = Messages(newest);
        Assert.Equal(24, latest.Count);
        Assert.Equal(101, latest[0].Id);
        using var historical = Reader(await Get(thread + "?before=" + older, HttpStatusCode.OK, adminToken), FrameType.AdminInboxThread);
        Assert.Equal(26L, ConversationId(historical));
        Assert.Empty(Text(historical));
        var earliest = Messages(historical);
        Assert.Equal(new long[] { 26, 100 }, earliest.Select(message => message.Id));
        Assert.True(earliest[1].Internal);
        Assert.Equal("invisible internal text", earliest[1].Body);
        await Get(thread.Replace("26.aeds", "25.aeds", StringComparison.Ordinal) + "?before=" + older, HttpStatusCode.BadRequest, adminToken);
        var account = await Get(WireRoutes.InboxDetail.Replace("{id:long}", "26", StringComparison.Ordinal), HttpStatusCode.OK, siteToken,
            host: false, site: true);
        Assert.Equal(-1, account.AsSpan().IndexOf("invisible internal text"u8));
        const string replyText = "Support member confirmed the account reply.";
        const string command = "support:01";
        const string nonce = "253ad5c923194c56b9d7e6622ffabeab";
        var frame = InboxWire.EncodeAdminReply(replyText);
        var path = WireRoutes.AdminInboxReply.Replace("{id:long}", "26", StringComparison.Ordinal);
        var challenge = WireRoutes.AdminInboxReplyPow.Replace("{id:long}", "26", StringComparison.Ordinal);
        await Post(path, HttpStatusCode.Unauthorized, adminToken, command, frame);
        await Post(challenge, HttpStatusCode.Unauthorized, siteToken, command, frame, nonce);
        await Post(challenge.Replace("/26/", "/1/", StringComparison.Ordinal), HttpStatusCode.Conflict, adminToken, command, frame, nonce);
        var proof = await Work();
        await Post(path, HttpStatusCode.Forbidden, adminToken, command, frame, proof: proof, origin: "http://127.0.0.1");
        await Post(path.Replace("/26/", "/25/", StringComparison.Ordinal), HttpStatusCode.Unauthorized, adminToken, command, frame, proof: proof);
        await Post(path, HttpStatusCode.Unauthorized, otherToken, command, frame, proof: proof);
        await Post(path, HttpStatusCode.Unauthorized, adminToken, "support:other", frame, proof: proof);
        var response = Aeds.Decode(await Post(path, HttpStatusCode.OK, adminToken, command, frame, proof: proof), FrameType.ConversationMessage).ToArray();
        var replyId = BinaryPrimitives.ReadInt64LittleEndian(response);
        Assert.Equal(0, response[29]);
        await Post(path, HttpStatusCode.Unauthorized, adminToken, command, frame, proof: proof);
        var retry = Aeds.Decode(await Post(path, HttpStatusCode.OK, adminToken, command, frame, proof: await Work()), FrameType.ConversationMessage).ToArray();
        Assert.Equal(replyId, BinaryPrimitives.ReadInt64LittleEndian(retry));
        Assert.Equal(1, retry[29]);
        var receipt = await Get(WireRoutes.InboxDetail.Replace("{id:long}", "26", StringComparison.Ordinal), HttpStatusCode.OK, siteToken,
            host: false, site: true);
        Assert.True(receipt.AsSpan().IndexOf(Encoding.UTF8.GetBytes(replyText)) >= 0);
        var accountDetail = Aeds.Decode(receipt, FrameType.ConversationDetailV3).ToArray();
        Assert.Equal(25, BinaryPrimitives.ReadInt32LittleEndian(accountDetail.AsSpan(12)));
        var replay = await Get(WireRoutes.InboxReplay, HttpStatusCode.OK, siteToken, host: false, site: true);
        var replayData = Aeds.Decode(replay, FrameType.InboxReplay).ToArray();
        Assert.Equal(2, BinaryPrimitives.ReadInt32LittleEndian(replayData.AsSpan(4)));
        await using (var audit = Store.Sql(db, null, """
            select principal_id,session_reference,conversation_id,message_id from public.inbox_admin_reply
            """))
        await using (var rows = await audit.ExecuteReaderAsync(ct))
        {
            Assert.True(await rows.ReadAsync(ct));
            Assert.Equal(admin, rows.GetGuid(0));
            Assert.Equal(SHA256.HashData(Store.TokenDigest(adminToken)!), rows.GetFieldValue<byte[]>(1));
            Assert.Equal(26L, rows.GetInt64(2));
            Assert.Equal(replyId, rows.GetInt64(3));
            Assert.False(await rows.ReadAsync(ct));
        }
        await using (var delivery = Store.Sql(db, null, "select array_agg(kind order by sequence) from public.inbox_event where account_id=$1 and message_id=$2", user, replyId))
            Assert.Equal(new short[] { 12, 13 }, (short[])(await delivery.ExecuteScalarAsync(ct))!);
        Assert.Equal(26L, await FixtureSql.ScalarAsync(db, null, ct, "select read_through from public.inbox_conversation where id=26"));

        const string privateReason = " Awaiting private evidence 🐈 ";
        var statusPath = WireRoutes.AdminInboxStatus.Replace("{id:long}", "26", StringComparison.Ordinal);
        var statusPow = WireRoutes.AdminInboxStatusPow.Replace("{id:long}", "26", StringComparison.Ordinal);
        var accountPath = WireRoutes.InboxDetail.Replace("{id:long}", "26", StringComparison.Ordinal);
        string original = await Version();
        var pending = InboxWire.EncodeAdminStatus(1, privateReason);
        await Status(statusPow, HttpStatusCode.Unauthorized, siteToken, original, pending, nonce);
        await Status(statusPow, HttpStatusCode.BadRequest, adminToken, "0" + original, pending, nonce);
        await Status(statusPow, HttpStatusCode.BadRequest, adminToken, original, InboxWire.EncodeAdminStatus(1, "   "), nonce);
        await Status(statusPow, HttpStatusCode.BadRequest, adminToken, original, InboxWire.EncodeAdminStatus(1, new string('x', 257)), nonce);
        var statusProof = await StatusWork(original, pending);
        var staleClose = InboxWire.EncodeAdminStatus(2, "Old thread version");
        var staleProof = await StatusWork(original, staleClose, otherToken);
        await Status(statusPath, HttpStatusCode.Unauthorized, otherToken, original, pending, statusProof);
        await Status(statusPath.Replace("/26/", "/25/", StringComparison.Ordinal), HttpStatusCode.Unauthorized, adminToken, original, pending, statusProof);
        await Status(statusPath, HttpStatusCode.Unauthorized, adminToken, original == "1" ? "2" : "1", pending, statusProof);
        await Status(statusPath, HttpStatusCode.Unauthorized, adminToken, original, InboxWire.EncodeAdminStatus(1, "Changed reason"), statusProof);
        var queueWake = WireRoutes.AdminInboxQueueWake;
        using (var threadSocket = await Observe(WireRoutes.AdminInboxWake.Replace("{id:long}", "26", StringComparison.Ordinal)))
        using (var allSocket = await Observe(queueWake))
        using (var openSocket = await Observe(queueWake + "?status=open"))
        using (var pendingSocket = await Observe(queueWake + "?status=pending"))
        {
            await CheckStatus(original, pending, statusProof, 0, 1, false);
            await Task.WhenAll(Woke(threadSocket), Woke(allSocket), Woke(openSocket), Woke(pendingSocket));
            Assert.DoesNotContain(26L, Page(await Get(WireRoutes.AdminInboxQueue + "?status=open", HttpStatusCode.OK, otherToken)).Ids);
            Assert.Equal(new long[] { 26 }, Page(await Get(WireRoutes.AdminInboxQueue + "?status=pending", HttpStatusCode.OK, otherToken)).Ids);
            using var peerThread = Reader(await Get(thread, HttpStatusCode.OK, otherToken), FrameType.AdminInboxThread);
            Assert.Equal(26L, peerThread.ReadInt64());
            peerThread.ReadBytes(16);
            Text(peerThread);
            Assert.Equal(1, peerThread.ReadInt32());
        }
        await Status(statusPath, HttpStatusCode.Unauthorized, adminToken, original, pending, statusProof);
        await CheckStatus(original, pending, await StatusWork(original, pending), 1, 1, true);
        var afterPending = await Get(accountPath, HttpStatusCode.OK, siteToken, host: false, site: true);
        Assert.Equal(1, BinaryPrimitives.ReadInt32LittleEndian(Aeds.Decode(afterPending, FrameType.ConversationDetailV3)[8..]));
        Assert.DoesNotContain(privateReason.Trim(), Encoding.UTF8.GetString(afterPending));

        string pendingVersion = await Version();
        var reopen = InboxWire.EncodeAdminStatus(0, "Ready to review");
        const string goodCloseReason = "Case outcome was confirmed";
        var close = InboxWire.EncodeAdminStatus(2, goodCloseReason);
        await CheckStatus(pendingVersion, reopen, await StatusWork(pendingVersion, reopen), 1, 0, false);
        // This proof was issued before the state made the Open -> Pending -> Open cycle.
        await Status(statusPath, HttpStatusCode.Conflict, otherToken, original, staleClose, staleProof);
        await Status(statusPow, HttpStatusCode.Conflict, adminToken, original, staleClose, nonce);
        var restoredVersion = await Version();
        Assert.NotEqual(original, restoredVersion);
        await CheckStatus(restoredVersion, close, await StatusWork(restoredVersion, close), 0, 2, false);
        var closedVersion = await Version();
        await Status(statusPath, HttpStatusCode.Conflict, adminToken, closedVersion, pending, await StatusWork(closedVersion, pending));
        await CheckStatus(closedVersion, reopen, await StatusWork(closedVersion, reopen), 2, 0, false);

        await using (var audit = Store.Sql(db, null, """
            select principal_id,session_reference,previous_status,current_status,reason from public.inbox_admin_status order by id
            """))
        await using (var statuses = await audit.ExecuteReaderAsync(ct))
        {
            foreach (var (before, after, reason) in new[] { (0, 1, privateReason.Trim()), (1, 0, "Ready to review"),
                         (0, 2, goodCloseReason), (2, 0, "Ready to review") })
            {
                Assert.True(await statuses.ReadAsync(ct));
                Assert.Equal(admin, statuses.GetGuid(0));
                Assert.Equal(SHA256.HashData(Store.TokenDigest(adminToken)!), statuses.GetFieldValue<byte[]>(1));
                Assert.Equal(before, statuses.GetInt16(2));
                Assert.Equal(after, statuses.GetInt16(3));
                Assert.Equal(reason, statuses.GetString(4));
            }
            Assert.False(await statuses.ReadAsync(ct));
        }
        await using (var delivery = Store.Sql(db, null, """
            select array_agg(kind order by sequence) from public.inbox_event
            where account_id=$1 and conversation_id=26 and message_id=$2
            """, user, replyId))
            Assert.Equal(new short[] { 12, 13, 12, 12, 12, 12 }, (short[])(await delivery.ExecuteScalarAsync(ct))!);
        Assert.Equal(27L, await FixtureSql.ScalarAsync(db, null, ct, "select count(*) from public.inbox_message where conversation_id=26"));
        Assert.Equal(26L, await FixtureSql.ScalarAsync(db, null, ct, "select read_through from public.inbox_conversation where id=26"));
        await Sql("update public.admin_principal set generation=generation+1 where id=$1", admin);
        await Get(thread, HttpStatusCode.Unauthorized, adminToken);
        await Status(statusPow, HttpStatusCode.Unauthorized, adminToken, await Version(otherToken), close, nonce);

        async Task<ClientWebSocket> Observe(string path)
        {
            var socket = AdminWakeClient($"fsus-v2-admin-session={otherToken}", collect: false);
            var uri = WakeUri(server, path);
            try
            {
                await socket.ConnectAsync(uri, ct);
                return socket;
            }
            catch
            {
                socket.Dispose();
                throw;
            }
        }

        async Task Woke(ClientWebSocket socket)
        {
            using var bound = CancellationTokenSource.CreateLinkedTokenSource(ct);
            bound.CancelAfter(TimeSpan.FromSeconds(15));
            await ExpectWake(socket, bound.Token);
        }

        async Task<string> Version(string? token = null)
        {
            using var request = AdminRequest(HttpMethod.Get, thread, token ?? adminToken);
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return Assert.Single(response.Headers.GetValues(WireHeaders.AdminInboxVersion));
        }

        async Task CheckStatus(string version, byte[] data, string work, int before, int after, bool same)
        {
            var body = await Status(statusPath, HttpStatusCode.OK, adminToken, version, data, work);
            var result = Aeds.Decode(body, FrameType.ConversationStatusMutationResult).ToArray();
            Assert.Equal(before, BinaryPrimitives.ReadInt32LittleEndian(result));
            Assert.Equal(after, BinaryPrimitives.ReadInt32LittleEndian(result.AsSpan(4)));
            Assert.Equal(same ? 1 : 0, BinaryPrimitives.ReadInt32LittleEndian(result.AsSpan(8)));
        }

        async Task<string> StatusWork(string version, byte[] data, string? token = null) =>
            SolveChallenge(await Status(statusPow, HttpStatusCode.OK, token ?? adminToken, version, data, nonce), nonce);

        async Task<byte[]> Status(string route, HttpStatusCode expected, string token, string version, byte[] data, string value)
        {
            using var request = AdminRequest(HttpMethod.Post, route, token, data);
            request.Headers.Add(WireHeaders.AdminInboxVersion, version);
            request.Headers.Add(route.EndsWith("-pow.aeds", StringComparison.Ordinal) ? WireHeaders.PowClientNonce : WireHeaders.PowProof, value);
            return await ExpectBody(server, request, expected, ct);
        }

        async Task<string> Work() => SolveChallenge(await Post(challenge, HttpStatusCode.OK, adminToken, command, frame, nonce), nonce);

        async Task<byte[]> Post(string path, HttpStatusCode expected, string secret, string key, byte[] data, string? nonce = null,
            string? proof = null, string? origin = null)
        {
            using var request = AdminRequest(HttpMethod.Post, path, secret, data);
            request.Headers.Add(WireHeaders.ClientMutationId, key);
            if (origin is not null) request.Headers.Add("Origin", origin);
            if (nonce is not null) request.Headers.Add(WireHeaders.PowClientNonce, nonce);
            if (proof is not null) request.Headers.Add(WireHeaders.PowProof, proof);
            return await ExpectBody(server, request, expected, ct);
        }

        Task Sql(string sql, params object[] args) =>
            FixtureSql.ExecuteAsync(db, null, ct, sql, args);

        async Task<byte[]> Get(string path, HttpStatusCode expected, string secret, bool host = true, bool site = false)
        {
            using var request = AdminRequest(HttpMethod.Get, path, secret, adminHost: host, site: site);
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(expected, response.StatusCode);
            if (response.IsSuccessStatusCode) Assert.True(response.Headers.CacheControl?.NoStore);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }
    }
}
