using System.Net.WebSockets;

using static FsusBlog.V2.Integration.Tests.InboxFixture;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminInboxNoticePostgresTests
{
    [PostgresFact]
    public async Task ExplicitActiveAccountReceivesOneAuditedNoticeAcrossProofAndResponseRetries()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct);
        var (primary, firstToken, _) = await database.AdminAsync("notice-admin", 5, RandomNumberGenerator.GetBytes(8), [2], ct);
        var (_, otherAdmin, _) = await database.AdminAsync("different-admin", 5, RandomNumberGenerator.GetBytes(8), [2], ct);
        var (recipient, recipientToken, _) = await database.SignInSiteUser("notice-account", ct, minutes: 5);
        var (stranger, strangerToken, _) = await database.SignInSiteUser("unrelated-account", ct, minutes: 5);
        var replacement = Secret();
        await using var server = await StartAdmin(database, ct,
            AdminInboxEndpoints.NoticeSetting, AdminInboxEndpoints.LiveSetting, AdminInboxEndpoints.SharedReadSetting);
        const long eventId = 9981221123;
        const string content = "An explicitly targeted system message 🐈";
        var notice = Wire.EncodeAdminInboxNotice(new(recipient, "", content));
        var otherNotice = Wire.EncodeAdminInboxNotice(new(stranger, "", content));
        var nonexistent = Wire.EncodeAdminInboxNotice(new(Guid.NewGuid(), "", content));
        await Send(WireRoutes.AdminInboxSendNoticePow, Unauthorized, recipientToken, notice);
        await Send(WireRoutes.AdminInboxSendNotice, Unauthorized, firstToken, notice);
        await Send(WireRoutes.AdminInboxSendNotice, NotFound, firstToken, notice, admin: false);
        var proof = await Work(firstToken, notice);
        foreach (var (tok, payload, sourceEvt) in new[]
        {
            (otherAdmin, notice, eventId),
            (firstToken, otherNotice, eventId),
            (firstToken, notice, eventId + 1),
        })
            await Send(WireRoutes.AdminInboxSendNotice, Unauthorized, tok, payload, proof, sourceEvt);
        var parallel = await Work(firstToken, notice);
        const string system = "?status=system&shared=1";
        await RejectWake("?status=system", $"fsus-v2-admin-session={otherAdmin}", BadRequest);
        await RejectWake(system, $"fsus-v2-session={strangerToken}", Unauthorized);
        using var observer = AdminWakeClient($"fsus-v2-admin-session={otherAdmin}");
        await observer.ConnectAsync(WakeUri(server, WireRoutes.AdminInboxQueueWake + system), ct);
        var receipts = await Task.WhenAll(
            Send(WireRoutes.AdminInboxSendNotice, OK, firstToken, notice, proof),
            Send(WireRoutes.AdminInboxSendNotice, OK, firstToken, notice, parallel));
        using (var bound = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            bound.CancelAfter(TimeSpan.FromSeconds(12));
            await ExpectWake(observer, bound.Token);
            await observer.CloseAsync(WebSocketCloseStatus.NormalClosure, null, bound.Token);
        }
        var responses = receipts.Select(data => Aeds.Decode(data, FrameType.ConversationDetailV2).ToArray()).ToArray();
        var id = BinaryPrimitives.ReadInt64LittleEndian(responses[0]);
        Assert.Equal(id, BinaryPrimitives.ReadInt64LittleEndian(responses[1]));
        Assert.Equal(new byte[] { 0, 1 }, responses.Select(data => data[34]).Order());
        Assert.All(responses, data =>
        {
            Assert.Equal((1, 1), ((int)data[32], BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(12))));
            Assert.Contains("系统消息", Encoding.UTF8.GetString(data));
        });
        await Send(WireRoutes.AdminInboxSendNotice, Unauthorized, firstToken, notice, proof);
        await Send(WireRoutes.AdminInboxSendNotice, Conflict, otherAdmin, notice, await Work(otherAdmin, notice));
        await database.Exec("update public.admin_session set digest=$1 where principal_id=$2", Store.TokenDigest(replacement)!, primary);
        foreach (var bad in new[] { Wire.EncodeAdminInboxNotice(new(recipient, "", "Replacement text")), otherNotice })
            await Send(WireRoutes.AdminInboxSendNotice, Conflict, replacement, bad, await Work(replacement, bad));

        var path = WireRoutes.InboxDetail.Replace("{id:long}", id.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);
        var account = Encoding.UTF8.GetString(await SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Get, path, null, recipientToken, null, OK, ct));
        Assert.Contains(content, account);
        Assert.DoesNotContain("notice-admin", account);
        await SiteAedsFixture.SendStatus(server.Client, HttpMethod.Get, path, null, strangerToken, null, NotFound, ct);
        Assert.Equal(2, BinaryPrimitives.ReadInt32LittleEndian(Aeds.Decode(
            await SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Get, WireRoutes.InboxReplay, null, recipientToken, null, OK, ct),
            FrameType.InboxReplay)[4..]));
        Assert.Equal(0, BinaryPrimitives.ReadInt32LittleEndian(Aeds.Decode(
            await SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Get, WireRoutes.InboxReplay, null, strangerToken, null, OK, ct),
            FrameType.InboxReplay)[4..]));
        await database.Exec("update public.blog_user set enabled=false where id=$1", recipient);
        Assert.Equal(1, Aeds.Decode(await Send(WireRoutes.AdminInboxSendNotice, OK, replacement, notice, await Work(replacement, notice)),
            FrameType.ConversationDetailV2)[34]);
        foreach (var (payload, evt) in new[] { (notice, eventId + 1), (nonexistent, eventId + 2) })
        {
            var err = await Send(WireRoutes.AdminInboxSendNotice, NotFound, replacement, payload, await Work(replacement, payload, evt), evt);
            Assert.Contains("Inbox account not found.", Encoding.UTF8.GetString(Aeds.Decode(err, FrameType.ApiError)));
        }
        var audit = Assert.Single(await database.QueryRows("""
            select r.source_event_id,r.account_id,r.principal_id,r.session_reference,m.sender,c.read_through,
                (select count(*) from public.inbox_command),c.id
            from public.inbox_admin_notice r join public.inbox_conversation c on c.id=r.conversation_id
            join public.inbox_message m on m.id=r.message_id
            """, r => (r.GetInt64(0), r.GetGuid(1), r.GetGuid(2), r.GetFieldValue<byte[]>(3), r.GetInt16(4), r.IsDBNull(5), r.GetInt64(6), r.GetInt64(7))));
        Assert.Equal((eventId, recipient, primary, (short)2, true, 0L, id),
            (audit.Item1, audit.Item2, audit.Item3, audit.Item5, audit.Item6, audit.Item7, audit.Item8));
        Assert.Equal(SHA256.HashData(Store.TokenDigest(firstToken)!), audit.Item4);

        async Task RejectWake(string query, string cookie, HttpStatusCode status)
        {
            using var socket = AdminWakeClient(cookie);
            await Assert.ThrowsAsync<WebSocketException>(() => socket.ConnectAsync(WakeUri(server, WireRoutes.AdminInboxQueueWake + query), ct));
            Assert.Equal(status, socket.HttpStatusCode);
        }

        async Task<string> Work(string cookie, byte[] frame, long sourceEvent = eventId)
        {
            const string nonce = "7ddb277082ed464a845d2be0e1abeaba";
            return PowFixture.SolveFrame(await Send(WireRoutes.AdminInboxSendNoticePow, OK, cookie, frame, nonce, sourceEvent), nonce, ct);
        }

        async Task<byte[]> Send(string route, HttpStatusCode status, string token, byte[] frame, string? value = null,
            long sourceEvent = eventId, bool admin = true)
        {
            using var request = AdminRequest(HttpMethod.Post, route, token, frame, adminHost: admin);
            request.Headers.Add(WireHeaders.SourceEventId, sourceEvent.ToString(CultureInfo.InvariantCulture));
            if (value is not null)
                request.Headers.Add(route == WireRoutes.AdminInboxSendNoticePow ? WireHeaders.PowClientNonce : WireHeaders.PowProof, value);
            return await ExpectBytes(status, server.Client.SendAsync(request, ct), ct);
        }
    }
}
