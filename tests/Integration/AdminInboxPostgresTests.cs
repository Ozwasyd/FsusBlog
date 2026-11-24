using System.Net.WebSockets;

using static FsusBlog.V2.Integration.Tests.InboxFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminInboxPostgresTests
{
    [PostgresFact]
    public async Task CreationPositionDetectsAnOlderCommittedTicketWithoutAChangeToMaximumId()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        var (_, adminToken, _) = await fixture.AdminAsync("create-observer", 5, RandomNumberGenerator.GetBytes(8), [2], ct);
        var (firstAccount, firstToken, _) = await fixture.SignInSiteUser("first ticket account", ct, minutes: 5);
        var (_, secondToken, _) = await fixture.SignInSiteUser("second ticket account", ct, minutes: 5);

        var accountStore = new Store(fixture.DataSource);
        var adminStore = new AdminInboxStore(new AdminSessionGate(fixture.DataSource, null));
        Assert.Empty(await adminStore.InboxQueuePosition(adminToken, -1, false, ct));
        await BusinessAssert.Denied(Rejection.Unauthorized, () => adminStore.InboxQueuePosition(firstToken, -1, false, ct));

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
            lower = await await Task.WhenAny(allocated.Task, pending).WaitAsync(ct);
            higher = await accountStore.WithSession(secondToken, false, (connection, tx, actor) =>
                AddTicket(new InboxStore(connection, tx, actor.Id), "committed-first"), ct);
            Assert.True(lower < higher);
            Assert.Equal((Position([higher]), higher), (await adminStore.InboxQueuePosition(adminToken, -1, false, ct), await VisibleMaximum()));
        }
        finally { release.TrySetResult(); await pending; }

        Assert.Equal((Position([higher, lower]), higher), (await adminStore.InboxQueuePosition(adminToken, -1, false, ct), await VisibleMaximum()));

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
        await fixture.Exec("""
            insert into public.inbox_conversation(account_id,subject,status,is_system,last_message_at)
            values($1,'Conversation without messages',0,false,now())
            """, firstAccount);
        Assert.Equal(bounded, await adminStore.InboxQueuePosition(adminToken, -1, false, ct));

        async Task<long> AddTicket(InboxStore inbox, string key) =>
            (await inbox.CreateAsync(key, "Support case", "Account's initial support message", ct)).Message.ConversationId;
        static string Position(IEnumerable<long> ids) => string.Join(",", ids.Select(id => FormattableString.Invariant($"{id}:0:{id}:0")));
        Task<long> VisibleMaximum() => fixture.Scalar<long>("select max(id) from public.inbox_conversation where last_message_id is not null");
    }

    [PostgresFact]
    public async Task CurrentIndependentAdministratorCanPageReplyAndUpdateStatusWithPrivateAccountDelivery()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (admin, adminToken, _) = await fixture.AdminAsync("support-primary", 5, RandomNumberGenerator.GetBytes(8), [2], ct);
        var (_, otherToken, _) = await fixture.AdminAsync("support-another", 5, RandomNumberGenerator.GetBytes(8), [2], ct);
        var (user, siteToken, _) = await fixture.SignInSiteUser("support-site", ct, minutes: 5);
        await fixture.Exec("""
            insert into public.inbox_conversation(id,account_id,subject,status,is_system,last_message_at)
            select id,$1,'Support case '||id,case when id=1 then 2 else 0 end,false,now() from generate_series(1,26) id
            """, user);
        await fixture.Exec("""
            insert into public.inbox_message(conversation_id,id,sender,is_internal,body,sent_at)
            select id,id,0,false,'Customer started '||id,now() from generate_series(1,26) id;
            update public.inbox_conversation set last_message_id=id,read_through=id;
            insert into public.inbox_message(conversation_id,id,sender,is_internal,body,sent_at)
            select 26,id,1,id=100,case when id=100 then 'invisible internal text' else 'Response '||id end,now()
            from generate_series(100,124) id;
            update public.inbox_conversation set last_message_id=124 where id=26;
            select setval(pg_get_serial_sequence('public.inbox_message','id'),124);
            """);
        await using var server = await StartAdmin(fixture, ct,
            AdminInboxEndpoints.ReplySetting, AdminInboxEndpoints.StatusSetting, AdminInboxEndpoints.LiveSetting);
        await Get(WireRoutes.AdminInboxQueue, NotFound, adminToken, host: false);
        await Get(WireRoutes.AdminInboxQueue, Unauthorized, siteToken, site: true);
        await Get(WireRoutes.AdminInboxQueue, Unauthorized, siteToken);
        var first = Page(await Get(WireRoutes.AdminInboxQueue, OK, adminToken));
        Assert.Equal(Enumerable.Range(3, 24).Reverse().Select(i => (long)i), first.Ids);
        Assert.NotEmpty(first.Cursor);
        var next = $"{WireRoutes.AdminInboxQueue}?cursor={first.Cursor}";
        await Get(next, BadRequest, otherToken);
        await Get(next + "&status=open", BadRequest, adminToken);
        Assert.Equal(new long[] { 2, 1 }, Page(await Get(next, OK, adminToken)).Ids);
        Assert.Equal(new long[] { 1 }, Page(await Get(WireRoutes.AdminInboxQueue + "?status=closed", OK, adminToken)).Ids);
        var thread = Route(WireRoutes.AdminInboxThread);
        using var newest = Reader(await Get(thread, OK, adminToken), FrameType.AdminInboxThread);
        Assert.Equal(26L, ConversationId(newest));
        string older = Text(newest);
        Assert.NotEmpty(older);
        var latest = Messages(newest);
        Assert.Equal((24, 101L), (latest.Count, latest[0].Id));
        using var historical = Reader(await Get(thread + "?before=" + older, OK, adminToken), FrameType.AdminInboxThread);
        Assert.Equal((26L, ""), (ConversationId(historical), Text(historical)));
        var earliest = Messages(historical);
        Assert.Equal(new long[] { 26, 100 }, earliest.Select(message => message.Id));
        Assert.Equal((true, "invisible internal text"), (earliest[1].Internal, earliest[1].Body));
        await Get(Route(WireRoutes.AdminInboxThread, "25") + "?before=" + older, BadRequest, adminToken);
        var accountPath = Route(WireRoutes.InboxDetail);
        Assert.Equal(-1, (await Get(accountPath, OK, siteToken, host: false, site: true)).AsSpan().IndexOf("invisible internal text"u8));

        const string replyText = "Support member confirmed the account reply.";
        const string command = "support:01";
        const string nonce = "253ad5c923194c56b9d7e6622ffabeab";
        var frame = InboxWire.EncodeAdminReply(replyText);
        var path = Route(WireRoutes.AdminInboxReply);
        var challenge = Route(WireRoutes.AdminInboxReplyPow);
        await Post(path, Unauthorized, adminToken, command, frame);
        await Post(challenge, Unauthorized, siteToken, command, frame, nonce);
        await Post(Route(WireRoutes.AdminInboxReplyPow, "1"), Conflict, adminToken, command, frame, nonce);
        var proof = await Work();
        foreach (var (route, expected, secret, key, origin) in new[]
        {
            (path, Forbidden, adminToken, command, (string?)"http://127.0.0.1"),
            (Route(WireRoutes.AdminInboxReply, "25"), Unauthorized, adminToken, command, null),
            (path, Unauthorized, otherToken, command, null),
            (path, Unauthorized, adminToken, "support:other", null),
        })
            await Post(route, expected, secret, key, frame, proof: proof, origin: origin);
        var response = Aeds.Decode(await Post(path, OK, adminToken, command, frame, proof: proof), FrameType.ConversationMessage).ToArray();
        var replyId = BinaryPrimitives.ReadInt64LittleEndian(response);
        Assert.Equal(0, response[29]);
        await Post(path, Unauthorized, adminToken, command, frame, proof: proof);
        var retry = Aeds.Decode(await Post(path, OK, adminToken, command, frame, proof: await Work()), FrameType.ConversationMessage).ToArray();
        Assert.Equal((replyId, (byte)1), (BinaryPrimitives.ReadInt64LittleEndian(retry), retry[29]));
        var receipt = await Get(accountPath, OK, siteToken, host: false, site: true);
        Assert.True(receipt.AsSpan().IndexOf(Encoding.UTF8.GetBytes(replyText)) >= 0);
        Assert.Equal((25, 2), (BinaryPrimitives.ReadInt32LittleEndian(Aeds.Decode(receipt, FrameType.ConversationDetailV3)[12..]),
            BinaryPrimitives.ReadInt32LittleEndian(Aeds.Decode(await Get(WireRoutes.InboxReplay, OK, siteToken, host: false, site: true), FrameType.InboxReplay)[4..])));
        var adminDigestHash = SHA256.HashData(Store.TokenDigest(adminToken)!);
        var replyAudit = Assert.Single(await fixture.QueryRows(
            "select principal_id,session_reference,conversation_id,message_id from public.inbox_admin_reply",
            r => (r.GetGuid(0), r.GetFieldValue<byte[]>(1), r.GetInt64(2), r.GetInt64(3))));
        Assert.Equal((admin, 26L, replyId), (replyAudit.Item1, replyAudit.Item3, replyAudit.Item4));
        Assert.Equal(adminDigestHash, replyAudit.Item2);
        Assert.Equal(new short[] { 12, 13 }, await fixture.Scalar<short[]>(
            "select array_agg(kind order by sequence) from public.inbox_event where account_id=$1 and message_id=$2", user, replyId));
        Assert.Equal(26L, await fixture.Scalar<long>("select read_through from public.inbox_conversation where id=26"));

        const string privateReason = " Awaiting private evidence 🐈 ";
        var statusPath = Route(WireRoutes.AdminInboxStatus);
        var statusPow = Route(WireRoutes.AdminInboxStatusPow);
        string original = await Version();
        var pending = InboxWire.EncodeAdminStatus(1, privateReason);
        foreach (var (expected, tok, ver, data) in new[]
        {
            (Unauthorized, siteToken, original, pending),
            (BadRequest, adminToken, "0" + original, pending),
            (BadRequest, adminToken, original, InboxWire.EncodeAdminStatus(1, "   ")),
            (BadRequest, adminToken, original, InboxWire.EncodeAdminStatus(1, new string('x', 257))),
        })
            await Status(statusPow, expected, tok, ver, data, nonce);
        var statusProof = await StatusWork(original, pending);
        var staleClose = InboxWire.EncodeAdminStatus(2, "Old thread version");
        var staleProof = await StatusWork(original, staleClose, otherToken);
        foreach (var (route, tok, ver, data) in new[]
        {
            (statusPath, otherToken, original, pending),
            (Route(WireRoutes.AdminInboxStatus, "25"), adminToken, original, pending),
            (statusPath, adminToken, original == "1" ? "2" : "1", pending),
            (statusPath, adminToken, original, InboxWire.EncodeAdminStatus(1, "Changed reason")),
        })
            await Status(route, Unauthorized, tok, ver, data, statusProof);
        var queueWake = WireRoutes.AdminInboxQueueWake;
        using (var threadSocket = await Observe(Route(WireRoutes.AdminInboxWake)))
        using (var allSocket = await Observe(queueWake))
        using (var openSocket = await Observe(queueWake + "?status=open"))
        using (var pendingSocket = await Observe(queueWake + "?status=pending"))
        {
            await CheckStatus(original, pending, statusProof, 0, 1, false);
            await Task.WhenAll(Woke(threadSocket), Woke(allSocket), Woke(openSocket), Woke(pendingSocket));
            Assert.DoesNotContain(26L, Page(await Get(WireRoutes.AdminInboxQueue + "?status=open", OK, otherToken)).Ids);
            Assert.Equal(new long[] { 26 }, Page(await Get(WireRoutes.AdminInboxQueue + "?status=pending", OK, otherToken)).Ids);
            using var peerThread = Reader(await Get(thread, OK, otherToken), FrameType.AdminInboxThread);
            Assert.Equal(26L, peerThread.ReadInt64());
            peerThread.ReadBytes(16);
            Text(peerThread);
            Assert.Equal(1, peerThread.ReadInt32());
        }
        await Status(statusPath, Unauthorized, adminToken, original, pending, statusProof);
        await CheckStatus(original, pending, await StatusWork(original, pending), 1, 1, true);
        var afterPending = await Get(accountPath, OK, siteToken, host: false, site: true);
        Assert.Equal(1, BinaryPrimitives.ReadInt32LittleEndian(Aeds.Decode(afterPending, FrameType.ConversationDetailV3)[8..]));
        Assert.DoesNotContain(privateReason.Trim(), Encoding.UTF8.GetString(afterPending));

        string pendingVersion = await Version();
        var reopen = InboxWire.EncodeAdminStatus(0, "Ready to review");
        const string goodCloseReason = "Case outcome was confirmed";
        var close = InboxWire.EncodeAdminStatus(2, goodCloseReason);
        await CheckStatus(pendingVersion, reopen, await StatusWork(pendingVersion, reopen), 1, 0, false);
        // This proof was issued before the state made the Open -> Pending -> Open cycle.
        await Status(statusPath, Conflict, otherToken, original, staleClose, staleProof);
        await Status(statusPow, Conflict, adminToken, original, staleClose, nonce);
        var restoredVersion = await Version();
        Assert.NotEqual(original, restoredVersion);
        await CheckStatus(restoredVersion, close, await StatusWork(restoredVersion, close), 0, 2, false);
        var closedVersion = await Version();
        await Status(statusPath, Conflict, adminToken, closedVersion, pending, await StatusWork(closedVersion, pending));
        await CheckStatus(closedVersion, reopen, await StatusWork(closedVersion, reopen), 2, 0, false);

        var statusAudits = await fixture.QueryRows(
            "select principal_id,session_reference,previous_status,current_status,reason from public.inbox_admin_status order by id",
            r => (r.GetGuid(0), r.GetFieldValue<byte[]>(1), (int)r.GetInt16(2), (int)r.GetInt16(3), r.GetString(4)));
        var expectedAudits = new[] { (0, 1, privateReason.Trim()), (1, 0, "Ready to review"), (0, 2, goodCloseReason), (2, 0, "Ready to review") };
        Assert.Equal(expectedAudits.Length, statusAudits.Count);
        for (var i = 0; i < expectedAudits.Length; i++)
        {
            Assert.Equal((admin, expectedAudits[i].Item1, expectedAudits[i].Item2, expectedAudits[i].Item3),
                (statusAudits[i].Item1, statusAudits[i].Item3, statusAudits[i].Item4, statusAudits[i].Item5));
            Assert.Equal(adminDigestHash, statusAudits[i].Item2);
        }
        Assert.Equal(new short[] { 12, 13, 12, 12, 12, 12 }, await fixture.Scalar<short[]>("""
            select array_agg(kind order by sequence) from public.inbox_event
            where account_id=$1 and conversation_id=26 and message_id=$2
            """, user, replyId));
        Assert.Equal((27L, 26L), (await fixture.Scalar<long>("select count(*) from public.inbox_message where conversation_id=26"),
            await fixture.Scalar<long>("select read_through from public.inbox_conversation where id=26")));
        await fixture.Exec("update public.admin_principal set generation=generation+1 where id=$1", admin);
        await Get(thread, Unauthorized, adminToken);
        await Status(statusPow, Unauthorized, adminToken, await Version(otherToken), close, nonce);

        static string Route(string template, string id = "26") => template.Replace("{id:long}", id, StringComparison.Ordinal);

        async Task<ClientWebSocket> Observe(string wakePath)
        {
            var socket = AdminWakeClient($"fsus-v2-admin-session={otherToken}", collect: false);
            try { await socket.ConnectAsync(WakeUri(server, wakePath), ct); return socket; }
            catch { socket.Dispose(); throw; }
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
            using var response = Ok(await server.Client.SendAsync(request, ct));
            return Assert.Single(response.Headers.GetValues(WireHeaders.AdminInboxVersion));
        }

        async Task CheckStatus(string version, byte[] data, string work, int before, int after, bool same)
        {
            var result = Aeds.Decode(await Status(statusPath, OK, adminToken, version, data, work), FrameType.ConversationStatusMutationResult);
            Assert.Equal((before, after, same ? 1 : 0), (BinaryPrimitives.ReadInt32LittleEndian(result),
                BinaryPrimitives.ReadInt32LittleEndian(result[4..]), BinaryPrimitives.ReadInt32LittleEndian(result[8..])));
        }

        async Task<string> StatusWork(string version, byte[] data, string? token = null) =>
            PowFixture.SolveFrame(await Status(statusPow, OK, token ?? adminToken, version, data, nonce), nonce, ct);

        async Task<byte[]> Status(string route, HttpStatusCode expected, string token, string version, byte[] data, string value)
        {
            using var request = AdminRequest(HttpMethod.Post, route, token, data);
            request.Headers.Add(WireHeaders.AdminInboxVersion, version);
            request.Headers.Add(route.EndsWith("-pow.aeds", StringComparison.Ordinal) ? WireHeaders.PowClientNonce : WireHeaders.PowProof, value);
            return await ExpectBody(server, request, expected, ct);
        }

        async Task<string> Work() => PowFixture.SolveFrame(await Post(challenge, OK, adminToken, command, frame, nonce), nonce, ct);

        async Task<byte[]> Post(string route, HttpStatusCode expected, string secret, string key, byte[] data, string? clientNonce = null,
            string? proof = null, string? origin = null)
        {
            using var request = AdminRequest(HttpMethod.Post, route, secret, data);
            request.Headers.Add(WireHeaders.ClientMutationId, key);
            if (origin is not null) request.Headers.Add("Origin", origin);
            if (clientNonce is not null) request.Headers.Add(WireHeaders.PowClientNonce, clientNonce);
            if (proof is not null) request.Headers.Add(WireHeaders.PowProof, proof);
            return await ExpectBody(server, request, expected, ct);
        }

        async Task<byte[]> Get(string route, HttpStatusCode expected, string secret, bool host = true, bool site = false)
        {
            using var request = AdminRequest(HttpMethod.Get, route, secret, adminHost: host, site: site);
            using var response = Expect(expected, await server.Client.SendAsync(request, ct));
            if (response.IsSuccessStatusCode) Assert.True(response.Headers.CacheControl?.NoStore);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }
    }
}
